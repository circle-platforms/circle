import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtensionHost, bundledExtensionsRoot } from '../src/extensions.js';
import { ExtensionSecrets } from '../src/extension_secrets.js';
import { submitAnswer } from '../src/secret_prompt.js';

const PASSWORD = 'pw-lab-7731-zz';
const TOKEN = 'tok-issued-81f2e0c4';
const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out');
    await delay(10);
  }
}

// A stand-in server with the routes the connector calls, recording what it was sent.
async function fakeServer(t: Parameters<typeof scratch>[0]) {
  const workbook = Buffer.from('PK\u0003\u0004 synthetic workbook bytes');
  const seen: { method: string; path: string; auth?: string; body: Buffer }[] =
    [];
  const keys = new Map<string, string>();
  let delivered = false;
  let looks = 0;
  let tokens: string[] = [];
  let logins = 0;
  // The first token is turned down once it has been used five times, as an expired one is.
  // This server has no tool catalog or skill packs; asking for them does not count as a use.
  let uses = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const body = await read(request);
    seen.push({
      method: request.method ?? '',
      path: url.pathname,
      auth: request.headers.authorization,
      body,
    });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/v1/auth/dev-login') {
      const input = JSON.parse(body.toString());
      if (input.password !== PASSWORD)
        return send(401, {
          status: 'failed',
          error: { code: 'UNAUTHENTICATED', message: 'bad password' },
        });
      const token = logins++ === 0 ? TOKEN : TOKEN + '-renewed';
      tokens = [...tokens, token];
      return send(200, {
        data: { token, tokenType: 'Bearer', scopes: ['scp_lab'] },
      });
    }
    const presented = request.headers.authorization?.replace('Bearer ', '');
    if (
      presented === TOKEN &&
      !['/v1/tools', '/v1/skillpacks'].includes(url.pathname)
    )
      uses += 1;
    if (
      !presented ||
      !tokens.includes(presented) ||
      (presented === TOKEN && uses > 5)
    )
      return send(401, {
        status: 'failed',
        error: { code: 'UNAUTHENTICATED', message: 'expired' },
      });
    if (url.pathname === '/v1/status')
      return send(200, { data: { apiVersion: '1.0.0' } });
    if (url.pathname === '/v1/sources')
      return send(201, {
        data: {
          sourceRevisionId: 'src_abc',
          sha256: sha256(body),
          size: body.length,
          fileName: decodeURIComponent(String(request.headers['x-file-name'])),
          scopeId: request.headers['x-scope-id'],
        },
      });
    if (url.pathname === '/v1/tasks/submit') {
      const input = JSON.parse(body.toString());
      const again = keys.has(input.idempotencyKey);
      keys.set(input.idempotencyKey, 'task_one');
      return send(202, {
        data: {
          taskId: 'task_one',
          phase: 'admitted',
          inputRevisionId: 'inrev_1',
          deduplicated: again,
        },
      });
    }
    if (url.pathname === '/v1/tasks/task_one/events') {
      const after = Number(url.searchParams.get('after'));
      const events = [
        { seq: 1, taskId: 'task_one', kind: 'task.accepted', payload: {} },
        {
          seq: 2,
          taskId: 'task_one',
          kind: 'task.delivered',
          payload: { phase: 'delivered' },
        },
      ].filter((event) => event.seq > after);
      delivered ||= events.some((event) => event.seq === 2);
      return send(200, {
        data: { events, after: events.at(-1)?.seq ?? after },
      });
    }
    // The task finishes on its own after a few looks, whether or not its events were read.
    if (url.pathname === '/v1/tasks/task_one/status' && ++looks > 2)
      delivered = true;
    if (url.pathname === '/v1/tasks/task_one/status')
      return send(200, {
        data: {
          taskId: 'task_one',
          phase: delivered ? 'delivered' : 'running',
          title: 'mindmap-compile',
          inputRevisionId: 'inrev_1',
          pendingInputs: [],
        },
      });
    if (url.pathname === '/v1/tasks/task_one/result')
      return send(200, {
        data: {
          taskId: 'task_one',
          phase: 'delivered',
          status: 'succeeded',
          artifacts: [
            {
              artifactId: 'art_1',
              fileName: 'cases.xlsx',
              sha256: sha256(workbook),
              downloadPath: '/v1/artifacts/art_1/content',
            },
          ],
          evidence: [],
          unmapped: [],
          verification: { reader: 'read-excel-file/9.3.12', rowCount: 8 },
        },
      });
    if (url.pathname === '/v1/tasks' && url.searchParams.get('limit') === '20')
      return send(200, {
        data: [
          {
            taskId: 'task_one',
            title: 'mindmap-compile: LBX-HA.xmind',
            phase: delivered ? 'delivered' : 'running',
            inputRevisionId: 'inrev_1',
            capabilityPackId: 'mindmap-compile',
            input: {
              sourceRevisionId: 'src_abc',
              sourceSha256: 'a'.repeat(64),
            },
            pendingInputs: [
              {
                requestId: 'pin_old',
                inputRevisionId: 'inrev_0',
                status: 'open',
                question: 'stale',
                kind: 'clarification',
              },
            ],
          },
        ],
      });
    if (
      url.pathname === '/v1/tasks/task_one/approvals' &&
      request.method === 'GET'
    )
      return send(200, {
        data: [
          {
            approvalId: 'apr_1',
            taskId: 'task_one',
            inputRevisionId: 'inrev_1',
            applicantId: 'tester',
            targetIdentity: 'SHA256:target',
            actionDigest: 'd'.repeat(64),
            status: 'open',
          },
        ],
      });
    if (url.pathname === '/v1/tasks/task_one/approvals/apr_1')
      return send(200, { data: { approvalId: 'apr_1', status: 'approved' } });
    if (url.pathname === '/v1/tasks/task_one/operations')
      return send(200, {
        data: [
          {
            operationId: 'op_1',
            name: 'mindmaps.compile',
            status: 'succeeded',
            workerId: 'lab-east-01',
            fencingToken: 3,
            result: { big: 'x'.repeat(100) },
          },
        ],
      });
    if (url.pathname === '/v1/packs')
      return send(200, {
        data: [
          {
            capabilityPackId: 'mindmap-compile',
            version: '1.0.0',
            title: 'mindmaps',
            inputFormats: ['xmind-2020-content-json'],
            inputSchema: { huge: true },
          },
        ],
      });
    if (url.pathname === '/v1/tasks/task_one/reconcile')
      return send(200, { data: { operationId: 'op_1', status: 'reconciled' } });
    if (url.pathname === '/v1/artifacts/art_1/content') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-content-sha256': sha256(workbook),
      });
      response.end(workbook);
      return;
    }
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
    seen,
    workbook,
    tokens: () => tokens,
  };
}

test('the bundled circle-server connector signs in, uploads, submits, follows and saves a checked result', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const mindmap = Buffer.from('synthetic xmind bytes');
  writeFileSync(join(workspace, 'LBX-HA.xmind'), mindmap);
  const server = await fakeServer(t);
  const prompts: string[] = [];
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { 'circle-server': { enabled: true } },
    secret: async (request) => {
      prompts.push(request.question);
      await submitAnswer(home, request.id, PASSWORD);
    },
  }).load();
  assert.equal(
    host.extensions.find((ext) => ext.name === 'circle-server')?.version,
    '0.1.0',
  );
  const command = host.commands().get('server')!;
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };

  await command.handler(`login ${server.url} tester`, context);
  assert.match(
    lines.at(-1)!,
    /● signed in to .* as tester · scope scp_lab · api 1\.0\.0/,
  );
  assert.equal(
    await new ExtensionSecrets(home, 'circle-server').get('token'),
    TOKEN,
  );

  await command.handler('submit mindmap-compile LBX-HA.xmind', context);
  await until(() => lines.some((line) => line.startsWith('✓ saved')));
  const upload = server.seen.find((call) => call.path === '/v1/sources')!;
  assert.deepEqual(upload.body, mindmap);
  const submitted = JSON.parse(
    server.seen
      .find((call) => call.path === '/v1/tasks/submit')!
      .body.toString(),
  );
  assert.equal(submitted.scopeId, 'scp_lab');
  assert.equal(submitted.capabilityPackId, 'mindmap-compile');
  assert.deepEqual(submitted.input, {
    sourceRevisionId: 'src_abc',
    sourceSha256: createHash('sha256').update(mindmap).digest('hex'),
  });
  assert.equal(upload.auth, `Bearer ${TOKEN}`);
  assert.deepEqual(
    readFileSync(join(workspace, 'cases.xlsx')),
    server.workbook,
  );
  assert.ok(
    lines.some((line) =>
      /task_one · 2 · task\.delivered · delivered/.test(line),
    ),
  );
  assert.ok(
    lines.some((line) =>
      /read back with read-excel-file\/9\.3\.12, 8 rows/.test(line),
    ),
  );
  assert.ok(lines.some((line) => /matches the server/.test(line)));

  // The same files again: the same key, so the server returns the same task.
  await command.handler('submit mindmap-compile LBX-HA.xmind', context);
  assert.ok(lines.some((line) => /no new task/.test(line)));
  // The first token was turned down after a few uses: the password was asked once more on
  // the masked card, and the work went on with a new token.
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /signed you out/);
  assert.equal(
    await new ExtensionSecrets(home, 'circle-server').get('token'),
    TOKEN + '-renewed',
  );
  // Neither the password nor a token ever reached the screen.
  const shown = lines.join('\n');
  assert.ok(!shown.includes(PASSWORD));
  assert.ok(!shown.includes(TOKEN));
  // The task had ended and its results were saved: nothing is fetched twice.
  await until(() => lines.some((line) => /results are saved here/.test(line)));
  assert.equal(lines.filter((line) => line.startsWith('✓ saved')).length, 1);
  // Asked for again, they are saved beside the first copy, which is not overwritten.
  await command.handler('get task_one', context);
  assert.equal(lines.filter((line) => line.startsWith('✓ saved')).length, 2);
  assert.deepEqual(
    readFileSync(join(workspace, 'cases-1.xlsx')),
    server.workbook,
  );

  // The view a paired desktop page reads: the connection, the tasks and recent lines.
  const view = host.view('circle-server') as Record<string, any>;
  assert.equal(view.username, 'tester');
  assert.equal(view.scopeId, 'scp_lab');
  assert.equal(view.signedIn, true);
  assert.equal(view.tasks[0].taskId, 'task_one');
  assert.equal(view.tasks[0].saved, true);
  assert.ok(view.recent.some((line: string) => /✓ saved/.test(line)));
  assert.ok(!JSON.stringify(view).includes(TOKEN));
  await command.handler('tasks', context);
  assert.match(
    lines.at(-1)!,
    /task_one · delivered · mindmap-compile: LBX-HA\.xmind · seen to 2/,
  );
  const ours = () =>
    host.statuses().find((item) => item.extension === 'circle-server');
  // Following ends after the save; then the lamp goes back to green.
  await until(() => ours()?.lamp === 'ok');
  assert.match(ours()!.text, /^circle-server · tester@127\.0\.0\.1:\d+$/);
  await command.handler('logout', context);
  await until(() => ours()?.text === 'circle-server · signed out');
  // Let the last status refresh finish before the folder is removed.
  await delay(50);
  assert.equal(
    await new ExtensionSecrets(home, 'circle-server').get('token'),
    undefined,
  );
  await assert.rejects(
    async () => command.handler('packs', context),
    /not signed in/,
  );
});

test('the connector tools let a model list packs, hand over a file and get the checked result', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'map.xmind'), Buffer.from('another mindmap'));
  const server = await fakeServer(t);
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { 'circle-server': { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
  }).load();
  const lines: string[] = [];
  await host
    .commands()
    .get('server')!
    .handler(`login ${server.url} tester`, {
      workspace,
      toast: (text) => lines.push(text),
      append: (text) => lines.push(text),
      sendUserMessage: () => {},
    });
  const tool = (name: string) =>
    host.tools().find((item) => item.name === name)!;
  assert.equal(tool('circle_server_submit').approval, true);
  assert.equal(tool('circle_server_packs').effect, 'read');
  const context = {
    signal: new AbortController().signal,
    sessionId: 'model',
  } as never;
  // Without a job list the watch is waited for, as an embedding would.
  const submitted = JSON.parse(
    await tool('circle_server_submit').run(
      { pack: 'mindmap-compile', file: 'map.xmind' },
      context,
    ),
  );
  assert.equal(submitted.taskId, 'task_one');
  assert.equal(submitted.phase, 'delivered');
  assert.ok(
    submitted.lines.some((line: string) => /✓ saved .*cases\.xlsx/.test(line)),
  );
  assert.deepEqual(
    readFileSync(join(workspace, 'cases.xlsx')),
    server.workbook,
  );
  const looked = JSON.parse(
    await tool('circle_server_task').run({ task_id: 'task_one' }, context),
  );
  assert.equal(looked.result.status, 'succeeded');
  assert.equal(looked.result.verification.rowCount, 8);
  const everything = JSON.stringify([submitted, looked]);
  assert.ok(!everything.includes(TOKEN));
  await delay(50);
});

test('the connector reads work, execution, knowledge and methods from the server and decides approvals as the server stated them', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const server = await fakeServer(t);
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { 'circle-server': { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
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
  await command.handler('refresh', context);
  assert.match(lines.at(-1)!, /read 1 tasks and 1 capability packs/);
  const objects = (host.view('circle-server') as Record<string, any>).objects;
  assert.equal(objects.work[0].taskId, 'task_one');
  // A question bound to an older input revision is not one the task waits on now.
  assert.deepEqual(objects.work[0].pendingInputs, []);
  assert.equal(objects.work[0].approvals[0].approvalId, 'apr_1');
  assert.deepEqual(objects.execution[0].operations[0], {
    operationId: 'op_1',
    name: 'mindmaps.compile',
    status: 'succeeded',
    workerId: 'lab-east-01',
    fencingToken: 3,
  });
  assert.equal(objects.knowledge[0].source.sourceRevisionId, 'src_abc');
  assert.deepEqual(objects.methods, [
    {
      capabilityPackId: 'mindmap-compile',
      version: '1.0.0',
      title: 'mindmaps',
      inputFormats: ['xmind-2020-content-json'],
    },
  ]);
  await command.handler('approve task_one apr_1', context);
  const decision = JSON.parse(
    server.seen
      .find((call) => call.path === '/v1/tasks/task_one/approvals/apr_1')!
      .body.toString(),
  );
  assert.deepEqual(decision, {
    inputRevisionId: 'inrev_1',
    targetIdentity: 'SHA256:target',
    actionDigest: 'd'.repeat(64),
    approve: true,
  });
  assert.match(
    lines.at(-1)!,
    /✓ approved apr_1 for task_one \(input inrev_1\)/,
  );
  await assert.rejects(
    async () => command.handler('approve task_one apr_missing', context),
    /has no approval apr_missing/,
  );
  await command.handler('reconcile task_one', context);
  assert.match(lines.at(-1)!, /task_one · reconcile · .*reconciled/);
  assert.ok(!JSON.stringify(host.view('circle-server')).includes(TOKEN));
  await delay(50);
});
