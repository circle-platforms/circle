import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtensionHost, bundledExtensionsRoot } from '../src/extensions.js';
import { submitAnswer } from '../src/secret_prompt.js';

const PASSWORD = 'pw-tools-5521-qq';
const TOKEN = 'tok-tools-77c1a9';
const sha = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
// Synthetic record contents the stand-in server serves.
const BED = Buffer.from('# bed facts\nsynthetic rows\n');
const ROW = Buffer.from('row,value\n1,2\n');
const TREE = Buffer.from('{"commands":3812}');
const BAD = Buffer.from('tampered synthetic bytes');
async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// A stand-in server with a tool catalog: two read tools (one of them a server task), one
// tool that changes something, and one whose source is down. It also serves the content of
// a few knowledge, evidence and artifact records, one with a SHA-256 that does not match.
async function toolServer(t: Parameters<typeof scratch>[0]) {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const packs: Record<string, any>[] = [];
  const runs: Record<string, any>[] = [];
  let listRows: Record<string, any>[] | undefined;
  let catalogVersion = 1;
  let catalogReads = 0;
  let notModified = 0;
  let looks = 0;
  const catalog = () => [
    ...(catalogVersion === 1
      ? [
          {
            name: 'docs.list',
            title: 'List documents',
            description: 'Documents in a folder of the document service.',
            inputSchema: {
              type: 'object',
              properties: { folder: { type: 'string' } },
              required: ['folder'],
            },
            effect: 'read',
            mode: 'sync',
            permission: 'docs.read',
          },
        ]
      : []),
    {
      name: 'buildsite.command_tree',
      title: 'Command tree',
      description: 'The command tree of a build.',
      inputSchema: {
        type: 'object',
        properties: { build: { type: 'string' } },
      },
      effect: 'read',
      mode: 'task',
      permission: 'buildsite.read',
    },
    {
      name: 'knowledge.claim_submit',
      description: 'Submit a claim with its evidence.',
      inputSchema: { type: 'object', properties: {} },
      effect: 'write',
      mode: 'sync',
      permission: 'knowledge.write',
      approval: true,
    },
    {
      name: 'notes.save',
      description: 'Save a note on the server.',
      inputSchema: { type: 'object', properties: {} },
      effect: 'write',
      mode: 'sync',
      permission: 'notes.write',
      approval: false,
    },
    {
      name: 'env.inventory',
      description: 'Environment resources.',
      inputSchema: { type: 'object', properties: {} },
      effect: 'read',
      mode: 'sync',
      permission: 'env.read',
    },
  ];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const body = await read(request);
    const send = (status: number, value: unknown, headers = {}) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        ...headers,
      });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/v1/auth/dev-login') {
      const input = JSON.parse(body.toString());
      if (input.password !== PASSWORD)
        return send(401, { status: 'failed', error: { code: 'BAD' } });
      return send(200, { data: { token: TOKEN, scopes: ['scp_lab'] } });
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`)
      return send(401, {
        status: 'failed',
        error: { code: 'UNAUTHENTICATED' },
      });
    if (url.pathname === '/v1/status')
      return send(200, { data: { apiVersion: '1.0.0' } });
    if (url.pathname === '/v1/tools') {
      catalogReads++;
      const tag = `"catalog-${catalogVersion}"`;
      if (request.headers['if-none-match'] === tag) {
        notModified++;
        response.writeHead(304, { etag: tag });
        return response.end();
      }
      return send(200, { data: catalog() }, { etag: tag });
    }
    const called = /^\/v1\/tools\/([^/]+)\/call$/.exec(url.pathname);
    if (called && request.method === 'POST') {
      const name = decodeURIComponent(called[1]!);
      calls.push({ name, body: JSON.parse(body.toString()) });
      if (name === 'docs.list')
        return send(200, {
          data: {
            result: { entries: ['manual-cli.md', 'manual-app.md'] },
            evidence: [{ evidenceId: 'evd_1', sha256: 'a'.repeat(64) }],
          },
        });
      if (name === 'buildsite.command_tree')
        return send(200, { data: { taskId: 'task_tree', phase: 'admitted' } });
      if (name === 'env.inventory')
        return send(502, {
          status: 'failed',
          error: {
            code: 'SOURCE_UNREACHABLE',
            message: 'the jump host did not answer',
          },
        });
      return send(200, { data: { result: { claimId: 'clm_1' } } });
    }
    if (url.pathname === '/v1/tasks/task_tree/status')
      return send(200, {
        data: {
          taskId: 'task_tree',
          phase: ++looks > 1 ? 'delivered' : 'running',
        },
      });
    if (url.pathname === '/v1/tasks/task_tree/result')
      return send(200, { data: { status: 'succeeded', commands: 3812 } });
    const content =
      /^\/v1\/(knowledge\/records|evidence|artifacts)\/([^/]+)\/content$/.exec(
        url.pathname,
      );
    if (content) {
      const found = (
        {
          knr_bed: { body: BED, type: 'text/markdown; charset=utf-8' },
          evd_row: { body: ROW, type: 'text/csv' },
          evd_bad: { body: BAD, type: 'text/plain', sha: '0'.repeat(64) },
          art_tree: { body: TREE, type: 'application/json' },
        } as Record<string, { body: Buffer; type: string; sha?: string }>
      )[decodeURIComponent(content[2]!)];
      if (!found)
        return send(404, {
          status: 'failed',
          error: { code: 'TARGET_NOT_FOUND' },
        });
      response.writeHead(200, {
        'content-type': found.type,
        'x-content-sha256': found.sha ?? sha(found.body),
      });
      return response.end(found.body);
    }
    if (url.pathname === '/v1/skillpacks' && request.method === 'POST') {
      const pack = JSON.parse(body.toString());
      // The server's contract is strict: these keys and no others.
      if (
        Object.keys(pack).sort().join() !== 'files,manifest,trial' ||
        Object.keys(pack.trial).sort().join() !== 'outputs,toolCalls'
      )
        return send(400, {
          status: 'failed',
          error: {
            code: 'INVALID_PAYLOAD',
            message: 'Payload does not satisfy the contract',
          },
        });
      const declared = new Set(pack.manifest.tools);
      const offered = new Set(catalog().map((tool) => tool.name));
      const undeclaredTools = [
        ...new Set(
          pack.trial.toolCalls
            .map((call: { name: string }) => call.name)
            .filter((name: string) => !declared.has(name)),
        ),
      ];
      const missingTools = pack.manifest.tools.filter(
        (name: string) => !offered.has(name),
      );
      // The hub refuses an unchecked pack outright; success is 201 with candidate.
      if (undeclaredTools.length || missingTools.length)
        return send(422, {
          status: 'failed',
          error: {
            code: 'SKILLPACK_CHECK_FAILED',
            message: [
              undeclaredTools.length
                ? `Undeclared trial tools: ${undeclaredTools.join(', ')}`
                : '',
              missingTools.length
                ? `Tools unavailable in caller catalog: ${missingTools.join(', ')}`
                : '',
            ]
              .filter(Boolean)
              .join('; '),
            details: { check: { undeclaredTools, missingTools } },
          },
        });
      pack.scopeHeader = request.headers['x-scope-id'];
      packs.push(pack);
      return send(201, {
        data: {
          skillPackId: 'skp_1',
          digest: 'd'.repeat(64),
          status: 'candidate',
          approvalTaskId: 'task_approve',
          check: { undeclaredTools: [], missingTools: [] },
        },
      });
    }
    if (url.pathname === '/v1/skillpacks')
      return send(200, {
        data:
          listRows ??
          packs.map(() => ({
            skillPackId: 'skp_1',
            manifest: {
              id: 'mindmap-compile',
              version: '0.1.0',
              inputs: { mindmap: 'file', line: 'text', build: 'text' },
            },
            status: 'candidate',
          })),
      });
    if (url.pathname === '/v1/tasks/task_approve/approvals')
      return send(200, {
        data: [
          {
            approvalId: 'apr_skill',
            status: 'open',
            inputRevisionId: 'inrev_s',
          },
        ],
      });
    if (url.pathname === '/v1/skillpacks/skp_1/runs')
      runs.push(JSON.parse(body.toString()));
    if (url.pathname === '/v1/skillpacks/skp_1/runs')
      return send(200, { data: { taskId: 'task_run', phase: 'admitted' } });
    if (url.pathname === '/v1/tasks/task_run/status')
      return send(200, { data: { taskId: 'task_run', phase: 'delivered' } });
    if (url.pathname === '/v1/tasks/task_run/events')
      return send(200, {
        data: {
          events: [
            {
              seq: 1,
              taskId: 'task_run',
              kind: 'task.delivered',
              payload: { status: 'succeeded' },
            },
          ],
        },
      });
    if (url.pathname === '/v1/tasks/task_run/result')
      return send(200, { data: { status: 'succeeded', artifacts: [] } });
    if (url.pathname === '/v1/tasks' || url.pathname === '/v1/packs')
      return send(200, { data: [] });
    send(404, { status: 'failed', error: { code: 'TARGET_NOT_FOUND' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    changeCatalog: () => {
      catalogVersion = 2;
    },
    setList: (rows: Record<string, any>[]) => {
      listRows = rows;
    },
    packs,
    runs,
    reads: () => ({ catalogReads, notModified }),
  };
}

test('after signing in, the connector offers the server tools to the model, runs them by kind, follows task tools, and takes them away again', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const server = await toolServer(t);
  let toolChanges = 0;
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    onTools: () => toolChanges++,
    secret: async (request) => {
      await submitAnswer(home, request.id, PASSWORD);
    },
  }).load();
  const command = host.commands().get('hub')!;
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  const names = () =>
    host
      .tools()
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('hub_tool_'))
      .sort();
  const tool = (name: string) =>
    host.tools().find((item) => item.name === name)!;
  const run = { signal: new AbortController().signal, sessionId: 's' } as never;

  assert.deepEqual(names(), [], 'nothing is offered before signing in');
  await command.handler(`login ${server.url} tester`, context);
  assert.equal(
    lines.at(-1),
    '  5 server tools available to the model from its next turn',
  );
  assert.deepEqual(names(), [
    'hub_tool_buildsite_command_tree',
    'hub_tool_docs_list',
    'hub_tool_env_inventory',
    'hub_tool_knowledge_claim_submit',
    'hub_tool_notes_save',
  ]);
  assert.ok(
    toolChanges >= 4,
    'the host heard of each tool added after loading',
  );

  // Kinds: read tools run without asking, the one that changes something asks first; the
  // server's schema and description reach the model.
  assert.equal(tool('hub_tool_docs_list').effect, 'read');
  assert.equal(tool('hub_tool_docs_list').approval, false);
  assert.equal(tool('hub_tool_knowledge_claim_submit').approval, true);
  assert.equal(tool('hub_tool_notes_save').effect, 'unknown');
  assert.equal(tool('hub_tool_notes_save').approval, false);
  assert.match(
    tool('hub_tool_notes_save').description,
    /It changes something on the server\./,
  );
  assert.equal(
    tool('hub_tool_notes_save').description.includes('asks first'),
    false,
  );
  assert.deepEqual(tool('hub_tool_docs_list').parameters.required, ['folder']);
  assert.match(
    tool('hub_tool_docs_list').description,
    /docs\.list .*Documents in a folder/,
  );
  assert.match(tool('hub_tool_buildsite_command_tree').description, /hub task/);

  // A sync tool returns the result and its evidence; arguments go to the server as given.
  const listed = JSON.parse(
    String(await tool('hub_tool_docs_list').run({ folder: 'manuals' }, run)),
  );
  assert.deepEqual(listed.result.entries, ['manual-cli.md', 'manual-app.md']);
  assert.equal(listed.evidence[0].evidenceId, 'evd_1');
  assert.deepEqual(server.calls[0]!.body.args, { folder: 'manuals' });
  assert.match(String(server.calls[0]!.body.idempotencyKey), /^[0-9a-f-]{36}$/);

  // A task tool hands back a watch that follows the task to its result.
  const watched = await tool('hub_tool_buildsite_command_tree').run(
    { build: 'b1' },
    run,
  );
  assert.match(String(watched), /task_tree/);
  // Without a job registry the watch is waited for inline; its result is the task's.
  assert.match(String(watched), /"commands":3812/);

  // A source that is down is a failed tool call with the server's reason.
  await assert.rejects(
    async () => tool('hub_tool_env_inventory').run({}, run),
    /SOURCE_UNREACHABLE: the jump host did not answer/,
  );

  // Asking again with nothing changed costs one 304 and changes nothing.
  await command.handler('refresh', context);
  assert.equal(server.reads().notModified, 1);
  assert.equal(names().length, 5);

  // A changed catalog removes what the server no longer offers.
  server.changeCatalog();
  await command.handler('tools', context);
  assert.ok(!names().includes('hub_tool_docs_list'));
  assert.equal(names().length, 4);
  assert.ok(
    lines.some((line) =>
      /hub_tool_knowledge_claim_submit ← knowledge\.claim_submit · asks first/.test(
        line,
      ),
    ),
  );

  await command.handler('logout', context);
  assert.deepEqual(names(), [], 'signing out takes the server tools away');
  // Let the status line the connector redraws in the background settle before cleanup.
  await delay(200);
});

test('a server without a tool catalog offers no tools and says nothing about it on sign-in', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const server = await toolServer(t);
  // The same server, but /v1/tools answers 404 as a phase-one server does.
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/tools'))
      return new Response(
        JSON.stringify({
          status: 'failed',
          error: { code: 'TARGET_NOT_FOUND' },
        }),
        { status: 404 },
      );
    return original(input, init);
  }) as typeof fetch;
  cleanup(t, () => {
    globalThis.fetch = original;
  });
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    secret: async (request) => {
      await submitAnswer(home, request.id, PASSWORD);
    },
  }).load();
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  const command = host.commands().get('hub')!;
  await command.handler(`login ${server.url} tester`, context);
  assert.match(lines.at(-1)!, /● signed in to .* as tester/);
  assert.equal(
    host.tools().filter((tool) => tool.name.startsWith('hub_tool_')).length,
    0,
  );
  await command.handler('tools', context);
  assert.equal(lines.at(-1), '  this server offers no tools');
  await delay(200);
});

test('a trial records which server tools the model used, and /hub skill push sends the pack with that record', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const pack = join(workspace, 'skills', 'mindmap-compile');
  mkdirSync(join(pack, 'scripts'), { recursive: true });
  writeFileSync(
    join(pack, 'skillpack.json'),
    JSON.stringify({
      id: 'mindmap-compile',
      version: '0.1.0',
      title: 'Mindmap compile',
      owner: 'tester',
      tools: ['docs.list', 'buildsite.command_tree'],
      triggers: ['manual'],
      inputs: { mindmap: 'file' },
      outputs: ['cases.xlsx'],
      model: 'any',
    }),
  );
  writeFileSync(join(pack, 'SKILL.md'), '# Mindmap compile\n');
  writeFileSync(join(pack, 'scripts', 'emit.ts'), 'export {};\n');
  writeFileSync(join(pack, '.hidden'), 'not sent');
  writeFileSync(join(workspace, 'cases.xlsx'), 'synthetic workbook');
  const server = await toolServer(t);
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    secret: async (request) => {
      await submitAnswer(home, request.id, PASSWORD);
    },
  }).load();
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  const command = host.commands().get('hub')!;
  await command.handler(`login ${server.url} tester`, context);
  await command.handler('trial start', context);
  const run = { signal: new AbortController().signal, sessionId: 's' } as never;
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = host.tools().find((item) => item.name === name)!;
    return host
      .toolBoundary({ tool, args, context: run }, (request) =>
        tool.run(request.args, request.context),
      )
      .catch((error) => String(error));
  };
  await call('hub_tool_docs_list', { folder: 'manuals', depth: 1 });
  await call('hub_tool_env_inventory', {});
  // A tool that is not the server's is not part of the trial record.
  const own = host.tools().find((item) => item.name === 'hub_packs')!;
  await host.toolBoundary({ tool: own, args: {}, context: run }, (request) =>
    own.run(request.args, request.context),
  );

  // The trial record outlives a reload of the extension — and the hub refuses the
  // push outright: a trial call the manifest does not declare is a 422, not a warning.
  const reloaded = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
  }).load();
  await assert.rejects(async () => {
    await reloaded
      .commands()
      .get('hub')!
      .handler(
        'skill push skills/mindmap-compile --outputs cases.xlsx',
        context,
      );
  }, /SKILLPACK_CHECK_FAILED: Undeclared trial tools: env\.inventory/);
  assert.equal(server.packs.length, 0, 'a refused push registers nothing');
  assert.ok(
    lines.some((line) =>
      /the trial used tools skillpack\.json does not declare: env\.inventory/.test(
        line,
      ),
    ),
  );

  // A record that was not pushed is kept, and said so, until --force.
  await command.handler('trial start', context);
  assert.match(lines.at(-1)!, /2 unpushed trial calls would be dropped/);
  await command.handler('trial start --force', context);
  assert.match(lines.at(-1)!, /dropped 2 unpushed trial calls/);
  // A clean trial record (declared tools only) goes through: 201, candidate.
  await call('hub_tool_docs_list', { folder: 'manuals', depth: 1 });
  await command.handler(
    'skill push skills/mindmap-compile --outputs cases.xlsx',
    context,
  );
  const sent = server.packs[0]!;
  assert.equal(sent.manifest.id, 'mindmap-compile');
  assert.equal(
    sent.scopeHeader,
    'scp_lab',
    'the scope signed in to goes along',
  );
  assert.deepEqual(
    sent.files.map((file: { path: string }) => file.path),
    ['SKILL.md', 'scripts/emit.ts', 'skillpack.json'],
    'hidden files stay home; paths use forward slashes',
  );
  const skill = sent.files.find(
    (file: { path: string }) => file.path === 'SKILL.md',
  );
  assert.equal(
    Buffer.from(skill.base64, 'base64').toString(),
    '# Mindmap compile\n',
  );
  assert.equal(
    skill.sha256,
    createHash('sha256').update('# Mindmap compile\n').digest('hex'),
  );
  assert.deepEqual(
    sent.trial.toolCalls.map((item: { name: string; ok: boolean }) => [
      item.name,
      item.ok,
    ]),
    [['docs.list', true]],
  );
  // Arguments travel only as a hash of their canonical form.
  assert.equal(
    sent.trial.toolCalls[0].argsSha256,
    createHash('sha256').update('{"depth":1,"folder":"manuals"}').digest('hex'),
  );
  assert.deepEqual(sent.trial.outputs, [
    {
      path: 'cases.xlsx',
      sha256: createHash('sha256')
        .update(readFileSync(join(workspace, 'cases.xlsx')))
        .digest('hex'),
    },
  ]);
  // --outputs is optional: the files skillpack.json declares are the default.
  await command.handler('skill push skills/mindmap-compile', context);
  assert.deepEqual(server.packs.at(-1)!.trial.outputs, sent.trial.outputs);
  const missing = join(workspace, 'skills', 'missing-output');
  mkdirSync(missing);
  writeFileSync(join(missing, 'SKILL.md'), '# Missing\n');
  writeFileSync(
    join(missing, 'skillpack.json'),
    JSON.stringify({
      id: 'missing-output',
      version: '0.1.0',
      title: 'Missing',
      owner: 'tester',
      tools: ['docs.list'],
      triggers: ['manual'],
      inputs: {},
      outputs: ['gone.xlsx'],
      model: 'any',
    }),
  );
  await assert.rejects(
    async () => command.handler('skill push skills/missing-output', context),
    /gone\.xlsx is not in the workspace/,
  );
  assert.ok(
    lines.some((line) =>
      /✓ submitted mindmap-compile 0\.1\.0 · 3 files · 1 trial calls · skp_1/.test(
        line,
      ),
    ),
  );

  assert.ok(
    lines.some((line) =>
      /waiting for approval apr_skill in task_approve · someone else approves: \/hub approve task_approve apr_skill/.test(
        line,
      ),
    ),
  );
  await command.handler('skill list', context);
  assert.match(lines.at(-1)!, /skp_1 · mindmap-compile 0\.1\.0 · candidate/);
  writeFileSync(join(workspace, 'LBX-200.json'), '[{"data":{},"children":[]}]');
  await command.handler(
    'skill run skp_1 {"mindmap":"LBX-200.json"} --file LBX-200.json',
    context,
  );
  const runBody = server.runs.at(-1)!;
  assert.equal(runBody.inputs.mindmap, 'LBX-200.json');
  assert.deepEqual(
    runBody.inputs.files.map((f: { path: string }) => f.path),
    ['LBX-200.json'],
  );
  assert.equal(
    Buffer.from(runBody.inputs.files[0].base64, 'base64').toString(),
    '[{"data":{},"children":[]}]',
  );
  assert.ok(
    lines.some((line) =>
      /✓ running skp_1 on the server as task_run/.test(line),
    ),
  );
  const runs = server.packs.length;
  assert.equal(runs, 2, 'a second push without --outputs still submits');
  await assert.rejects(
    async () =>
      command.handler('skill push --outputs skills/mindmap-compile', context),
    /--outputs needs a comma-separated file list/,
  );
  await assert.rejects(
    async () =>
      command.handler('skill push skills/mindmap-compile --outputs', context),
    /--outputs needs a comma-separated file list/,
  );
  assert.equal(
    server.packs.length,
    runs,
    '--outputs with no file list does not submit',
  );
  await delay(300);
});

test('/hub skill run takes a pack name, named inputs, files from anywhere, and never a credential file', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'private key bytes');
  writeFileSync(join(root, 'outside.json'), 'outside bytes');
  writeFileSync(join(workspace, 'LBX-200.json'), '[{"data":{},"children":[]}]');
  const server = await toolServer(t);
  server.setList([
    {
      skillPackId: 'skp_1',
      manifest: {
        id: 'mindmap-compile',
        version: '0.1.0',
        inputs: { mindmap: 'file', line: 'text', build: 'text' },
      },
      status: 'candidate',
    },
  ]);
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    secret: async (request) => {
      await submitAnswer(home, request.id, PASSWORD);
    },
  }).load();
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  const command = host.commands().get('hub')!;
  await command.handler(`login ${server.url} tester`, context);
  const literal = (text: string) =>
    new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  // A declared pack name stands for its id, and named inputs fill the JSON.
  await command.handler(
    'skill run mindmap-compile --mindmap LBX-200.json --line 10.5 --file LBX-200.json',
    context,
  );
  const named = server.runs.at(-1)!;
  assert.equal(named.inputs.mindmap, 'LBX-200.json');
  assert.equal(named.inputs.line, '10.5');
  assert.deepEqual(
    named.inputs.files.map((f: { path: string }) => f.path),
    ['LBX-200.json'],
  );
  assert.ok(
    lines.some((line) =>
      /✓ running skp_1 on the server as task_run/.test(line),
    ),
    'a name still reports the id the run went to',
  );

  // The id plus raw JSON still runs as it did before.
  await command.handler('skill run skp_1 {"build":"585"}', context);
  assert.equal(server.runs.at(-1)!.inputs.build, '585');

  // A file outside the workspace travels with the name the server sees.
  await command.handler(
    `skill run mindmap-compile --file ${join(root, 'outside.json')}`,
    context,
  );
  const outside = server.runs.at(-1)!.inputs.files[0];
  assert.equal(outside.path, 'outside.json');
  assert.equal(
    Buffer.from(outside.base64, 'base64').toString(),
    'outside bytes',
  );

  // A credential file never travels, wherever it lives.
  await assert.rejects(
    async () =>
      command.handler(
        `skill run mindmap-compile --file ${join(home, '.ssh', 'id_rsa')}`,
        context,
      ),
    /cannot attach a credential file/,
  );

  // An option the pack does not declare is refused, with the real names.
  await assert.rejects(
    async () => command.handler('skill run mindmap-compile --nope 1', context),
    /unknown option --nope[\s\S]*mindmap/,
  );
  await assert.rejects(
    async () => command.handler('skill run nosuch-pack', context),
    /no skill pack named nosuch-pack/,
  );

  // A missing file says which workspace it looked in.
  await assert.rejects(
    async () =>
      command.handler('skill run mindmap-compile --file gone.json', context),
    (error: unknown) => {
      assert.match(String(error), /is not a file in the workspace/);
      assert.match(String(error), literal(workspace));
      return true;
    },
  );

  // Two packs under one name: refuse, and show both ids.
  server.setList([
    {
      skillPackId: 'skp_1',
      manifest: { id: 'mindmap-compile', version: '0.2.0' },
      status: 'candidate',
    },
    {
      skillPackId: 'skp_2',
      manifest: { id: 'mindmap-compile', version: '0.1.0' },
      status: 'retired',
    },
  ]);
  await assert.rejects(
    async () => command.handler('skill run mindmap-compile', context),
    (error: unknown) => {
      assert.match(
        String(error),
        /several skill packs are named mindmap-compile/,
      );
      assert.match(String(error), /skp_1/);
      assert.match(String(error), /skp_2/);
      return true;
    },
  );
  await delay(300);
});

test('server tool names that would collide or run past 64 characters get a stable suffix from their full name', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const server = await toolServer(t);
  const long = 'documents.' + 'x'.repeat(70) + '.list';
  let order = ['docs.list', 'docs_list', long, 'env.inventory'];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/tools'))
      return new Response(
        JSON.stringify({
          data: order.map((name) => ({
            name,
            description: name,
            inputSchema: { type: 'object', properties: {} },
            effect: 'read',
            mode: 'sync',
          })),
        }),
        { status: 200, headers: { etag: `"${order.join()}"` } },
      );
    return original(input, init);
  }) as typeof fetch;
  cleanup(t, () => {
    globalThis.fetch = original;
  });
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    secret: async (request) => {
      await submitAnswer(home, request.id, PASSWORD);
    },
  }).load();
  const context = {
    workspace,
    toast: () => {},
    append: () => {},
    sendUserMessage: () => {},
  };
  const command = host.commands().get('hub')!;
  const names = () =>
    host
      .tools()
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('hub_tool_'))
      .sort();
  await command.handler(`login ${server.url} tester`, context);
  const first = names();
  assert.equal(first.length, 4);
  assert.equal(new Set(first).size, 4);
  assert.ok(
    first.every((name) => name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name)),
  );
  assert.ok(
    first.includes('hub_tool_env_inventory'),
    'a name with no clash stays plain',
  );
  assert.ok(
    !first.includes('hub_tool_docs_list'),
    'neither of the clashing names takes the plain one',
  );
  // Another order of the same catalog gives the same names.
  order = [...order].reverse();
  await command.handler('tools', context);
  assert.deepEqual(names(), first);
  await delay(200);
});

test('a model can start the trial record and push the skill pack it changed, without the /hub command', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const pack = join(workspace, 'skills', 'mindmap-compile');
  mkdirSync(pack, { recursive: true });
  writeFileSync(
    join(pack, 'skillpack.json'),
    JSON.stringify({
      id: 'mindmap-compile',
      version: '0.2.0',
      title: 'Mindmap compile',
      owner: 'tester',
      tools: ['docs.list'],
      triggers: ['manual'],
      inputs: {},
      outputs: ['cases.xlsx'],
      model: 'any',
    }),
  );
  writeFileSync(join(pack, 'SKILL.md'), '# Mindmap compile\n');
  writeFileSync(join(workspace, 'cases.xlsx'), 'synthetic workbook v2');
  const server = await toolServer(t);
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    secret: async (request) => {
      await submitAnswer(home, request.id, PASSWORD);
    },
  }).load();
  const context = {
    workspace,
    toast: () => {},
    append: () => {},
    sendUserMessage: () => {},
  };
  await host
    .commands()
    .get('hub')!
    .handler(`login ${server.url} tester`, context);
  const run = { signal: new AbortController().signal, sessionId: 's' } as never;
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = host.tools().find((item) => item.name === name)!;
    assert.ok(tool, `${name} is offered to the model`);
    return host.toolBoundary({ tool, args, context: run }, (request) =>
      tool.run(request.args, request.context),
    );
  };
  await call('hub_trial_start', {});
  const listed: unknown = await call('hub_tool_docs_list', {
    folder: 'manuals',
  });
  const answer = (typeof listed === 'string' ? JSON.parse(listed) : listed) as {
    savedAs: string;
    result: unknown;
  };
  // The response is kept in the workspace as it came, for the skill's checks to read.
  const kept = JSON.parse(
    readFileSync(join(workspace, answer.savedAs), 'utf8'),
  );
  assert.equal(kept.tool, 'docs.list');
  assert.deepEqual(kept.args, { folder: 'manuals' });
  assert.deepEqual(kept.response.result, answer.result);
  assert.deepEqual(kept.response.result, {
    entries: ['manual-cli.md', 'manual-app.md'],
  });
  const raw: unknown = await call('hub_skill_push', {
    folder: 'skills/mindmap-compile',
    outputs: ['cases.xlsx'],
  });
  const pushed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
    lines: string[];
  };
  const sent = server.packs.at(-1)!;
  assert.equal(sent.manifest.version, '0.2.0');
  assert.deepEqual(
    sent.trial.toolCalls.map((item: { name: string }) => item.name),
    ['docs.list'],
    'the trial the model started is what goes with the pack',
  );
  assert.equal(
    sent.trial.outputs[0].sha256,
    createHash('sha256').update('synthetic workbook v2').digest('hex'),
  );
  assert.ok(
    pushed.lines.some((line) =>
      /✓ submitted mindmap-compile 0\.2\.0 · 2 files · 1 trial calls · skp_1/.test(
        line,
      ),
    ),
  );
  assert.ok(
    pushed.lines.some((line) =>
      /someone else approves: \/hub approve/.test(line),
    ),
  );
  await delay(200);
});

test('the evidence tool saves a record’s content after checking its SHA-256, and refuses what does not check out', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const server = await toolServer(t);
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    secret: async (request) => {
      await submitAnswer(home, request.id, PASSWORD);
    },
  }).load();
  const context = {
    workspace,
    toast: () => {},
    append: () => {},
    sendUserMessage: () => {},
  };
  await host
    .commands()
    .get('hub')!
    .handler(`login ${server.url} tester`, context);
  const tool = host.tools().find((item) => item.name === 'hub_evidence')!;
  assert.ok(tool, 'the evidence tool is offered to the model');
  assert.equal(tool.effect, 'read');
  assert.equal(tool.approval, false);
  const run = { signal: new AbortController().signal, sessionId: 's' } as never;
  const call = async (args: Record<string, unknown>) => {
    const result: unknown = await host.toolBoundary(
      { tool, args, context: run },
      (request) => tool.run(request.args, request.context),
    );
    return typeof result === 'string' ? JSON.parse(result) : result;
  };

  // Each prefix reads its own route and saves under evidence/, checked against the SHA-256.
  const bed = await call({ id: 'knr_bed' });
  assert.equal(bed.id, 'knr_bed');
  assert.equal(bed.path, 'evidence/knr_bed.md');
  assert.equal(bed.mediaType, 'text/markdown');
  assert.equal(bed.sha256, sha(BED));
  assert.equal(bed.bytes, BED.length);
  assert.equal(readFileSync(join(workspace, bed.path), 'utf8'), BED.toString());
  assert.ok(
    !JSON.stringify(bed).includes('synthetic rows'),
    'the content itself stays out of the reply',
  );
  const row = await call({ id: 'evd_row' });
  assert.equal(row.path, 'evidence/evd_row.csv');
  assert.equal(row.sha256, sha(ROW));
  assert.equal(readFileSync(join(workspace, row.path), 'utf8'), ROW.toString());

  // save_as picks where the file goes, inside the workspace.
  const tree = await call({ id: 'art_tree', save_as: 'downloads/tree.json' });
  assert.equal(tree.path, 'downloads/tree.json');
  assert.equal(tree.mediaType, 'application/json');
  assert.equal(
    readFileSync(join(workspace, tree.path), 'utf8'),
    TREE.toString(),
  );

  // Bytes that do not match the server's SHA-256 are not saved.
  await assert.rejects(
    () => call({ id: 'evd_bad' }),
    /do not match the server's SHA-256 .*not saved/,
  );
  assert.ok(!existsSync(join(workspace, 'evidence', 'evd_bad.txt')));

  // An id whose prefix names no record kind never reaches the server.
  await assert.rejects(
    () => call({ id: 'tsk_9' }),
    /must start with knr_ \(knowledge record\), evd_ \(evidence\) or art_ \(artifact\)/,
  );

  // save_as cannot leave the workspace.
  await assert.rejects(
    () => call({ id: 'knr_bed', save_as: '../outside.txt' }),
    /save_as \.\.\/outside\.txt is outside the workspace/,
  );
  assert.ok(!existsSync(join(root, 'outside.txt')));
  await delay(200);
});
