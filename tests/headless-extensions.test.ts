import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  defaultSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';
import { mcpStub, type McpStub } from './mcp-stub.js';

const TSX = pathToFileURL(
  join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs'),
).href;
const CLI = join(process.cwd(), 'src', 'cli.ts');
const RUN_TOKEN = 'run-token-5c1e77';
// The MCP server's tool as the model is offered it, and the extension's own tool.
const SERVER_TOOL = 'files-server_list_docs';
const EXTENSION_TOOL = 'notes_count';

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

// A model that calls the server's tool, then the extension's, then answers. It
// records the tools each request offers.
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
    const tools: string[] = (body.tools ?? []).map(
      (tool: { function: { name: string } }) => tool.function.name,
    );
    requests.push(tools);
    const results = (body.messages ?? []).filter(
      (message: { role: string }) => message.role === 'tool',
    ).length;
    const call = (id: string, name: string, args: Record<string, unknown>) => ({
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    const offered =
      tools.includes(SERVER_TOOL) && tools.includes(EXTENSION_TOOL);
    const delta = !offered
      ? { content: 'no integration tools' }
      : results === 0
        ? call('call-1', SERVER_TOOL, { folder: 'manuals' })
        : results === 1
          ? call('call-2', EXTENSION_TOOL, {})
          : { content: 'listed the manuals and counted the notes' };
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

// An MCP server with one read-only tool that answers only the run's token.
function server(t: Parameters<typeof scratch>[0]): Promise<McpStub> {
  return mcpStub(t, {
    name: 'files-server',
    tools: [
      {
        name: 'list_docs',
        description: 'Documents in a folder.',
        inputSchema: {
          type: 'object',
          properties: { folder: { type: 'string' } },
        },
        annotations: { readOnlyHint: true },
      },
    ],
    call: (request) => ({
      content: [
        {
          type: 'text',
          text:
            request.message?.params?.arguments?.folder === 'manuals'
              ? 'manual-cli.md'
              : 'no such folder',
        },
      ],
    }),
    refuse: (request) =>
      request.headers.authorization === `Bearer ${RUN_TOKEN}`
        ? undefined
        : { status: 401, body: 'unauthorized' },
  });
}

interface Fixture {
  home: string;
  workspace: string;
  env: Record<string, string>;
  requests: string[][];
  stub: McpStub;
}
async function fixture(t: Parameters<typeof scratch>[0]): Promise<Fixture> {
  const listen = listener(t);
  const requests: string[][] = [];
  const modelUrl = await model(listen, requests);
  const stub = await server(t);
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const settings = trustFolder(defaultSettings(), workspace);
  settings.initialized = true;
  settings.auth.base_url = modelUrl + '/v1';
  settings.auth.model = 'scripted';
  // The token comes from the environment of the run, as a program that starts
  // Circle for a server hands it over; settings.json names only the variable.
  settings.mcp_servers = [
    {
      name: 'files-server',
      transport: 'streamable_http',
      url: stub.url,
      headers: { Authorization: 'Bearer ${env:FILES_SERVER_TOKEN}' },
    },
  ];
  saveSettings(settings, home);
  saveCredentials({ api_key: 'model-key' }, home);
  // An extension of your own, which loads unless it is turned off.
  const extension = join(home, 'extensions', 'notes');
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, 'extension.mjs'),
    `export function register(api){api.registerTool(${JSON.stringify(EXTENSION_TOOL)},'How many notes the project keeps.',{type:'object',properties:{}},()=>'3 notes',{readOnly:true})}`,
  );
  // The machine's home is a scratch folder too, so no user folder of the
  // person running the tests is read.
  const machineHome = scratch(t);
  const env = {
    HOME: machineHome,
    USERPROFILE: machineHome,
    FILES_SERVER_TOKEN: RUN_TOKEN,
  };
  return { home, workspace, env, requests, stub };
}

function spawnCli(home: string, args: string[], env: Record<string, string>) {
  return spawn(process.execPath, ['--import', TSX, CLI, ...args], {
    env: {
      ...process.env,
      CIRCLE_HOME: home,
      CIRCLE_NO_MODELS_REFRESH: '1',
      CIRCLE_JOB_WAIT: '0',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function run(
  home: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawnCli(home, args, env);
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

// One prompt over RPC; the input closes once the work it started has settled.
function rpc(
  home: string,
  workspace: string,
  env: Record<string, string>,
  message: string,
): Promise<{
  code: number | null;
  events: Record<string, any>[];
  stderr: string;
}> {
  return new Promise((done, reject) => {
    const child = spawnCli(
      home,
      ['--mode', 'rpc', '--extensions', workspace],
      env,
    );
    const events: Record<string, any>[] = [];
    let buffer = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const event = JSON.parse(line) as Record<string, any>;
        events.push(event);
        if (event.type === 'agent_settled') child.stdin.end();
      }
    });
    child.stderr.on('data', (data) => (stderr += data));
    child.once('error', reject);
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ code, events, stderr });
    });
    child.stdin.write(JSON.stringify({ id: '1', type: 'prompt', message }));
    child.stdin.write('\n');
  });
}

// Both tools ran, with what each returned, and the server got the run's token.
function ranBoth(f: Fixture, events: Record<string, any>[], output: string) {
  const result = (name: string) =>
    events.find((event) => event.type === 'tool_result' && event.name === name);
  assert.match(JSON.stringify(result(SERVER_TOOL)), /manual-cli\.md/, output);
  assert.match(JSON.stringify(result(EXTENSION_TOOL)), /3 notes/, output);
  assert.equal(
    events.find((event) => event.type === 'turn_end')?.answer,
    'listed the manuals and counted the notes',
  );
  assert.ok(f.stub.requests.length > 0);
  assert.ok(
    f.stub.requests.every(
      (request) => request.headers.authorization === `Bearer ${RUN_TOKEN}`,
    ),
  );
  assert.deepEqual(
    f.stub.calls().map((call) => call.message?.params),
    [{ name: 'list_docs', arguments: { folder: 'manuals' } }],
  );
}

// The token reached the server from the environment; no file in the Circle home has it.
function homeKeepsNoToken(home: string) {
  const files = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(folder, entry.name))
        : entry.isFile()
          ? [join(folder, entry.name)]
          : [],
    );
  const holding = files(home).filter((path) =>
    readFileSync(path).includes(RUN_TOKEN),
  );
  assert.deepEqual(holding, []);
}

test('with --extensions a headless run connects the MCP servers and loads the extensions before the first turn; without it neither loads', async (t) => {
  const f = await fixture(t);

  const plain = await run(
    f.home,
    ['--mode', 'json', 'list the manuals', f.workspace],
    f.env,
  );
  assert.equal(plain.code, 0, plain.stderr);
  assert.ok(f.requests.length > 0);
  assert.ok(
    f.requests.every(
      (tools) =>
        !tools.includes(SERVER_TOOL) && !tools.includes(EXTENSION_TOOL),
    ),
    'without --extensions no MCP server or extension loads',
  );
  assert.equal(f.stub.requests.length, 0, 'the server is never contacted');

  f.requests.length = 0;
  const loaded = await run(
    f.home,
    ['--mode', 'json', '--extensions', 'list the manuals', f.workspace],
    f.env,
  );
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.ok(
    f.requests[0]!.includes(SERVER_TOOL),
    'offered from the first turn',
  );
  assert.ok(
    f.requests[0]!.includes(EXTENSION_TOOL),
    'offered from the first turn',
  );
  const events = loaded.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, any>);
  ranBoth(f, events, loaded.stdout);
  homeKeepsNoToken(f.home);
});

test('in RPC mode --extensions connects the MCP servers and loads the extensions before the first command', async (t) => {
  const f = await fixture(t);
  const session = await rpc(f.home, f.workspace, f.env, 'list the manuals');
  assert.equal(session.code, 0, session.stderr);
  const output = session.events
    .map((event) => JSON.stringify(event))
    .join('\n');
  assert.equal(
    session.events.find(
      (event) => event.type === 'response' && event.command === 'prompt',
    )?.success,
    true,
    output,
  );
  assert.ok(
    f.requests[0]!.includes(SERVER_TOOL),
    'offered from the first turn',
  );
  assert.ok(
    f.requests[0]!.includes(EXTENSION_TOOL),
    'offered from the first turn',
  );
  ranBoth(f, session.events, output);
  homeKeepsNoToken(f.home);
});
