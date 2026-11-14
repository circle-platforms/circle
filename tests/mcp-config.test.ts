import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import {
  convertOldMcpServers,
  expandReferences,
  environmentThenSecrets,
  mcpServersForRun,
} from '../src/mcp_config.js';
import { McpManager } from '../src/mcp_loader.js';
import {
  defaultSettings,
  loadSettings,
  migrateMcpSettings,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { saveSecret } from '../src/secrets.js';
import { cleanup, scratch, until } from './helpers.js';
import { mcpStub } from './mcp-stub.js';

const FIXTURE = resolve('tests/fixtures/mcp-server.ts');
const echo = [
  { name: 'echo', inputSchema: { type: 'object', properties: {} } },
];

function folders(t: TestContext) {
  const root = realpathSync.native(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  return { root, home, workspace };
}

test('an mcp_servers list moves into mcpServers once, the file as it was kept beside, and is not read again', async (t) => {
  const { home, workspace } = folders(t);
  const stub = await mcpStub(t, { tools: echo });
  const old = {
    initialized: true,
    trusted_folders: [workspace],
    mcp_servers: [
      {
        id: 'docs-id',
        name: 'docs',
        url: stub.url,
        transport: 'streamable_http',
        headers: { Authorization: 'Bearer ${secret:DOCS_TOKEN}' },
        placeholders: { url: 'DOCS_URL' },
      },
      { id: 'by-id', command: 'node', args: '--version', env: { A: 1 } },
      { name: 'events', url: 'http://127.0.0.1:1/sse' },
      { name: 'socket', url: 'ws://127.0.0.1:1', transport: 'websocket' },
      { name: 'nothing' },
    ],
  };
  const path = join(home, 'settings.json');
  const before = JSON.stringify(old, null, 2);
  writeFileSync(path, before);
  saveSecret(home, 'DOCS_TOKEN', 'docs-token-1f9a');
  // Read before the file moves, the list is already read as the current format
  assert.deepEqual(Object.keys(loadSettings(home).mcpServers).sort(), [
    'by-id',
    'docs',
    'events',
    'socket',
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: loadSettings(home),
    model: new ScriptedModel([]),
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.mcp_servers, undefined);
  assert.deepEqual(saved.mcpServers, {
    docs: {
      type: 'http',
      url: stub.url,
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
      placeholders: { url: 'DOCS_URL' },
    },
    'by-id': {
      type: 'stdio',
      command: 'node',
      args: ['--version'],
      env: { A: '1' },
    },
    // A url without a transport was reached over SSE, and still is
    events: { type: 'sse', url: 'http://127.0.0.1:1/sse' },
    socket: { type: 'ws', url: 'ws://127.0.0.1:1' },
  });
  assert.equal(
    readFileSync(join(home, 'settings.json.mcp_servers.migrated'), 'utf8'),
    before,
  );
  // The same server connects with the same tools, its token from the saved secret
  assert.ok(runtime.mcp.tools.some((tool) => tool.name === 'docs_echo'));
  assert.equal(
    stub.requests[0]!.headers.authorization,
    'Bearer docs-token-1f9a',
  );
  assert.match(runtime.mcp.describe(), /moved: your MCP servers were moved/);
  assert.match(
    runtime.mcp.describe(),
    /nothing has neither a command nor a url/,
  );
  // Done once: a later start finds nothing to move, and the copy stays as it was
  assert.deepEqual(migrateMcpSettings(home), []);
  assert.ok(!existsSync(join(home, 'settings.json.mcp_servers.migrated.2')));
});

test('a save of settings in the old format moves the list first, so it is never written back beside its entries', (t) => {
  const { home } = folders(t);
  const path = join(home, 'settings.json');
  writeFileSync(
    path,
    JSON.stringify({ mcp_servers: [{ name: 'a', command: 'x' }] }),
  );
  const settings = loadSettings(home);
  settings.theme = 'dark';
  saveSettings(settings, home);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.mcp_servers, undefined);
  assert.deepEqual(saved.mcpServers, { a: { type: 'stdio', command: 'x' } });
  assert.equal(saved.theme, 'dark');
  assert.ok(existsSync(join(home, 'settings.json.mcp_servers.migrated')));
});

test('converting the old list keeps the later of two servers of one name and the fields only Circle has', () => {
  const { servers, notes } = convertOldMcpServers([
    { name: 'twin', command: 'first' },
    {
      name: 'twin',
      command: 'second',
      enabled: false,
      max_file_bytes: 16,
      trust_annotations: false,
    },
    {
      name: 'h',
      url: 'https://x.test',
      transport: 'sse',
      headers: { A: '${env:X}' },
    },
  ]);
  assert.deepEqual(servers, {
    twin: {
      type: 'stdio',
      command: 'second',
      enabled: false,
      max_file_bytes: 16,
      trust_annotations: false,
    },
    h: { type: 'sse', url: 'https://x.test', headers: { A: '${X}' } },
  });
  assert.match(notes.join('\n'), /two servers were named twin/);
});

test('references fill in from the environment, then saved secrets, then the default; an empty variable is set', () => {
  const lookup = environmentThenSecrets(
    { HOST: 'env-host', EMPTY: '' },
    { HOST: 'secret-host', TOKEN: 'secret-token' },
  );
  const filled = expandReferences(
    '${HOST}/${TOKEN}/${PORT:-8080}/${EMPTY:-x}/${GONE}',
    lookup,
  );
  assert.equal(filled.text, 'env-host/secret-token/8080//${GONE}');
  assert.deepEqual(filled.missing, ['GONE']);
  assert.deepEqual(
    filled.used.map((item) => [item.name, item.from]),
    [
      ['HOST', 'env'],
      ['TOKEN', 'secret'],
      ['EMPTY', 'env'],
    ],
  );
});

test('a program server gets its command, args and env filled in and the project folder as CIRCLE_PROJECT_DIR', async (t) => {
  const { home, workspace } = folders(t);
  process.env.CIRCLE_TEST_MCP_FIXTURE = FIXTURE;
  cleanup(t, () => {
    delete process.env.CIRCLE_TEST_MCP_FIXTURE;
  });
  const manager = new McpManager(workspace, 30_000, undefined, {
    secrets: () => ({ SUPPLIED_SECRET: 'from-secrets' }),
  });
  cleanup(t, () => manager.close());
  await manager.load({
    fixture: {
      command: process.execPath,
      args: [
        '${CIRCLE_TEST_MCP_FIXTURE}',
        '--mode=${MODE:-plain}',
        '${UNSET_ARG}',
      ],
      env: { TEST_SUPPLIED: '${SUPPLIED_SECRET}' },
    },
  });
  assert.equal(manager.status[0]?.error, '', manager.describe());
  const output = JSON.parse(
    await manager.tools
      .find((tool) => tool.name === 'fixture_environment')!
      .run({}, { signal: new AbortController().signal, sessionId: 'one' }),
  );
  // The server had the secret's value; what it says back names the secret
  assert.equal(output.supplied, '%SUPPLIED_SECRET%');
  assert.equal(output.project, workspace);
  assert.deepEqual(output.args, ['--mode=plain', '${UNSET_ARG}']);
  assert.match(
    manager.describe(),
    /warning: args\[2\] names \$\{UNSET_ARG\}, which is not set/,
  );
  void home;
});

test('a server in settings for one project, in .mcp.json and in your settings: the local entry over the project over yours', (t) => {
  const { home, workspace } = folders(t);
  writeFileSync(
    join(workspace, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        shared: { type: 'http', url: 'https://project.test/mcp' },
        mine: { type: 'http', url: 'https://project-mine.test/mcp' },
      },
    }),
  );
  const settings = trustFolder(defaultSettings(), workspace) as Record<
    string,
    unknown
  >;
  settings.mcpServers = {
    mine: { type: 'http', url: 'https://user.test/mcp' },
    shared: { type: 'http', url: 'https://user-shared.test/mcp' },
  };
  settings.projects = {
    [workspace]: {
      mcpServers: { mine: { type: 'http', url: 'https://local.test/mcp' } },
      enabledMcpjsonServers: ['shared', 'mine'],
    },
  };
  const found = mcpServersForRun({
    home,
    workspace,
    settings,
    trusted: true,
    interactive: true,
  });
  assert.deepEqual(
    found.entries.map((entry) => [entry.name, entry.scope, entry.config.url]),
    [
      ['mine', 'local', 'https://local.test/mcp'],
      ['shared', 'project', 'https://project.test/mcp'],
    ],
  );
  // An untrusted folder's .mcp.json is not read at all
  const untrusted = mcpServersForRun({
    home,
    workspace,
    settings,
    trusted: false,
    interactive: true,
  });
  assert.deepEqual(
    untrusted.entries.map((entry) => [entry.name, entry.scope]),
    [
      ['mine', 'local'],
      ['shared', 'user'],
    ],
  );
});

test(".mcp.json servers wait for the person's approval in a session that can ask, and the answer is kept for the project", async (t) => {
  const { home, workspace } = folders(t);
  const one = await mcpStub(t, { tools: echo });
  const two = await mcpStub(t, { tools: echo });
  writeFileSync(
    join(workspace, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        approved: { type: 'http', url: one.url },
        refused: { type: 'http', url: two.url },
      },
    }),
  );
  const settings = trustFolder(defaultSettings(), workspace);
  saveSettings(settings, home);
  const asked: Record<string, unknown>[] = [];
  let answer!: (reply: string) => void;
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model: new ScriptedModel([]),
    question: (args) => {
      asked.push(args);
      return new Promise((resolve) => (answer = resolve));
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  // Nothing is reached before the person answers
  assert.equal(one.requests.length + two.requests.length, 0);
  assert.match(
    runtime.mcp.describe(),
    /approved \(\.mcp\.json\)[\s\S]*waits for your approval/,
  );
  await until(() => asked.length === 1);
  const question = (asked[0]!.questions as Record<string, unknown>[])[0]!;
  assert.match(String(question.question), /approved: .*\/mcp/);
  assert.equal(question.multiple, true);
  answer(JSON.stringify([['approved']]));
  await until(() =>
    runtime.harness.tools.some((tool) => tool.name === 'approved_echo'),
  );
  assert.equal(two.requests.length, 0);
  assert.match(
    runtime.mcp.describe(),
    /refused \(\.mcp\.json\)[\s\S]*declined for this project/,
  );
  const project = loadSettings(home).projects[workspace]!;
  assert.deepEqual(project.enabledMcpjsonServers, ['approved']);
  assert.deepEqual(project.disabledMcpjsonServers, ['refused']);
  // A new session in the project asks nothing again
  const again = new AgentRuntime({
    home,
    workspace,
    settings: loadSettings(home),
    model: new ScriptedModel([]),
    question: () => {
      throw new Error('asked again');
    },
  });
  cleanup(t, () => again.close());
  await again.initialize();
  assert.ok(again.mcp.tools.some((tool) => tool.name === 'approved_echo'));
  assert.ok(!again.mcp.tools.some((tool) => tool.name === 'refused_echo'));
});

test('a run that cannot ask connects the .mcp.json servers not declined', async (t) => {
  const { home, workspace } = folders(t);
  const stub = await mcpStub(t, { tools: echo });
  writeFileSync(
    join(workspace, '.mcp.json'),
    JSON.stringify({ mcpServers: { shared: { type: 'http', url: stub.url } } }),
  );
  const settings = trustFolder(defaultSettings(), workspace);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model: new ScriptedModel([]),
    headless: true,
    integrations: true,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  assert.ok(runtime.mcp.tools.some((tool) => tool.name === 'shared_echo'));
});

test('a headersHelper runs at connect in the folder it belongs to, and its headers go over the entry’s own', async (t) => {
  const { home, workspace } = folders(t);
  const stub = await mcpStub(t, { tools: echo });
  const helper = join(workspace, 'headers.js');
  writeFileSync(
    helper,
    `process.stdout.write(JSON.stringify({ Authorization: 'Bearer helper-' + process.env.CIRCLE_MCP_SERVER_NAME, 'X-Cwd': process.cwd(), 'X-Url': process.env.CIRCLE_MCP_SERVER_URL, 'X-Secret': String(process.env.CIRCLE_TEST_HELPER_TOKEN) }))`,
  );
  process.env.CIRCLE_TEST_HELPER_TOKEN = 'ambient-secret';
  cleanup(t, () => {
    delete process.env.CIRCLE_TEST_HELPER_TOKEN;
  });
  const command = `"${process.execPath}" "${helper}"`;
  const manager = new McpManager(workspace, 30_000, undefined, { home });
  cleanup(t, () => manager.close());
  await manager.load(
    [
      {
        name: 'shared',
        scope: 'project',
        folder: workspace,
        config: {
          type: 'http',
          url: stub.url,
          headers: { Authorization: 'Bearer static', 'X-Team': 'lab' },
          headersHelper: command,
        },
      },
    ],
    new Set(),
    undefined,
    { trusted: true },
  );
  assert.equal(manager.status[0]?.error, '', manager.describe());
  const headers = stub.requests[0]!.headers;
  assert.equal(headers.authorization, 'Bearer helper-shared');
  assert.equal(headers['x-team'], 'lab');
  assert.equal(headers['x-url'], stub.url);
  assert.equal(
    headers['x-cwd'] && resolve(String(headers['x-cwd'])),
    resolve(workspace),
  );
  // A helper the project brings does not get the variables whose names look secret
  assert.equal(headers['x-secret'], 'undefined');
  // Not trusted: the helper does not run, and the server is reached with its own headers
  stub.requests.length = 0;
  await manager.load(
    [
      {
        name: 'local',
        scope: 'local',
        folder: workspace,
        config: { type: 'http', url: stub.url, headersHelper: command },
      },
    ],
    new Set(),
    undefined,
    { trusted: false },
  );
  assert.equal(stub.requests[0]!.headers.authorization, undefined);
  assert.match(manager.describe(), /headersHelper not run/);
});

test('saving a server for an extension writes it under its name in mcpServers', async (t) => {
  const { home, workspace } = folders(t);
  const stub = await mcpStub(t, { tools: echo });
  const settings = trustFolder(defaultSettings(), workspace);
  saveSettings(settings, home);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model: new ScriptedModel([]),
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  const state = await runtime.saveMcpServer('docs', {
    type: 'http',
    url: stub.url,
  });
  assert.equal(state.state, 'connected');
  assert.deepEqual(loadSettings(home).mcpServers, {
    docs: { type: 'http', url: stub.url },
  });
  assert.ok(runtime.harness.tools.some((tool) => tool.name === 'docs_echo'));
});
