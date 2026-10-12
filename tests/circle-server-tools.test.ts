import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtensionHost, bundledExtensionsRoot } from '../src/extensions.js';
import { submitAnswer } from '../src/secret_prompt.js';

const PASSWORD = 'pw-tools-5521-qq';
const TOKEN = 'tok-tools-77c1a9';
async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// A stand-in server with a tool catalog: two read tools (one of them a server task), one
// tool that changes something, and one whose source is down.
async function toolServer(t: Parameters<typeof scratch>[0]) {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const packs: Record<string, any>[] = [];
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
    if (url.pathname === '/v1/skillpacks' && request.method === 'POST') {
      const pack = JSON.parse(body.toString());
      packs.push(pack);
      const declared = new Set(pack.manifest.tools);
      const offered = new Set(catalog().map((tool) => tool.name));
      return send(200, {
        data: {
          skillPackId: 'skp_1',
          digest: 'd'.repeat(64),
          status: 'submitted',
          check: {
            undeclaredTools: [
              ...new Set(
                pack.trial.toolCalls
                  .map((call: { name: string }) => call.name)
                  .filter((name: string) => !declared.has(name)),
              ),
            ],
            missingTools: pack.manifest.tools.filter(
              (name: string) => !offered.has(name),
            ),
          },
        },
      });
    }
    if (url.pathname === '/v1/skillpacks')
      return send(200, {
        data: packs.map(() => ({
          skillPackId: 'skp_1',
          manifest: { id: 'mindmap-compile', version: '0.1.0' },
          status: 'submitted',
        })),
      });
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
              type: 'task.delivered',
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
    packs,
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
    settings: { 'circle-server': { enabled: true } },
    onTools: () => toolChanges++,
    secret: async (request) => {
      await submitAnswer(home, request.id, PASSWORD);
    },
  }).load();
  const command = host.commands().get('server')!;
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
      .filter((name) => name.startsWith('srv_'))
      .sort();
  const tool = (name: string) =>
    host.tools().find((item) => item.name === name)!;
  const run = { signal: new AbortController().signal, sessionId: 's' } as never;

  assert.deepEqual(names(), [], 'nothing is offered before signing in');
  await command.handler(`login ${server.url} tester`, context);
  assert.equal(
    lines.at(-1),
    '  4 server tools available to the model from its next turn',
  );
  assert.deepEqual(names(), [
    'srv_buildsite_command_tree',
    'srv_docs_list',
    'srv_env_inventory',
    'srv_knowledge_claim_submit',
  ]);
  assert.ok(
    toolChanges >= 4,
    'the host heard of each tool added after loading',
  );

  // Kinds: read tools run without asking, the one that changes something asks first; the
  // server's schema and description reach the model.
  assert.equal(tool('srv_docs_list').effect, 'read');
  assert.equal(tool('srv_docs_list').approval, false);
  assert.equal(tool('srv_knowledge_claim_submit').approval, true);
  assert.deepEqual(tool('srv_docs_list').parameters.required, ['folder']);
  assert.match(
    tool('srv_docs_list').description,
    /docs\.list .*Documents in a folder/,
  );
  assert.match(tool('srv_buildsite_command_tree').description, /server task/);

  // A sync tool returns the result and its evidence; arguments go to the server as given.
  const listed = JSON.parse(
    String(await tool('srv_docs_list').run({ folder: 'manuals' }, run)),
  );
  assert.deepEqual(listed.result.entries, ['manual-cli.md', 'manual-app.md']);
  assert.equal(listed.evidence[0].evidenceId, 'evd_1');
  assert.deepEqual(server.calls[0]!.body.args, { folder: 'manuals' });
  assert.match(String(server.calls[0]!.body.idempotencyKey), /^[0-9a-f-]{36}$/);

  // A task tool hands back a watch that follows the task to its result.
  const watched = await tool('srv_buildsite_command_tree').run(
    { build: 'b1' },
    run,
  );
  assert.match(String(watched), /task_tree/);
  // Without a job registry the watch is waited for inline; its result is the task's.
  assert.match(String(watched), /"commands":3812/);

  // A source that is down is a failed tool call with the server's reason.
  await assert.rejects(
    async () => tool('srv_env_inventory').run({}, run),
    /SOURCE_UNREACHABLE: the jump host did not answer/,
  );

  // Asking again with nothing changed costs one 304 and changes nothing.
  await command.handler('refresh', context);
  assert.equal(server.reads().notModified, 1);
  assert.equal(names().length, 4);

  // A changed catalog removes what the server no longer offers.
  server.changeCatalog();
  await command.handler('tools', context);
  assert.ok(!names().includes('srv_docs_list'));
  assert.equal(names().length, 3);
  assert.ok(
    lines.some((line) =>
      /srv_knowledge_claim_submit ← knowledge\.claim_submit · asks first/.test(
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
    settings: { 'circle-server': { enabled: true } },
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
  const command = host.commands().get('server')!;
  await command.handler(`login ${server.url} tester`, context);
  assert.match(lines.at(-1)!, /● signed in to .* as tester/);
  assert.equal(
    host.tools().filter((tool) => tool.name.startsWith('srv_')).length,
    0,
  );
  await command.handler('tools', context);
  assert.equal(lines.at(-1), '  this server offers no tools');
  await delay(200);
});

test('a trial records which server tools the model used, and /server skill push sends the pack with that record', async (t) => {
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
    settings: { 'circle-server': { enabled: true } },
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
  const command = host.commands().get('server')!;
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
  await call('srv_docs_list', { folder: 'manuals', depth: 1 });
  await call('srv_env_inventory', {});
  // A tool that is not the server's is not part of the trial record.
  const own = host.tools().find((item) => item.name === 'circle_server_packs')!;
  await host.toolBoundary({ tool: own, args: {}, context: run }, (request) =>
    own.run(request.args, request.context),
  );

  await command.handler(
    'skill push skills/mindmap-compile --outputs cases.xlsx',
    context,
  );
  const sent = server.packs[0]!;
  assert.equal(sent.manifest.id, 'mindmap-compile');
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
    [
      ['docs.list', true],
      ['env.inventory', false],
    ],
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
  assert.ok(
    lines.some((line) =>
      /the trial used tools skillpack\.json does not declare: env\.inventory/.test(
        line,
      ),
    ),
  );
  assert.ok(
    lines.some((line) =>
      /✓ submitted mindmap-compile 0\.1\.0 · 3 files · 2 trial calls · skp_1/.test(
        line,
      ),
    ),
  );
  assert.ok(
    lines.some((line) =>
      /✖ the server found tools the trial used but the pack does not declare: env\.inventory/.test(
        line,
      ),
    ),
  );

  await command.handler('skill list', context);
  assert.match(lines.at(-1)!, /skp_1 · mindmap-compile 0\.1\.0 · submitted/);
  await command.handler('skill run skp_1 {"mindmap":"LBX-200.xmind"}', context);
  assert.ok(
    lines.some((line) =>
      /✓ running skp_1 on the server as task_run/.test(line),
    ),
  );
  const runs = server.packs.length;
  assert.equal(runs, 1);
  await delay(300);
});
