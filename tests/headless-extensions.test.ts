import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  defaultSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

const TSX = pathToFileURL(
  join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs'),
).href;
const CLI = join(process.cwd(), 'src', 'cli.ts');
const RUN_TOKEN = 'run-token-5c1e77';

type Listen = (handler: Parameters<typeof createServer>[1]) => Promise<string>;
function listener(t: Parameters<typeof scratch>[0]): Listen {
  return async (handler) => {
    const server = createServer(handler);
    await new Promise<void>((ready) =>
      server.listen(0, '127.0.0.1', () => ready()),
    );
    cleanup(t, async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  };
}

// A model that calls the server's docs.list tool once, then answers with what it got.
async function model(listen: Listen, requests: string[][]): Promise<string> {
  return listen(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'scripted' }] }));
      return;
    }
    const body = JSON.parse(text);
    requests.push(
      (body.tools ?? []).map(
        (tool: { function: { name: string } }) => tool.function.name,
      ),
    );
    const offered = requests.at(-1)!.includes('srv_docs_list');
    const answered = (body.messages ?? []).some(
      (message: { role: string }) => message.role === 'tool',
    );
    const delta =
      !answered && offered
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'srv_docs_list',
                  arguments: JSON.stringify({ folder: 'manuals' }),
                },
              },
            ],
          }
        : { content: offered ? 'listed the manuals' : 'no server tools' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta,
              finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
}
// A circle-server with one read tool, answering only the run token.
async function server(listen: Listen, seen: string[]): Promise<string> {
  return listen(async (request, response) => {
    for await (const _ of request);
    seen.push(
      `${request.method} ${request.url} ${request.headers.authorization}`,
    );
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${RUN_TOKEN}`)
      return send(401, {
        status: 'failed',
        error: { code: 'UNAUTHENTICATED' },
      });
    if (request.url === '/v1/tools')
      return send(200, {
        data: [
          {
            name: 'docs.list',
            description: 'Documents in a folder.',
            inputSchema: {
              type: 'object',
              properties: { folder: { type: 'string' } },
            },
            effect: 'read',
            mode: 'sync',
          },
        ],
      });
    if (request.url === '/v1/tools/docs.list/call')
      return send(200, {
        data: { result: { entries: ['manual-cli.md'] }, evidence: [] },
      });
    if (request.url === '/v1/tasks?limit=20' || request.url === '/v1/packs')
      return send(200, { data: [] });
    send(404, { status: 'failed', error: { code: 'TARGET_NOT_FOUND' } });
  });
}

function run(
  home: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], {
      env: {
        ...process.env,
        CIRCLE_HOME: home,
        CIRCLE_NO_MODELS_REFRESH: '1',
        CIRCLE_JOB_WAIT: '0',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.once('error', reject);
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

test('with --extensions a headless run loads the circle-server extension, which takes its address and token from the environment and offers the server tools from the first turn', async (t) => {
  const listen = listener(t);
  const requests: string[][] = [];
  const seen: string[] = [];
  const modelUrl = await model(listen, requests);
  const serverUrl = await server(listen, seen);
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  let settings = trustFolder(defaultSettings(), workspace);
  settings.initialized = true;
  settings.auth.base_url = modelUrl + '/v1';
  settings.auth.model = 'scripted';
  settings.extensions = { 'circle-server': { enabled: true } };
  saveSettings(settings, home);
  saveCredentials({ api_key: 'model-key' }, home);
  const env = { CIRCLE_SERVER_URL: serverUrl, CIRCLE_SERVER_TOKEN: RUN_TOKEN };

  const plain = await run(
    home,
    ['--mode', 'json', 'list the manuals', workspace],
    env,
  );
  assert.equal(plain.code, 0, plain.stderr);
  assert.ok(
    !requests[0]!.includes('srv_docs_list'),
    'without --extensions no extension loads',
  );
  assert.equal(seen.length, 0);

  requests.length = 0;
  const loaded = await run(
    home,
    ['--mode', 'json', '--extensions', 'list the manuals', workspace],
    env,
  );
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.ok(
    requests[0]!.includes('srv_docs_list'),
    'offered from the first turn',
  );
  const events = loaded.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const result = events.find(
    (event) => event.type === 'tool_result' && event.name === 'srv_docs_list',
  );
  assert.ok(result, loaded.stdout);
  assert.match(JSON.stringify(result), /manual-cli\.md/);
  assert.equal(
    events.find((event) => event.type === 'turn_end')?.answer,
    'listed the manuals',
  );
  assert.ok(seen.every((line) => line.endsWith(`Bearer ${RUN_TOKEN}`)));
  assert.ok(
    seen.some((line) => line.startsWith('POST /v1/tools/docs.list/call')),
  );
  // Nothing about the run's server is written to the Circle home.
  assert.ok(
    !existsSync(join(home, 'extension_secrets', 'circle-server.secrets.json')),
  );
  assert.ok(
    !existsSync(join(home, 'extension_data', 'circle-server', 'config.json')),
  );
  mkdirSync(join(home, 'unused'), { recursive: true });
});
