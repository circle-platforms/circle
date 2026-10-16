import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CheckpointStore } from '../src/checkpoint_store.js';
import {
  defaultSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';
import { TITLE_MAX_TOKENS } from '../src/session_title.js';

const CLI = join(process.cwd(), 'src', 'cli.ts');
const TSX = pathToFileURL(
  join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs'),
).href;

async function fixture(
  t: Parameters<typeof scratch>[0],
  answer: (response: ServerResponse) => void,
) {
  const home = scratch(t);
  const workspace = scratch(t);
  const requests: Record<string, any>[] = [];
  const titles: Record<string, any>[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    assert.equal(request.url, '/v1/chat/completions');
    const body = JSON.parse(text);
    // The session title is a side request after the turn, not a replay of it.
    if (body.max_tokens === TITLE_MAX_TOKENS) {
      titles.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Completion check' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    requests.push(body);
    answer(response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanup(
    t,
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let settings = defaultSettings();
  settings.initialized = true;
  settings.auth = {
    ...settings.auth,
    protocol: 'openai',
    model: 'synthetic-completion-cli',
    base_url: `http://127.0.0.1:${address.port}/v1`,
  };
  settings = trustFolder(settings, workspace);
  saveSettings(settings, home);
  saveCredentials({ api_key: 'synthetic-test-key' }, home);
  return { home, workspace, requests, titles };
}

function stream(
  response: ServerResponse,
  delta: Record<string, unknown>,
  finish: string,
) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    'data: ' +
      JSON.stringify({
        model: 'synthetic-served',
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      '\n\n',
  );
  response.write(
    'data: ' +
      JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 11,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      }) +
      '\n\n',
  );
  response.end('data: [DONE]\n\n');
}

async function circle(home: string, workspace: string, extra: string[] = []) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done, reject) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !/^(?:https?_proxy|no_proxy|NODE_USE_ENV_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|CIRCLE_TRUST_CERTS)$/i.test(
              name,
            ),
        ),
      );
      const child = spawn(
        process.execPath,
        [
          '--import',
          TSX,
          CLI,
          '-p',
          'synthetic completion test',
          workspace,
          '--session-id',
          'completion-cli',
          '--mode',
          'json',
          '--verbose',
          '--no-context-files',
          '--tools',
          'write_file',
          ...extra,
        ],
        {
          env: {
            ...env,
            CIRCLE_HOME: home,
            CIRCLE_NO_MODELS_REFRESH: '1',
            CIRCLE_JOB_WAIT: '0',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => (stdout += data));
      child.stderr.on('data', (data) => (stderr += data));
      child.once('error', reject);
      const timer = setTimeout(() => child.kill(), 30_000);
      child.once('close', (code) => {
        clearTimeout(timer);
        done({ code, stdout, stderr });
      });
      child.stdin.end();
    },
  );
}

for (const auto of [false, true]) {
  test(`actual headless CLI blocks parseable truncated writes in ${auto ? 'auto' : 'supervised'} mode and saves failure evidence once`, async (t) => {
    const { home, workspace, requests } = await fixture(t, (response) =>
      stream(
        response,
        {
          content: 'partial response before truncated tool',
          tool_calls: [
            {
              index: 0,
              id: 'truncated-write',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  file_path: 'must-not-exist.txt',
                  content: 'forbidden side effect',
                }),
              },
            },
          ],
        },
        'length',
      ),
    );
    const result = await circle(home, workspace, auto ? ['--yolo'] : []);
    assert.equal(result.code, 1, result.stderr);
    assert.match(
      result.stderr,
      /model output limit reached; response incomplete/,
    );
    assert.doesNotMatch(result.stderr, /--yolo/);
    assert.equal(requests.length, 1);
    assert.ok(
      requests[0]!.tools.some(
        (tool: any) => tool.function.name === 'write_file',
      ),
    );
    assert.equal(existsSync(join(workspace, 'must-not-exist.txt')), false);
    const rows = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => row.type === 'assistant').length, 1);
    assert.equal(
      rows.filter(
        (row) =>
          row.type === 'error' && row.completion_failure === 'output_limit',
      ).length,
      1,
    );
    const store = new CheckpointStore(home);
    cleanup(t, () => store.close());
    const messages = store.messages('completion-cli');
    const assistant = messages.filter(
      (message) => message.role === 'assistant',
    );
    assert.equal(assistant.length, 1);
    assert.equal(
      assistant[0]!.content,
      'partial response before truncated tool',
    );
    assert.deepEqual(assistant[0]!.completion, {
      reason: 'length',
      provider_reason: 'length',
    });
    assert.equal(assistant[0]!.truncated, true);
    assert.deepEqual(assistant[0]!.usage, {
      input_tokens: 7,
      output_tokens: 11,
      cache_read_tokens: 2,
    });
    const toolResults = messages.filter((message) => message.role === 'tool');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0]!.tool_call_id, 'truncated-write');
    assert.equal(toolResults[0]!.status, 'error');
    assert.equal(
      toolResults[0]!.content,
      'not run: model output limit reached; response incomplete',
    );
  });
}

test('actual headless CLI rejects a normally ended thinking-only response without replay', async (t) => {
  const { home, workspace, requests } = await fixture(t, (response) =>
    stream(response, { reasoning_content: 'synthetic summary only' }, 'stop'),
  );
  const result = await circle(home, workspace);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /model returned an empty response/);
  assert.doesNotMatch(result.stderr, /--yolo/);
  assert.equal(requests.length, 1);
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const assistant = store
    .messages('completion-cli')
    .filter((message) => message.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0]!.content, '');
  assert.equal(assistant[0]!.thinking, 'synthetic summary only');
  assert.deepEqual(assistant[0]!.completion, {
    reason: 'stop',
    provider_reason: 'stop',
  });
  assert.equal(assistant[0]!.usage?.output_tokens, 11);
});
