import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  FILE_PARAMETER_NOTE,
  MAX_FILE_BYTES,
  McpManager,
  buildMcpConnections,
  fileParameters,
  modelSchema,
} from '../src/mcp_loader.js';
import type { FileMutations } from '../src/file_mutations.js';
import {
  DEFAULT_CREDENTIAL_FILES,
  protectedWorkspaceName,
} from '../src/file_patterns.js';
import type { ApprovalDecision } from '../src/harness.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { approvalRequest } from '../src/tui/approval_preview.js';
import type { Message, ModelResponse, ToolCall } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
import { mcpStub, type StubRequest, type StubTool } from './mcp-stub.js';

const SCHEMA = {
  type: 'object',
  properties: {
    file: {
      type: 'string',
      contentEncoding: 'base64',
      contentMediaType: 'application/octet-stream',
      description: 'The document.',
      // Limits of the encoded text, which a path does not meet
      pattern: '^[A-Za-z0-9+/=]*$',
      maxLength: 4,
    },
    note: { type: 'string', description: 'A note.' },
  },
  required: ['file'],
};
const UPLOAD: StubTool = {
  name: 'upload',
  description: 'Store a document.',
  inputSchema: SCHEMA,
};
const reply = (
  text: string,
  calls: Message['tool_calls'] = [],
): Partial<ModelResponse> => ({
  message: {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: text,
    tool_calls: calls,
  },
});
const upload = (id: string, args: Record<string, unknown>) => ({
  id,
  name: 'files-server_upload',
  args,
});
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
// The server answers with what it got, as an echo or an error that quotes its input can
const echo = (request: StubRequest) => ({
  content: [
    {
      type: 'text',
      text: `stored ${String(request.message?.params?.arguments?.file)}`,
    },
  ],
});

async function setup(
  t: TestContext,
  options: {
    entry?: Record<string, unknown>;
    fileMutations?: FileMutations;
    approve?: (call: ToolCall) => ApprovalDecision | Promise<ApprovalDecision>;
  } = {},
) {
  const root = realpathSync.native(scratch(t));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'data'), { recursive: true });
  const stub = await mcpStub(t, { tools: [UPLOAD], call: echo });
  const settings = defaultSettings();
  settings.mcp_servers = [
    {
      name: 'files-server',
      url: stub.url,
      transport: 'streamable_http',
      ...options.entry,
    },
  ];
  const replies: Partial<ModelResponse>[] = [];
  const model = new ScriptedModel(replies);
  const asked: ToolCall[] = [];
  const runtime = new AgentRuntime({
    home: join(root, 'home'),
    workspace,
    settings,
    model,
    userHome: join(root, 'user'),
    fileMutations: options.fileMutations,
    approve: async (call) => {
      asked.push(structuredClone(call));
      return options.approve ? options.approve(call) : 'approve';
    },
  });
  cleanup(t, () => runtime.close());
  const events: unknown[] = [];
  runtime.bus.subscribe((event) => events.push(event));
  await runtime.initialize();
  assert.equal(runtime.mcp.status[0]?.error, '', runtime.mcp.describe());
  const result = (id: string) =>
    runtime.harness.messages.find((message) => message.tool_call_id === id)!;
  return {
    root,
    workspace,
    stub,
    model,
    replies,
    runtime,
    asked,
    events,
    result,
  };
}

test('a base64 property is a file parameter, shown to the model as a local path with the rest of its schema', () => {
  assert.deepEqual(fileParameters(SCHEMA), ['file']);
  assert.deepEqual(
    fileParameters({
      type: 'object',
      properties: {
        upper: { type: 'string', contentEncoding: 'BASE64' },
        plain: { type: 'string' },
        other: { type: 'string', contentEncoding: 'base32' },
        nested: {
          type: 'object',
          properties: { inner: { type: 'string', contentEncoding: 'base64' } },
        },
        list: { type: 'array', contentEncoding: 'base64' },
      },
    }),
    ['upper'],
  );
  assert.deepEqual(fileParameters(undefined), []);
  const before = structuredClone(SCHEMA);
  const shown = modelSchema(SCHEMA, ['file']) as typeof SCHEMA;
  assert.deepEqual(SCHEMA, before);
  assert.deepEqual(shown.properties.file, {
    type: 'string',
    contentEncoding: 'base64',
    contentMediaType: 'application/octet-stream',
    description: `The document. ${FILE_PARAMETER_NOTE}`,
  });
  assert.match(FILE_PARAMETER_NOTE, /LOCAL FILE PATH/);
  assert.deepEqual(shown.properties.note, SCHEMA.properties.note);
  assert.deepEqual(shown.required, ['file']);
  assert.equal(
    (
      modelSchema(
        {
          type: 'object',
          properties: { f: { type: 'string', contentEncoding: 'base64' } },
        },
        ['f'],
      ).properties as Record<string, { description: string }>
    ).f!.description,
    FILE_PARAMETER_NOTE,
  );
});

test('max_file_bytes is 32 MiB unless given, and a value that is not a whole number of bytes stops the server', () => {
  const { connections, skipped } = buildMcpConnections([
    { name: 'plain', url: 'http://127.0.0.1:1/mcp' },
    { name: 'small', url: 'http://127.0.0.1:1/mcp', max_file_bytes: 16 },
    { name: 'words', url: 'http://127.0.0.1:1/mcp', max_file_bytes: '1MB' },
    { name: 'zero', url: 'http://127.0.0.1:1/mcp', max_file_bytes: 0 },
    { name: 'part', url: 'http://127.0.0.1:1/mcp', max_file_bytes: 1.5 },
  ]);
  assert.equal(MAX_FILE_BYTES, 32 * 1024 * 1024);
  assert.deepEqual(
    connections.map((connection) => [connection.name, connection.maxFileBytes]),
    [
      ['plain', undefined],
      ['small', 16],
    ],
  );
  assert.deepEqual(
    skipped.map((row) => [row.name, row.error]),
    ['words', 'zero', 'part'].map((name) => [
      name,
      'max_file_bytes must be a whole number of bytes, 1 or more',
    ]),
  );
});

test("the model gives a path, the server gets the file's bytes, and the card, the model and the transcript see its path, size and sha256", async (t) => {
  let changeOnDisk: (() => void) | undefined;
  const { workspace, stub, model, replies, runtime, asked, events, result } =
    await setup(t, {
      approve: (call) => {
        // Changed after the card was shown: the call still sends what the card described
        changeOnDisk?.();
        changeOnDisk = undefined;
        return call.id === 'refused' ? 'reject' : 'approve';
      },
    });
  const path = join(workspace, 'data', 'report.bin');
  const bytes = Buffer.concat([
    Buffer.from([0, 255, 10, 13]),
    randomBytes(4096),
  ]);
  writeFileSync(path, bytes);
  const later = randomBytes(64);
  changeOnDisk = () => writeFileSync(path, later);
  const label = (sent: Buffer) =>
    `data/report.bin (${sent.length} bytes, sha256 ${sha256(sent)})`;
  replies.push(
    reply('', [
      upload('first', { file: 'data/report.bin', note: 'quarterly' }),
    ]),
    reply('', [upload('second', { file: 'data/report.bin' })]),
    reply('', [upload('refused', { file: 'data/report.bin' })]),
    reply('done'),
  );
  await runtime.harness.run('store the report');
  // The model was shown a path parameter
  const offered = model.requests[0]!.tools.find(
    (tool) => tool.name === 'files-server_upload',
  )!;
  assert.match(
    (offered.parameters as typeof SCHEMA).properties.file.description,
    /^The document\. Takes a LOCAL FILE PATH/,
  );
  // On the wire: the bytes read before the card, then the file as changed, and nothing for
  // the call the person rejected
  const calls = stub.calls();
  assert.equal(calls.length, 2);
  const sent = calls.map((call) => call.message!.params!.arguments);
  assert.deepEqual(Buffer.from(sent[0].file, 'base64'), bytes);
  assert.equal(sent[0].note, 'quarterly');
  assert.ok(calls[0]!.body.includes(bytes.toString('base64')));
  assert.deepEqual(Buffer.from(sent[1].file, 'base64'), later);
  // The card: the path, size and digest in place of the bytes
  assert.deepEqual(
    asked.map((call) => call.args),
    [
      { file: label(bytes), note: 'quarterly' },
      { file: label(later) },
      { file: label(later) },
    ],
  );
  const card = approvalRequest(
    asked[0]!,
    runtime.policy.review(asked[0]!.name, asked[0]!.args),
  );
  assert.match(
    card.body,
    /^file="data\/report\.bin \(4100 bytes, sha256 [0-9a-f]{64}\)"$/m,
  );
  // What the model read, the conversation and the events say the same
  assert.equal(
    result('first').content,
    `file: sent ${label(bytes)}\n\nstored ${label(bytes)}`,
  );
  assert.equal(
    result('second').content,
    `file: sent ${label(later)}\n\nstored ${label(later)}`,
  );
  assert.match(result('refused').content, /rejected/);
  for (const seen of [
    JSON.stringify(model.requests),
    JSON.stringify(runtime.harness.messages),
    JSON.stringify(events),
  ]) {
    assert.ok(!seen.includes(bytes.toString('base64')));
    assert.ok(!seen.includes(later.toString('base64')));
  }
});

test('a path that is not a readable regular file under read_file rules is an error for the model, and the server is not called', async (t) => {
  const { workspace, root, stub, replies, runtime, asked, result } =
    await setup(t, { entry: { max_file_bytes: 16 } });
  writeFileSync(join(workspace, '.env'), 'TOKEN=1');
  writeFileSync(join(workspace, 'big.bin'), Buffer.alloc(17));
  writeFileSync(join(workspace, 'fits.bin'), Buffer.alloc(16, 7));
  writeFileSync(join(root, 'outside.bin'), 'x');
  const fifo = process.platform !== 'win32';
  if (fifo) execFileSync('mkfifo', [join(workspace, 'pipe')]);
  const cases: [string, RegExp][] = [
    ['data', /data is not a regular file/],
    ['missing.bin', /no such file: missing\.bin/],
    [' ', /file takes the path of a local file/],
    ['.env', /Denied by approval policy: '\.env' is a credential file/],
    ['../outside.bin', /Path traversal not allowed/],
    [
      'big.bin',
      /big\.bin is 17 bytes; this server takes files of at most 16 bytes/,
    ],
    ...(fifo
      ? [['pipe', /pipe is not a regular file/] as [string, RegExp]]
      : []),
  ];
  replies.push(
    reply(
      '',
      cases.map(([file], index) => upload(`bad${index}`, { file })),
    ),
    reply('', [upload('fits', { file: 'fits.bin' })]),
    reply('done'),
  );
  await runtime.harness.run('try them all');
  cases.forEach(([file, error], index) => {
    const message = result(`bad${index}`);
    assert.equal(message.status, 'error', file);
    assert.match(message.content, error);
  });
  // No card for a file that cannot be sent, and nothing reached the server but the one that fits
  assert.deepEqual(
    asked.map((call) => call.id),
    ['fits'],
  );
  assert.equal(stub.calls().length, 1);
  assert.deepEqual(
    Buffer.from(stub.calls()[0]!.message!.params!.arguments.file, 'base64'),
    Buffer.alloc(16, 7),
  );
});

test('an echoed file is shown by its label even when a hidden header value is inside its base64, and of two files the longer is swapped first', async (t) => {
  const root = realpathSync.native(scratch(t));
  const full = randomBytes(9000);
  // The first 4800 bytes encode to the first 6400 characters of the whole file's base64
  const head = full.subarray(0, 4800);
  writeFileSync(join(root, 'full.log'), full);
  writeFileSync(join(root, 'head.log'), head);
  // A saved secret that happens to be part of the encoded file
  const token = full.toString('base64').slice(7000, 7016);
  const stub = await mcpStub(t, {
    tools: [
      { name: 'upload', inputSchema: SCHEMA },
      {
        name: 'compare',
        inputSchema: {
          type: 'object',
          properties: {
            before: { type: 'string', contentEncoding: 'base64' },
            after: { type: 'string', contentEncoding: 'base64' },
          },
        },
      },
    ],
    call: (request) => {
      const args = request.message!.params!.arguments as Record<string, string>;
      return {
        content: [
          {
            type: 'text',
            text: Object.entries(args)
              .map(([name, value]) => `${name}=${value}`)
              .join(' '),
          },
        ],
      };
    },
  });
  const manager = new McpManager(root, 30_000, undefined, {
    secrets: () => ({ FILES_TOKEN: token }),
  });
  cleanup(t, () => manager.close());
  await manager.load([
    {
      name: 'files-server',
      url: stub.url,
      transport: 'streamable_http',
      headers: { Authorization: 'Bearer ${secret:FILES_TOKEN}' },
    },
  ]);
  assert.equal(manager.status[0]!.error, '', manager.describe());
  const context = { sessionId: 'one', signal: new AbortController().signal };
  const tool = (name: string) =>
    manager.tools.find((item) => item.name === `files-server_${name}`)!;
  const label = (path: string, bytes: Buffer) =>
    `${path} (${bytes.length} bytes, sha256 ${sha256(bytes)})`;
  assert.equal(
    await tool('upload').run({ file: 'full.log' }, context),
    `file: sent ${label('full.log', full)}\n\nfile=${label('full.log', full)}`,
  );
  assert.equal(
    await tool('compare').run(
      { before: 'head.log', after: 'full.log' },
      context,
    ),
    `before: sent ${label('head.log', head)}\nafter: sent ${label('full.log', full)}\n\nbefore=${label('head.log', head)} after=${label('full.log', full)}`,
  );
});

test("with the desktop's file backend a workspace file read_file may not read there is not sent either", async (t) => {
  const backend: FileMutations = {
    authorize: () => {},
    read: async (path) => ({ path, content: null, revision: null }),
    apply: async () => {},
  };
  const { workspace, stub, replies, runtime, result } = await setup(t, {
    fileMutations: backend,
  });
  mkdirSync(join(workspace, '.git'));
  writeFileSync(join(workspace, '.git', 'config'), 'REMOTE=1');
  mkdirSync(join(workspace, '.circle'));
  writeFileSync(join(workspace, '.circle', 'notes.md'), 'project notes');
  writeFileSync(join(workspace, '.ENV'), 'VALUE=1');
  writeFileSync(join(workspace, 'data.bin'), 'shared bytes');
  linkSync(join(workspace, 'data.bin'), join(workspace, 'other-name.bin'));
  writeFileSync(join(workspace, 'plain.bin'), Buffer.from([7]));
  // macOS and Windows file systems ignore case: there `.ENV` is the credential file `.env`
  const folds = process.platform === 'darwin' || process.platform === 'win32';
  replies.push(
    reply('', [
      upload('git', { file: '.git/config' }),
      upload('circle', { file: '.circle/notes.md' }),
      upload('env', { file: '.ENV' }),
      upload('link', { file: 'other-name.bin' }),
      upload('plain', { file: 'plain.bin' }),
    ]),
    reply('done'),
  );
  await runtime.harness.run('send them');
  assert.match(
    result('git').content,
    /file is not available in this workspace: \.git/,
  );
  assert.match(
    result('circle').content,
    /file is not available in this workspace: \.circle/,
  );
  if (folds)
    assert.match(
      result('env').content,
      /file is not available in this workspace: \.ENV/,
    );
  else assert.match(result('env').content, /^file: sent \.ENV/);
  assert.match(result('link').content, /hard-linked files were not granted/);
  assert.match(result('plain').content, /^file: sent plain\.bin/);
  assert.deepEqual(
    stub.calls().map((call) => call.message!.params!.arguments.file),
    [
      ...(folds ? [] : [Buffer.from('VALUE=1').toString('base64')]),
      Buffer.from([7]).toString('base64'),
    ],
  );
});

test('a workspace name the desktop keeps from file access is .git, .circle or a credential file, without case where the file system ignores it', () => {
  for (const [name, platform, kept] of [
    ['.git', 'linux', true],
    ['.Git', 'linux', false],
    ['.Git', 'darwin', true],
    ['.CIRCLE', 'win32', true],
    ['.env', 'linux', true],
    ['.ENV', 'linux', false],
    ['.ENV', 'darwin', true],
    ['KEY.PEM', 'win32', true],
    ['private.custom', 'linux', true],
    ['notes.txt', 'darwin', false],
  ] as const)
    assert.equal(
      protectedWorkspaceName(
        name,
        [...DEFAULT_CREDENTIAL_FILES, 'private.custom'],
        platform,
      ),
      kept,
      `${name} on ${platform}`,
    );
});

test("with the desktop's file backend a file outside the workspace is sent only with the person's grant, as read_file reads it", async (t) => {
  const outside = realpathSync.native(scratch(t));
  const granted = new Set<string>();
  let owner = '';
  const backend: FileMutations = {
    authorize: (path, sessionId) => {
      const rel = relative(workspaceRoot, path);
      if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
        return;
      if (sessionId !== owner || !granted.has(path))
        throw Error(`external file grant is missing or revoked: ${path}`);
    },
    read: async (path) => ({ path, content: null, revision: null }),
    apply: async () => {},
  };
  let workspaceRoot = '';
  const { workspace, stub, replies, runtime, result } = await setup(t, {
    fileMutations: backend,
  });
  workspaceRoot = workspace;
  owner = runtime.session.id;
  const document = join(outside, 'doc.bin');
  const picture = join(outside, 'pic.png');
  writeFileSync(document, Buffer.from([1, 2, 3]));
  writeFileSync(picture, Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(workspace, 'inside.bin'), Buffer.from([9]));
  replies.push(
    reply('', [
      upload('ungranted', { file: document }),
      upload('inside', { file: 'inside.bin' }),
    ]),
    reply('done'),
  );
  await runtime.harness.run('send without a grant');
  assert.match(result('ungranted').content, /external file grant is missing/);
  assert.deepEqual(
    stub.calls().map((call) => call.message!.params!.arguments.file),
    [Buffer.from([9]).toString('base64')],
  );
  granted.add(document);
  granted.add(picture);
  replies.push(
    reply('', [
      upload('granted', { file: document }),
      upload('picture', { file: picture }),
    ]),
    reply('done'),
  );
  await runtime.harness.run('send with a grant');
  assert.match(result('granted').content, /^file: sent .*doc\.bin \(3 bytes/);
  assert.match(
    result('picture').content,
    /native external file grants support existing text files only/,
  );
  assert.deepEqual(
    stub.calls().map((call) => call.message!.params!.arguments.file),
    [
      Buffer.from([9]).toString('base64'),
      Buffer.from([1, 2, 3]).toString('base64'),
    ],
  );
});
