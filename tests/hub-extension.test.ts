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
async function fakeServer(
  t: Parameters<typeof scratch>[0],
  beforeDownload?: () => Promise<void>,
) {
  const workbook = Buffer.from('PK\u0003\u0004 synthetic workbook bytes');
  const seen: {
    method: string;
    path: string;
    auth?: string;
    body: Buffer;
    pack?: string | string[];
  }[] = [];
  const keys = new Map<string, string>();
  let delivered = false;
  let looks = 0;
  let tokens: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const body = await read(request);
    seen.push({
      method: request.method ?? '',
      path: url.pathname,
      auth: request.headers.authorization,
      body,
      pack: request.headers['x-capability-pack-id'],
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
      const token = TOKEN;
      tokens = [...tokens, token];
      return send(200, {
        data: { token, tokenType: 'Bearer', scopes: ['scp_lab'] },
      });
    }
    const presented = request.headers.authorization?.replace('Bearer ', '');
    if (!presented || !tokens.includes(presented))
      return send(401, {
        status: 'failed',
        error: { code: 'UNAUTHENTICATED', message: 'expired' },
      });
    if (url.pathname === '/v1/auth/logout' && request.method === 'POST')
      return send(200, { data: { signedOut: true } });
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
    if (url.pathname === '/v1/assets' && request.method === 'POST')
      return send(201, {
        data: {
          assetId: 'ast_source',
          kind: JSON.parse(body.toString()).kind,
          lifecycle: 'draft',
          sourceArtifactId: null,
        },
      });
    if (url.pathname === '/v1/assets/ast_source')
      return send(200, {
        data: {
          assetId: 'ast_source',
          lifecycle: 'approved',
          sourceArtifactId: 'sar_one',
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
      // Payloads as the server projects them: metadata only, an error reduced to its code,
      // the body behind a content reference.
      const events = [
        {
          seq: 1,
          taskId: 'task_one',
          kind: 'task.accepted',
          payload: { inputRevisionId: 'inrev_1' },
        },
        {
          seq: 2,
          taskId: 'task_one',
          kind: 'task.waiting-input',
          payload: {
            requestId: 'pin_1',
            inputRevisionId: 'inrev_1',
            waitingReason: 'gateway-refused',
            reason: { code: 'GATEWAY_REFUSED' },
            error: { code: 'GATEWAY_REFUSED' },
          },
          content: {
            sha256: 'd'.repeat(64),
            size: 96,
            downloadPath: '/v1/tasks/task_one/events/2/content',
          },
        },
        {
          seq: 3,
          taskId: 'task_one',
          kind: 'task.delivered',
          payload: { inputRevisionId: 'inrev_1', status: 'succeeded' },
        },
      ].filter((event) => event.seq > after);
      delivered ||= events.some((event) => event.seq === 3);
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
    // A repair pending input waits for a replacement of the bound input; a
    // clarification waits for a response.
    if (url.pathname === '/v1/tasks/task_two/status')
      return send(200, {
        data: {
          taskId: 'task_two',
          phase: 'waiting-input',
          title: 'repair the build',
          inputRevisionId: 'inrev_2',
          pendingInputs: [
            {
              requestId: 'pin_2',
              inputRevisionId: 'inrev_2',
              status: 'open',
              kind: 'repair',
              question: 'Repair build-mismatch and replace the bound input',
            },
          ],
        },
      });
    if (url.pathname === '/v1/tasks/task_three/status')
      return send(200, {
        data: {
          taskId: 'task_three',
          phase: 'waiting-input',
          title: 'a question',
          inputRevisionId: 'inrev_3',
          pendingInputs: [
            {
              requestId: 'pin_3',
              inputRevisionId: 'inrev_3',
              status: 'open',
              kind: 'clarification',
              question: 'Which bed?',
            },
          ],
        },
      });
    if (
      /^\/v1\/tasks\/task_(two|three)\/input$/.test(url.pathname) &&
      request.method === 'POST'
    )
      return send(200, { data: { phase: 'running' } });
    // A stale event cursor is refused with the retained window's first position.
    if (url.pathname === '/v1/tasks/task_stale/status')
      return send(200, {
        data: {
          taskId: 'task_stale',
          phase: 'delivered',
          title: 'an old task',
          inputRevisionId: 'inrev_1',
          pendingInputs: [],
        },
      });
    if (url.pathname === '/v1/tasks/task_stale/events') {
      const after = Number(url.searchParams.get('after'));
      if (after < 5)
        return send(409, {
          status: 'failed',
          error: {
            code: 'CURSOR_EXPIRED',
            message: 'Events were retained for a bounded window',
            details: { minCursor: 5 },
          },
        });
      return send(200, {
        data: {
          events: [
            {
              seq: 5,
              taskId: 'task_stale',
              kind: 'task.delivered',
              payload: { status: 'succeeded' },
            },
          ],
          after: 5,
        },
      });
    }
    if (url.pathname === '/v1/tasks/task_stale/result')
      return send(200, {
        data: {
          taskId: 'task_stale',
          phase: 'delivered',
          status: 'succeeded',
          artifacts: [],
          evidence: [],
          unmapped: [],
        },
      });
    if (url.pathname === '/v1/tasks/task_bad/events')
      return send(200, { data: { events: [], after: 0 } });
    // A failed flow names the rejected step and its bounded cause.
    if (url.pathname === '/v1/tasks/task_bad/status')
      return send(200, {
        data: {
          taskId: 'task_bad',
          phase: 'failed',
          title: 'a failed flow',
          inputRevisionId: 'inrev_1',
          pendingInputs: [],
        },
      });
    if (url.pathname === '/v1/tasks/task_bad/result')
      return send(200, {
        data: {
          taskId: 'task_bad',
          phase: 'failed',
          status: 'failed',
          error: {
            code: 'HOOK_FAILED',
            message: 'Product flow did not complete',
            details: {
              stepId: 'submit',
              kind: 'provider.call',
              cause: {
                code: 'BUILD_MISMATCH',
                message: 'device reports OTHER, gateway bundle is EXPECTED',
              },
            },
          },
          artifacts: [],
          evidence: [],
          unmapped: [],
        },
      });
    if (
      url.pathname === '/v1/tasks' &&
      url.searchParams.get('kind') === 'work' &&
      url.searchParams.get('limit') === '20'
    )
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
    if (url.pathname === '/v1/tasks/task_one/reconcile') {
      // Hub rule: only a request naming the operation reconciles; without one it
      // explains what is missing.
      const asked = JSON.parse(body.toString() || '{}');
      if (!asked.operationId)
        return send(200, {
          data: {
            taskId: 'task_one',
            phase: 'unknown',
            reconciliation:
              'No independently observed receipt is available for an unknown execution',
          },
        });
      return send(202, {
        data: {
          operationId: 'op_new',
          parentOperationId: asked.operationId,
          status: 'accepted',
        },
      });
    }
    if (url.pathname === '/v1/artifacts/art_1/content') {
      await beforeDownload?.();
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

test('the bundled hub connector signs in, uploads, submits, follows and saves a checked result', async (t) => {
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
    settings: { hub: { enabled: true } },
    secret: async (request) => {
      prompts.push(request.question);
      await submitAnswer(home, request.id, PASSWORD);
    },
  }).load();
  cleanup(t, () => host.close());
  assert.equal(
    host.extensions.find((ext) => ext.name === 'hub')?.version,
    '0.1.0',
  );
  const command = host.commands().get('hub')!;
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
  assert.equal(await new ExtensionSecrets(home, 'hub').get('token'), TOKEN);
  assert.equal(
    JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).extensions.hub
      .url,
    server.url,
  );
  assert.equal(
    JSON.parse(
      readFileSync(join(home, 'extension_data', 'hub', 'config.json'), 'utf8'),
    ).url,
    server.url,
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
  assert.equal(upload.pack, 'mindmap-compile');
  assert.deepEqual(
    readFileSync(join(workspace, 'tasks', 'task_one', 'cases.xlsx')),
    server.workbook,
  );
  assert.ok(
    lines.some((line) =>
      /task_one · 2 · task\.waiting-input · gateway-refused · GATEWAY_REFUSED$/.test(
        line,
      ),
    ),
  );
  assert.ok(
    lines.some((line) =>
      /task_one · 3 · task\.delivered · succeeded$/.test(line),
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
  // Only signing in asked for the password.
  assert.equal(prompts.length, 1);
  assert.equal(await new ExtensionSecrets(home, 'hub').get('token'), TOKEN);
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
    readFileSync(join(workspace, 'tasks', 'task_one', 'cases-1.xlsx')),
    server.workbook,
  );

  // The view a paired desktop page reads: the connection, the tasks and recent lines.
  const latestSave = lines.filter((line) => line.startsWith('✓ saved')).at(-1)!;
  // The files are saved synchronously; showStatus publishes after an asynchronous token
  // read. A returned command is not a barrier for that background projection.
  await until(() => {
    const latest = host.view('hub') as Record<string, any> | undefined;
    return (
      latest?.tasks?.find(
        (task: { taskId: string }) => task.taskId === 'task_one',
      )?.saved === true && latest?.recent?.includes(latestSave)
    );
  });
  const persisted = JSON.parse(
    readFileSync(join(home, 'extension_data', 'hub', 'tasks.json'), 'utf8'),
  );
  assert.equal(persisted.task_one.saved, true);
  const view = host.view('hub') as Record<string, any>;
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
    /task_one · delivered · mindmap-compile: LBX-HA\.xmind · seen to 3/,
  );
  const ours = () => host.statuses().find((item) => item.extension === 'hub');
  // Following ends after the save; then the lamp goes back to green.
  await until(() => ours()?.lamp === 'ok');
  assert.match(ours()!.text, /^hub · tester@127\.0\.0\.1:\d+$/);
  await command.handler('logout', context);
  await until(() => ours()?.text === 'hub · signed out');
  assert.equal(await new ExtensionSecrets(home, 'hub').get('token'), undefined);
  await command.handler('tools', context);
  assert.match(lines.at(-1)!, /not signed in: \/hub login/);
  await assert.rejects(
    async () => command.handler('packs', context),
    /not signed in/,
  );
});

test('a checked file and tasks.json precede the latest asynchronous connector view', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  writeFileSync(
    join(workspace, 'map.xmind'),
    Buffer.from('projection fixture'),
  );
  let releaseDownload!: () => void;
  const download = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });
  let downloading = false;
  const server = await fakeServer(t, async () => {
    downloading = true;
    await download;
  });
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
  }).load();
  cleanup(t, () => host.close());
  let releaseProjection!: () => void;
  const projection = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  cleanup(t, () => {
    releaseDownload();
    releaseProjection();
  });
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (line: string) => lines.push(line),
    append: (line: string) => lines.push(line),
    sendUserMessage: () => {},
  };
  const command = host.commands().get('hub')!;
  await command.handler(`login ${server.url} tester`, context);
  await command.handler('submit mindmap-compile map.xmind', context);
  await until(() => downloading);
  await until(() =>
    (host.view('hub') as Record<string, any> | undefined)?.tasks?.some(
      (task: { taskId: string }) => task.taskId === 'task_one',
    ),
  );
  const token = ExtensionSecrets.prototype.get;
  // Keep the real secret-file read and masking, but hold its completion so the actual
  // showStatus path is observably behind the real file/task changes.
  t.mock.method(
    ExtensionSecrets.prototype,
    'get',
    async function (this: ExtensionSecrets, name: string) {
      const value = await token.call(this, name);
      if (name === 'token') await projection;
      return value;
    },
  );
  releaseDownload();
  await until(() => lines.some((line) => line.startsWith('✓ saved')));
  assert.deepEqual(
    readFileSync(join(workspace, 'tasks', 'task_one', 'cases.xlsx')),
    server.workbook,
  );
  const persisted = JSON.parse(
    readFileSync(join(home, 'extension_data', 'hub', 'tasks.json'), 'utf8'),
  );
  assert.equal(persisted.task_one.saved, true);
  assert.equal(persisted.task_one.seq, 3);
  assert.equal(
    (host.view('hub') as Record<string, any>).tasks.find(
      (task: { taskId: string }) => task.taskId === 'task_one',
    ).saved,
    undefined,
  );
  const latestSave = lines.find((line) => line.startsWith('✓ saved'))!;
  releaseProjection();
  await until(() => {
    const latest = host.view('hub') as Record<string, any>;
    return (
      latest.tasks.find(
        (task: { taskId: string }) => task.taskId === 'task_one',
      )?.saved === true && latest.recent.includes(latestSave)
    );
  });
  assert.equal(lines.filter((line) => line.startsWith('✓ saved')).length, 1);
  assert.ok(!JSON.stringify(host.view('hub')).includes(TOKEN));
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
    settings: { hub: { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
  }).load();
  cleanup(t, () => host.close());
  const lines: string[] = [];
  await host
    .commands()
    .get('hub')!
    .handler(`login ${server.url} tester`, {
      workspace,
      toast: (text) => lines.push(text),
      append: (text) => lines.push(text),
      sendUserMessage: () => {},
    });
  const tool = (name: string) =>
    host.tools().find((item) => item.name === name)!;
  assert.equal(tool('hub_submit').approval, true);
  assert.equal(tool('hub_packs').effect, 'read');
  const context = {
    signal: new AbortController().signal,
    sessionId: 'model',
  } as never;
  // Without a job list the watch is waited for, as an embedding would.
  const submitted = JSON.parse(
    await tool('hub_submit').run(
      { pack: 'mindmap-compile', file: 'map.xmind' },
      context,
    ),
  );
  assert.equal(submitted.taskId, 'task_one');
  assert.equal(submitted.phase, 'delivered');
  // The rest of the input a pack asks for goes along; the file's own source stays the tool's.
  await tool('hub_submit').run(
    {
      pack: 'apv-case-execute',
      file: 'map.xmind',
      input: {
        gatewayAssetId: 'ast_gateway',
        build: 'apv-10.4.6.4',
        sourceRevisionId: 'src_other',
      },
    },
    context,
  );
  const carried = JSON.parse(
    server.seen
      .filter((call) => call.path === '/v1/tasks/submit')
      .at(-1)!
      .body.toString(),
  );
  assert.deepEqual(carried.input, {
    gatewayAssetId: 'ast_gateway',
    build: 'apv-10.4.6.4',
    sourceRevisionId: 'src_abc',
    sourceSha256: createHash('sha256')
      .update(Buffer.from('another mindmap'))
      .digest('hex'),
  });
  await assert.rejects(
    tool('hub_submit').run(
      { pack: 'apv-case-execute', file: 'map.xmind', input: 'build=x' },
      context,
    ),
    /input is an object/,
  );
  assert.ok(
    submitted.lines.some((line: string) => /✓ saved .*cases\.xlsx/.test(line)),
  );
  assert.deepEqual(
    readFileSync(join(workspace, 'tasks', 'task_one', 'cases.xlsx')),
    server.workbook,
  );
  // Files become one source artifact: each uploaded as an original, listed with its role.
  writeFileSync(join(workspace, 'tree.xml'), Buffer.from('<tree/>'));
  assert.equal(tool('hub_source_artifact').approval, true);
  const registered = JSON.parse(
    await tool('hub_source_artifact').run(
      {
        name: 'command source',
        version: '1.0.0',
        files: [{ path: 'tree.xml', role: 'command-tree' }],
        metadata: { buildName: 'Rel_SYN_1' },
        readers: ['prn_reviewer'],
      },
      context,
    ),
  );
  assert.equal(registered.registered.assetId, 'ast_source');
  const listedSource = JSON.parse(
    server.seen
      .filter((call) => call.path === '/v1/assets' && call.method === 'POST')
      .at(-1)!
      .body.toString(),
  );
  assert.equal(listedSource.scopeId, 'scp_lab');
  assert.equal(listedSource.kind, 'knowledge-source');
  assert.equal(listedSource.configuration.schema, 'external-source-artifact/1');
  assert.deepEqual(listedSource.configuration.metadata, {
    buildName: 'Rel_SYN_1',
  });
  assert.deepEqual(listedSource.readers, ['prn_reviewer']);
  assert.deepEqual(listedSource.configuration.files, [
    {
      path: 'tree.xml',
      role: 'command-tree',
      sourceRevisionId: 'src_abc',
      sha256: createHash('sha256').update(Buffer.from('<tree/>')).digest('hex'),
    },
  ]);
  await assert.rejects(
    tool('hub_source_artifact').run(
      {
        name: 'x',
        version: '1',
        files: [{ path: '../outside.xml', role: 'r' }],
      },
      context,
    ),
    /outside the workspace/,
  );
  assert.equal(tool('hub_source_artifact_status').effect, 'read');
  const approvedSource = JSON.parse(
    await tool('hub_source_artifact_status').run(
      { asset_id: 'ast_source' },
      context,
    ),
  );
  assert.equal(approvedSource.sourceArtifactId, 'sar_one');
  const looked = JSON.parse(
    await tool('hub_task').run({ task_id: 'task_one' }, context),
  );
  assert.equal(looked.result.status, 'succeeded');
  assert.equal(looked.result.verification.rowCount, 8);
  const everything = JSON.stringify([submitted, looked]);
  assert.ok(!everything.includes(TOKEN));
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
    settings: { hub: { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
  }).load();
  cleanup(t, () => host.close());
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  const command = host.commands().get('hub')!;
  await command.handler(`login ${server.url} tester`, context);
  await command.handler('refresh', context);
  assert.match(lines.at(-1)!, /read 1 tasks and 1 capability packs/);
  const objects = (host.view('hub') as Record<string, any>).objects;
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
  assert.match(
    lines.at(-1)!,
    /^reconcile task_one\n {2}.*No independently observed receipt/,
  );
  assert.equal(lines.at(-1)!.includes('{'), false);
  // Naming the operation makes it a real reconciliation request.
  await command.handler('reconcile task_one op_9', context);
  assert.deepEqual(
    JSON.parse(
      server.seen
        .filter((call) => call.path === '/v1/tasks/task_one/reconcile')
        .at(-1)!
        .body.toString(),
    ),
    { operationId: 'op_9' },
  );
  assert.match(lines.at(-1)!, /^✓ reconcile task_one · .*accepted/);
  assert.ok(!JSON.stringify(host.view('hub')).includes(TOKEN));
});

test('closing the host ends a task the connector is still following, long poll and all', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  // A server whose task never ends and whose event poll waits as a real one does.
  const seen: string[] = [];
  let cut = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    await read(request);
    seen.push(url.pathname);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/v1/auth/dev-login')
      return send(200, { data: { token: TOKEN, scopes: ['scp_lab'] } });
    if (url.pathname === '/v1/status')
      return send(200, { data: { apiVersion: '1.0.0' } });
    if (url.pathname === '/v1/tasks/task_two/status')
      return send(200, {
        data: { taskId: 'task_two', phase: 'running', title: 'slow' },
      });
    if (url.pathname === '/v1/tasks/task_two/events') {
      // Held until the client gives up on it, which is how the host's close shows.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        timer.unref();
        response.once('close', () => {
          cut = true;
          clearTimeout(timer);
          resolve();
        });
      });
      return send(200, { data: { events: [], after: 0 } });
    }
    send(404, { status: 'failed', error: { code: 'TARGET_NOT_FOUND' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { port } = server.address() as AddressInfo;
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
  }).load();
  cleanup(t, () => host.close());
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  const command = host.commands().get('hub')!;
  await command.handler(`login http://127.0.0.1:${port} tester`, context);
  await command.handler('task task_two', context);
  const ours = () => host.statuses().find((item) => item.extension === 'hub');
  await until(() => ours()?.lamp === 'running');
  await until(() => seen.includes('/v1/tasks/task_two/events'));
  await host.close();
  // The poll was given up (the server sees the socket go a moment after the close), nothing
  // more was asked of the server, and the connector said nothing about it: the task goes on
  // on the server for /hub task to pick up.
  await until(() => cut);
  const asked = seen.length;
  await delay(100);
  assert.equal(seen.length, asked);
  assert.ok(!lines.some((line) => line.startsWith('✖')));
  assert.deepEqual(
    host.extensions.find((ext) => ext.name === 'hub')!.warnings,
    [],
  );
});

test('signing out revokes the token family at the server before forgetting it locally', async (t) => {
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
    settings: { hub: { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
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
  await host.commands().get('hub')!.handler('logout', context);
  const revocation = server.seen.find(
    (call) => call.path === '/v1/auth/logout',
  );
  assert.ok(revocation, 'the server revoked the family');
  assert.equal(revocation.auth, `Bearer ${TOKEN}`);
  assert.equal(
    await new ExtensionSecrets(home, 'hub').get('token'),
    undefined,
    'the local token is gone too',
  );
  await delay(100);
});

test('a repair pending input is answered with a replacement, a clarification with a response', async (t) => {
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
    settings: { hub: { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
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

  await command.handler(
    'respond task_two {"sourceRevisionId":"src_new"}',
    context,
  );
  const repair = JSON.parse(
    server.seen
      .find((call) => call.path === '/v1/tasks/task_two/input')!
      .body.toString(),
  );
  assert.deepEqual(repair, {
    inputRevisionId: 'inrev_2',
    requestId: 'pin_2',
    replacement: { sourceRevisionId: 'src_new' },
  });
  assert.ok(lines.some((line) => /replaced the input of task_two/.test(line)));

  await command.handler('respond task_three bed=east', context);
  const clarification = JSON.parse(
    server.seen
      .find((call) => call.path === '/v1/tasks/task_three/input')!
      .body.toString(),
  );
  assert.deepEqual(clarification, {
    inputRevisionId: 'inrev_3',
    requestId: 'pin_3',
    response: { bed: 'east' },
  });
  assert.ok(lines.some((line) => /✓ answered task_three/.test(line)));
  await delay(100);
});

test('module-execute submits the flow input as it is, with no uploaded source', async (t) => {
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
    settings: { hub: { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
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
  const flow = {
    flowId: 'apv-case-execute-v2',
    methodPin: { assetId: 'ast_m', version: '1.3.0', sha256: 'f'.repeat(64) },
    resources: {
      gateway: { assetId: 'ast_g', version: '2.0.0', sha256: 'e'.repeat(64) },
    },
    sources: {},
    value: { build: 'SYNTHETIC_BUILD_301' },
    controlledBytes: [],
  };
  const run = { signal: new AbortController().signal, sessionId: 's' } as never;
  const tool = host.tools().find((item) => item.name === 'hub_submit')!;
  await tool.run({ pack: 'module-execute', input: flow }, run);
  const sent = JSON.parse(
    server.seen
      .filter((call) => call.path === '/v1/tasks/submit')
      .at(-1)!
      .body.toString(),
  );
  assert.deepEqual(sent.input, flow, 'the flow input goes as it is');
  assert.ok(
    !('sourceRevisionId' in sent.input) && !('sourceSha256' in sent.input),
  );
  assert.ok(
    !server.seen.some((call) => call.path === '/v1/sources'),
    'nothing is uploaded',
  );
  // The command form takes the flow as one JSON word.
  await command.handler(
    `submit module-execute ${JSON.stringify(flow)}`,
    context,
  );
  const again = JSON.parse(
    server.seen
      .filter((call) => call.path === '/v1/tasks/submit')
      .at(-1)!
      .body.toString(),
  );
  assert.deepEqual(again.input, flow);
  // A file pack keeps refusing module-execute's input shape and vice versa.
  await assert.rejects(tool.run({ pack: 'module-execute' }, run), /flow input/);
  await assert.rejects(
    tool.run({ pack: 'mindmap-compile' }, run),
    /file is required/,
  );
  await delay(200);
});

test('a stale event cursor restarts at the retained window instead of sticking', async (t) => {
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
    settings: { hub: { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
  }).load();
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  await host
    .commands()
    .get('hub')!
    .handler(`login ${server.url} tester`, context);
  await host.commands().get('hub')!.handler('task task_stale', context);
  await until(
    () => lines.some((line) => /task_stale · 5 · task\.delivered/.test(line)),
    5000,
  );
  const reads = server.seen
    .filter((call) => call.path === '/v1/tasks/task_stale/events')
    .map((call) => call.path);
  assert.ok(reads.length >= 2, 'the expired cursor was retried');
  assert.ok(
    !lines.some((line) => /CURSOR_EXPIRED/.test(line)),
    'the refusal stays off the screen',
  );
  await delay(100);
});

test('a failed flow shows the rejected step and the bounded cause', async (t) => {
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
    settings: { hub: { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
  }).load();
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  await host
    .commands()
    .get('hub')!
    .handler(`login ${server.url} tester`, context);
  await host.commands().get('hub')!.handler('task task_bad', context);
  await until(() => lines.some((line) => /✖ task_bad failed/.test(line)), 5000);
  assert.ok(
    lines.some((line) =>
      /✖ task_bad failed: HOOK_FAILED · Product flow did not complete · step submit \(provider\.call\) · BUILD_MISMATCH: device reports OTHER, gateway bundle is EXPECTED/.test(
        line,
      ),
    ),
  );
  await delay(100);
});

test('/hub alone is a short status, and /hub help lines the descriptions up', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
  }).load();
  cleanup(t, () => host.close());
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  const command = host.commands().get('hub')!;
  await command.handler('', context);
  assert.match(lines.at(-1)!, /http:\/\/127\.0\.0\.1:7410/);
  assert.match(lines.at(-1)!, /not signed in/);
  assert.match(lines.at(-1)!, /\/hub help lists the commands/);
  assert.equal(lines.at(-1)!.includes('/hub bot list'), false);
  await command.handler('help', context);
  const help = lines.at(-1)!;
  const column = (prefix: string) => {
    const line = help.split('\n').find((row) => row.startsWith(prefix + ' '))!;
    return prefix.length + line.slice(prefix.length).search(/\S/);
  };
  assert.equal(
    column('/hub approve <id> <approval>'),
    column('/hub reconcile <id> [op]'),
  );
  assert.match(help, /revoke the token at the server, then forget it/);
  assert.match(help, /\/hub bot list/);
});

test('a password given with the command is not asked for and does not appear in the reply', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const server = await fakeServer(t);
  const prompts: string[] = [];
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    secret: async (request) => {
      prompts.push(request.question);
      await submitAnswer(home, request.id, PASSWORD);
    },
  }).load();
  cleanup(t, () => host.close());
  const lines: string[] = [];
  await host
    .commands()
    .get('hub')!
    .handler(`login ${server.url} tester`, {
      workspace,
      toast: (text) => lines.push(text),
      append: (text) => lines.push(text),
      sendUserMessage: () => {},
      secret: PASSWORD,
    });
  assert.equal(prompts.length, 0);
  assert.match(lines.at(-1)!, /scope scp_lab/);
  assert.equal(lines.join('\n').includes(PASSWORD), false);
  assert.equal(JSON.stringify(host.view('hub')).includes(PASSWORD), false);
});

test('a refused payload names the fields instead of a raw code dump', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const server = createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        status: 'failed',
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'invalid',
          details: {
            issues: [
              {
                path: ['manifest', 'outputs'],
                code: 'too_small',
                message: 'too small',
              },
            ],
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const port = (server.address() as AddressInfo).port;
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true, url: `http://127.0.0.1:${port}` } },
    secret: async (request) => submitAnswer(home, request.id, 'nope'),
  }).load();
  cleanup(t, () => host.close());
  await assert.rejects(
    async () =>
      host
        .commands()
        .get('hub')!
        .handler('login tester', {
          workspace,
          toast: () => {},
          append: () => {},
          sendUserMessage: () => {},
        }),
    /INVALID_PAYLOAD[\s\S]*manifest\.outputs[\s\S]*skillpack\.json needs outputs/,
  );
});

test('a decision conflict says what collided, and review, audit and modules list the ids', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/v1/auth/dev-login')
      return send(200, {
        data: { token: TOKEN, tokenType: 'Bearer', scopes: ['scp_lab'] },
      });
    if (request.headers.authorization !== `Bearer ${TOKEN}`)
      return send(401, {
        status: 'failed',
        error: { code: 'UNAUTHENTICATED', message: 'expired' },
      });
    if (url.pathname === '/v1/status')
      return send(200, { data: { apiVersion: '1.0.0' } });
    if (url.pathname === '/v1/tools') return send(200, { data: [] });
    if (url.pathname === '/v1/tasks/task_ask/status')
      return send(200, {
        data: {
          taskId: 'task_ask',
          phase: 'waiting-review',
          inputRevisionId: 'inrev_1',
          pendingInputs: [
            {
              requestId: 'apr_9',
              inputRevisionId: 'inrev_1',
              status: 'open',
              kind: 'approval',
              question: 'Approve changesets.apply',
            },
          ],
        },
      });
    if (url.pathname === '/v1/tasks/task_ask/input')
      return send(409, {
        status: 'failed',
        error: {
          code: 'DECISION_CONFLICT',
          message: 'Response rejected: missing-request',
          details: { outcome: 'missing-request' },
        },
      });
    if (url.pathname === '/v1/tasks/task_done/status')
      return send(200, {
        data: {
          taskId: 'task_done',
          phase: 'running',
          inputRevisionId: 'inrev_1',
          pendingInputs: [
            {
              requestId: 'pin_1',
              inputRevisionId: 'inrev_1',
              status: 'open',
              kind: 'clarification',
              question: 'which build?',
            },
          ],
        },
      });
    if (url.pathname === '/v1/tasks/task_done/input')
      return send(409, {
        status: 'failed',
        error: {
          code: 'DECISION_CONFLICT',
          message: 'Response rejected: already-answered',
          details: { outcome: 'already-answered' },
        },
      });
    if (url.pathname === '/v1/tasks' && url.searchParams.get('view') === 'page')
      return send(200, {
        data: {
          total: 1,
          items: [
            {
              taskId: 'task_ask',
              phase: 'waiting-review',
              title: 'approve skill pack',
            },
          ],
          cursor: null,
        },
      });
    if (url.pathname === '/v1/tasks/task_ask/approvals')
      return send(200, {
        data: [{ approvalId: 'apr_9', status: 'open' }],
      });
    if (url.pathname === '/v1/admin/audit')
      return send(200, {
        data: [
          {
            id: 4,
            principalId: 'prn_approver',
            scopeId: 'scp_lab',
            action: 'approval.decision',
            detail: { approvalId: 'apr_9', outcome: 'approved' },
            createdAt: '2026-10-16T00:00:00.000Z',
          },
        ],
      });
    if (url.pathname === '/v1/skillpacks')
      return send(200, {
        data: [
          {
            skillPackId: 'skp_1',
            manifest: { id: 'mindmap-compile', version: '0.1.0' },
            status: 'registered',
            lifecycle: 'approved',
            statusLabel: 'approved',
            assetId: 'ast_pack',
            approvalTaskId: 'task_ask',
          },
          {
            skillPackId: 'skp_old',
            manifest: { id: 'old-pack', version: '0.1.0' },
            status: 'registered',
            assetId: 'ast_pack',
          },
        ],
      });
    if (url.pathname === '/v1/assets/ast_pack')
      return send(200, {
        data: { assetId: 'ast_pack', lifecycle: 'approved' },
      });
    if (url.pathname === '/v1/assets' && url.searchParams.get('kind'))
      return send(200, { data: { items: [], total: 0 } });
    send(404, {
      status: 'failed',
      error: { code: 'TARGET_NOT_FOUND', message: 'missing' },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const port = (server.address() as AddressInfo).port;
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    secret: async (request) => submitAnswer(home, request.id, PASSWORD),
  }).load();
  cleanup(t, () => host.close());
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  const command = host.commands().get('hub')!;
  await command.handler(`login http://127.0.0.1:${port} tester`, context);
  await assert.rejects(
    async () => command.handler('respond task_ask yes', context),
    /waiting for a decision[\s\S]*\/hub approve task_ask apr_9/,
  );
  await assert.rejects(
    async () => command.handler('respond task_done 1.0', context),
    /already has a decision[\s\S]*already-answered[\s\S]*\/hub task/,
  );
  await command.handler('review', context);
  assert.match(
    lines.at(-1)!,
    /task_ask · waiting-review[\s\S]*\/hub approve task_ask apr_9/,
  );
  await command.handler('audit', context);
  assert.match(lines.at(-1)!, /approval\.decision · prn_approver · scp_lab/);
  await command.handler('modules', context);
  assert.match(
    lines.at(-1)!,
    /skp_1 · mindmap-compile 0\.1\.0 · approved · lifecycle approved[\s\S]*skp_old · old-pack 0\.1\.0 · approved \(server status registered\)/,
  );
});

test('inbox, a content view and a rejection reason use the general approval route when the server has it', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const posts: { path: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const body = await read(request);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'POST')
      posts.push({ path: url.pathname, body: body.toString() });
    if (url.pathname === '/v1/auth/dev-login')
      return send(200, {
        data: { token: TOKEN, tokenType: 'Bearer', scopes: ['scp_lab'] },
      });
    if (request.headers.authorization !== `Bearer ${TOKEN}`)
      return send(401, {
        status: 'failed',
        error: { code: 'UNAUTHENTICATED', message: 'expired' },
      });
    if (url.pathname === '/v1/status')
      return send(200, { data: { apiVersion: '1.0.0' } });
    if (url.pathname === '/v1/tools') return send(200, { data: [] });
    if (url.pathname === '/v1/approvals/pending')
      return send(200, {
        data: [
          {
            kind: 'governance',
            requestId: 'aprq_1',
            title: 'export the register',
          },
          {
            kind: 'change-set',
            requestId: 'apr_9',
            taskId: 'task_ask',
            approvalId: 'apr_9',
            asset: { name: 'mindmap', kind: 'skill-package' },
          },
        ],
      });
    if (url.pathname === '/v1/approval-requests/aprq_1')
      return send(200, {
        data: {
          requestId: 'aprq_1',
          status: 'open',
          title: 'export the register',
        },
      });
    if (url.pathname === '/v1/approval-requests/aprq_1/content') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('the register itself');
      return;
    }
    if (url.pathname === '/v1/approval-requests/aprq_1/decisions')
      return send(200, {
        data: {
          requestId: 'aprq_1',
          status: body.toString().includes('"approve":false')
            ? 'declined'
            : 'approved',
        },
      });
    if (url.pathname === '/v1/tasks/task_ask/status')
      return send(200, {
        data: {
          taskId: 'task_ask',
          phase: 'waiting-review',
          title: 'approve skill pack',
          inputRevisionId: 'inrev_1',
          pendingInputs: [
            {
              requestId: 'pin_decision',
              inputRevisionId: 'inrev_1',
              status: 'open',
              kind: 'decision',
            },
          ],
        },
      });
    if (url.pathname === '/v1/tasks/task_ask/approvals')
      return send(200, {
        data: [
          {
            approvalId: 'apr_9',
            status: 'open',
            inputRevisionId: 'inrev_1',
            targetIdentity: 'SHA256:target',
            actionDigest: 'd'.repeat(64),
            action: { name: 'changesets.apply', target: 'ast_pack' },
          },
        ],
      });
    if (url.pathname === '/v1/tasks/task_ask/approvals/apr_9')
      return send(200, { data: { status: 'declined' } });
    if (url.pathname === '/v1/tasks/task_ask/input')
      return send(409, {
        status: 'failed',
        error: { code: 'DECISION_CONFLICT', message: 'should not be posted' },
      });
    if (url.pathname === '/v1/skillpacks') return send(200, { data: [] });
    send(404, {
      status: 'failed',
      error: { code: 'TARGET_NOT_FOUND', message: 'missing' },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const port = (server.address() as AddressInfo).port;
  const prompts: string[] = [];
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    secret: async (request) => {
      prompts.push(`${request.mask ? 'masked' : 'open'}:${request.question}`);
      await submitAnswer(
        home,
        request.id,
        request.mask === false ? 'ada' : PASSWORD,
      );
    },
  }).load();
  cleanup(t, () => host.close());
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  const command = host.commands().get('hub')!;
  await command.handler(`login http://127.0.0.1:${port}`, context);
  assert.match(prompts.join('\n'), /open:User on http:\/\/127\.0\.0\.1:\d+/);
  assert.match(prompts.join('\n'), /masked:Password for ada/);
  assert.match(
    lines.join('\n'),
    /signed in to http:\/\/127\.0\.0\.1:\d+ as ada/,
  );
  await command.handler('approve', context);
  assert.match(
    lines.at(-1)!,
    /governance aprq_1 · export the register[\s\S]*\/hub show aprq_1[\s\S]*\/hub approve aprq_1[\s\S]*change-set task_ask · apr_9 · mindmap/,
  );
  await command.handler('show 1', context);
  assert.match(
    lines.slice(-4).join('\n'),
    /the register itself[\s\S]*\/hub approve aprq_1/,
  );
  await assert.rejects(
    async () => command.handler('reject aprq_1', context),
    /a rejection needs a reason/,
  );
  assert.equal(
    posts.some((post) => post.path.endsWith('/decisions')),
    false,
  );
  await command.handler('reject aprq_1 out of scope', context);
  assert.match(lines.at(-1)!, /rejected aprq_1 · declined · out of scope/);
  assert.deepEqual(
    JSON.parse(posts.find((post) => post.path.endsWith('/decisions'))!.body),
    { approve: false, reason: 'out of scope' },
  );
  await command.handler('approve aprq_1', context);
  const approved = posts.filter((post) => post.path.endsWith('/decisions'));
  assert.deepEqual(JSON.parse(approved.at(-1)!.body), { approve: true });
  await assert.rejects(
    async () => command.handler('respond task_ask yes', context),
    /not waiting for a text answer \(decision\)/,
  );
  assert.equal(
    posts.some((post) => post.path.endsWith('/input')),
    false,
  );
  await assert.rejects(
    async () => command.handler('reject task_ask apr_9', context),
    /a rejection needs a reason: \/hub reject task_ask apr_9/,
  );
  await command.handler('reject task_ask apr_9 need more material', context);
  const classic = JSON.parse(
    posts.find((post) => post.path.endsWith('/approvals/apr_9'))!.body,
  );
  assert.equal(classic.approve, false);
  assert.equal(classic.reason, 'need more material');
  assert.match(lines.at(-1)!, /rejected apr_9 for task_ask/);
});
