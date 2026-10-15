import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ExtensionHost,
  bundledExtensionsRoot,
  type ExtensionStatus,
} from '../src/extensions.js';
import { ExtensionSecrets } from '../src/extension_secrets.js';
import { submitAnswer } from '../src/secret_prompt.js';

const PASSWORD = 'pw-bots-3317-zz';
const PEOPLE: Record<string, string> = {
  developer: 'prn_dev',
  approver: 'prn_apr',
};
async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// A stand-in server with the automation routes: triggers and bots are assets that someone
// other than the owner approves and the owner turns on; a bot's runs publish bot.output.
async function botServer(t: Parameters<typeof scratch>[0]) {
  const assets = new Map<string, Record<string, any>>();
  const posted: { path: string; body: Record<string, any>; by: string }[] = [];
  // Each sign-in gets a new token; expire() turns down every token given so far.
  const tokens = new Map<string, string>();
  const taskQueries: string[] = [];
  let unauthorizedGate:
    { requested: () => void; response: Promise<void> } | undefined;
  let issued = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const text = (await read(request)).toString();
    const body = text ? JSON.parse(text) : {};
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const fail = (status: number, code: string, message = code) =>
      send(status, { status: 'failed', error: { code, message } });
    if (url.pathname === '/v1/auth/dev-login') {
      const principalId = PEOPLE[body.username];
      if (!principalId || body.password !== PASSWORD) return fail(401, 'BAD');
      const token = `tok-bots-${++issued}-5e19`;
      tokens.set(token, principalId);
      return send(200, { data: { token, principalId, scopes: ['scp_lab'] } });
    }
    const principalId = tokens.get(
      String(request.headers.authorization).replace(/^Bearer /, ''),
    );
    if (!principalId) {
      const gate = unauthorizedGate;
      unauthorizedGate = undefined;
      gate?.requested();
      await gate?.response;
      return fail(401, 'UNAUTHENTICATED');
    }
    const caller = { principalId };
    if (request.method === 'POST')
      posted.push({ path: url.pathname, body, by: caller.principalId });
    if (url.pathname === '/v1/status')
      return send(200, { data: { apiVersion: '1.0.0' } });
    if (url.pathname === '/v1/skillpacks')
      return send(200, {
        data: [{ skillPackId: 'skp_1', manifest: { id: 'nightly-compile' } }],
      });
    const make = (id: string, kind: string) => {
      const item = {
        assetId: id,
        kind,
        name: body.name,
        version: body.version,
        sha256: createHash('sha256').update(text).digest('hex'),
        lifecycle: 'draft',
        ownerPrincipalId: caller.principalId,
        configuration: body,
      };
      assets.set(id, item);
      return send(201, { data: item });
    };
    if (url.pathname === '/v1/automations/triggers')
      return make('ast_trigger', 'trigger');
    if (url.pathname === '/v1/automations/bots') return make('ast_bot', 'bot');
    if (url.pathname === '/v1/assets')
      return send(200, {
        data: {
          items: [...assets.values()].filter(
            (item) => item.kind === url.searchParams.get('kind'),
          ),
        },
      });
    const assetRoute = /^\/v1\/assets\/([^/]+)(\/lifecycle)?$/.exec(
      url.pathname,
    );
    if (assetRoute) {
      const item = assets.get(assetRoute[1]!);
      if (!item) return fail(404, 'ASSET_NOT_VISIBLE');
      if (!assetRoute[2]) return send(200, { data: item });
      if (body.version !== item.version || body.sha256 !== item.sha256)
        return fail(409, 'APPROVAL_STALE');
      if (body.state === 'approved') {
        if (item.ownerPrincipalId === caller.principalId)
          return fail(403, 'SELF_APPROVAL');
        if (item.lifecycle !== 'draft') return fail(409, 'DECISION_CONFLICT');
      } else {
        if (item.ownerPrincipalId !== caller.principalId)
          return fail(403, 'FORBIDDEN_ACTION');
        if (body.state === 'running' && item.lifecycle === 'draft')
          return fail(409, 'APPROVAL_REQUIRED');
      }
      item.lifecycle = body.state;
      return send(200, { data: item });
    }
    if (url.pathname === '/v1/automations/bots/ast_bot/runs')
      return caller.principalId === 'prn_dev'
        ? send(
            200,
            assets.get('ast_bot')?.lifecycle === 'draft'
              ? { data: [] }
              : {
                  data: [
                    {
                      taskId: 'task_b1',
                      occurrenceKey: 'schedule:2026-10-12T00:00:00.000Z',
                      channel: 'circle-events',
                      published: true,
                      status: 'admitted',
                      trigger: {
                        kind: 'schedule',
                        firstDueAt: '2026-10-11T22:00:00.000Z',
                        dueAt: '2026-10-12T00:00:00.000Z',
                        skippedOccurrences: 2,
                      },
                      error: null,
                    },
                    {
                      taskId: null,
                      occurrenceKey: 'schedule:2026-10-12T01:00:00.000Z',
                      channel: 'circle-events',
                      published: false,
                      status: 'failed',
                      trigger: { kind: 'schedule', skippedOccurrences: 0 },
                      error: {
                        code: 'APPROVAL_STALE',
                        message: 'Package asset revision is no longer approved',
                      },
                    },
                    {
                      taskId: 'task_b2',
                      occurrenceKey: 'schedule:2026-10-12T02:00:00.000Z',
                      channel: 'circle-events',
                      published: false,
                      status: 'admitted',
                      trigger: { kind: 'schedule', skippedOccurrences: 0 },
                      error: null,
                    },
                  ],
                },
          )
        : fail(403, 'SOURCE_FORBIDDEN');
    if (url.pathname === '/v1/tasks/task_b1/events')
      return send(200, {
        data: {
          events: [
            { seq: 1, taskId: 'task_b1', kind: 'task.delivered', payload: {} },
            {
              seq: 2,
              taskId: 'task_b1',
              kind: 'bot.output',
              payload: {
                channel: 'circle-events',
                botAssetId: 'ast_bot',
                status: 'succeeded',
                artifacts: [
                  {
                    artifactId: 'art_1',
                    fileName: 'out/case.xlsx',
                    sha256: 'c'.repeat(64),
                  },
                ],
                evidence: [],
                unknowns: [],
              },
            },
          ],
        },
      });
    if (url.pathname === '/v1/tasks/task_b2/status')
      return send(200, { data: { taskId: 'task_b2', phase: 'running' } });
    // Tool calls and the indexing of what they read are tasks too. This server ignores the
    // kind filter, as one from before it did, and sends every task.
    if (url.pathname === '/v1/tasks') taskQueries.push(url.search);
    if (url.pathname === '/v1/tasks')
      return send(200, {
        data: [
          {
            taskId: 'task_tool',
            capabilityPackId: 'asset-tool',
            phase: 'delivered',
          },
          {
            taskId: 'task_index',
            capabilityPackId: 'asset-index',
            phase: 'running',
          },
        ],
      });
    if (['/v1/packs', '/v1/tools'].includes(url.pathname))
      return send(200, { data: [] });
    fail(404, 'TARGET_NOT_FOUND');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    assets,
    posted,
    expire: () => tokens.clear(),
    pauseNextUnauthorized() {
      let requested!: () => void;
      let release!: () => void;
      const request = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const response = new Promise<void>((resolve) => {
        release = resolve;
      });
      unauthorizedGate = { requested, response };
      cleanup(t, release);
      return {
        async waitForRequest() {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              request,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new Error('hub did not request the expired sign-in'),
                    ),
                  10_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
        },
        release,
      };
    },
    taskQueries,
  };
}

async function person(
  t: Parameters<typeof scratch>[0],
  root: string,
  name: string,
  workspace: string,
): Promise<{
  host: ExtensionHost;
  run: (args: string) => Promise<void>;
  lines: string[];
  waitForStatus: (expected: ExtensionStatus[]) => Promise<void>;
}> {
  const home = join(root, name);
  const statusWaiters = new Set<() => void>();
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
    onStatus: () => {
      for (const changed of statusWaiters) changed();
    },
    secret: async (request) => {
      await submitAnswer(home, request.id, PASSWORD);
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
  return {
    host,
    run: async (args) => command.handler(args, context),
    lines,
    waitForStatus: (expected) =>
      new Promise<void>((resolve, reject) => {
        const changed = () => {
          if (!isDeepStrictEqual(host.statuses(), expected)) return;
          clearTimeout(timeout);
          statusWaiters.delete(changed);
          resolve();
        };
        const timeout = setTimeout(() => {
          statusWaiters.delete(changed);
          reject(
            new Error(
              `hub status did not become ${JSON.stringify(expected)}; got ${JSON.stringify(host.statuses())}`,
            ),
          );
        }, 10_000);
        statusWaiters.add(changed);
        changed();
      }),
  };
}

test('a bot is made from Circle as a schedule and a skill pack, approved by someone else, turned on by its owner, and its published runs come back to Circle', async (t) => {
  const root = scratch(t);
  const workspace = join(root, 'project');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'mindmap.json'), '[{"data":{}}]');
  const server = await botServer(t);
  const dev = await person(t, root, 'dev-home', workspace);
  await dev.run(`login ${server.url} developer`);

  await dev.run(
    'bot every skp_1 1h --from 2026-10-12T00:00:00Z --inputs {"versionLine": "10.5"} --file mindmap.json',
  );
  const [trigger, made] = server.posted.slice(-2);
  assert.equal(trigger!.path, '/v1/automations/triggers');
  assert.deepEqual(trigger!.body, {
    scopeId: 'scp_lab',
    version: '1.0.0',
    name: 'nightly-compile every 1h',
    kind: 'schedule',
    intervalMs: 3_600_000,
    startsAt: '2026-10-12T00:00:00.000Z',
  });
  assert.equal(made!.path, '/v1/automations/bots');
  assert.equal(made!.body.skillPackId, 'skp_1');
  assert.equal(made!.body.triggerAssetId, 'ast_trigger');
  assert.equal(
    made!.body.identityPrincipalId,
    'prn_dev',
    'the bot runs as the person who signed in',
  );
  assert.equal(made!.body.channel, 'circle-events');
  assert.equal(made!.body.inputs.versionLine, '10.5');
  assert.deepEqual(
    made!.body.inputs.files.map((file: { path: string }) => file.path),
    ['mindmap.json'],
  );
  assert.ok(
    dev.lines.some((line) =>
      /✓ bot ast_bot · nightly-compile every 1h · runs skp_1 every 1h from 2026-10-12T00:00:00\.000Z as you · output to Circle · draft/.test(
        line,
      ),
    ),
  );

  // Its owner cannot turn it on before someone else approved it.
  await assert.rejects(
    dev.run('bot start ast_bot'),
    /trigger ast_trigger is draft; someone else approves it first: \/hub bot approve ast_bot/,
  );
  const approver = await person(t, root, 'approver-home', workspace);
  await approver.run(`login ${server.url} approver`);
  await approver.run('bot approve ast_bot');
  const approvals = server.posted.filter(
    (item) => item.path.endsWith('/lifecycle') && item.by === 'prn_apr',
  );
  assert.deepEqual(
    approvals.map((item) => [item.path, item.body.state]),
    [
      ['/v1/assets/ast_trigger/lifecycle', 'approved'],
      ['/v1/assets/ast_bot/lifecycle', 'approved'],
    ],
    'the trigger and the bot, each bound to its version and digest',
  );
  assert.equal(approvals[1]!.body.sha256, server.assets.get('ast_bot')!.sha256);

  await dev.run('bot start ast_bot');
  assert.equal(server.assets.get('ast_trigger')!.lifecycle, 'running');
  assert.equal(server.assets.get('ast_bot')!.lifecycle, 'running');
  assert.ok(
    dev.lines.some((line) =>
      /ast_bot runs every 1h from 2026-10-12T00:00:00\.000Z; its results come to Circle: \/hub bot runs ast_bot/.test(
        line,
      ),
    ),
  );

  await dev.run('bot list');
  assert.match(
    dev.lines.at(-1)!,
    /ast_bot · nightly-compile every 1h · running · every 1h from 2026-10-12T00:00:00\.000Z \(trigger running\) · 3 run\(s\), 2 new: \/hub bot runs ast_bot/,
  );
  // The desktop's methods page reads the same bots from the extension's view.
  await dev.run('refresh');
  const objects = (dev.host.view('hub') as Record<string, any>).objects;
  assert.deepEqual(objects.work, [], 'tool calls and indexing are not work');
  assert.deepEqual([...new Set(server.taskQueries)].sort(), [
    '?kind=index&limit=100',
    '?kind=tool&limit=100',
    '?kind=work&limit=20',
  ]);
  assert.deepEqual(objects.background, {
    toolReads: 1,
    indexing: 1,
    indexingOpen: 1,
  });
  assert.deepEqual(objects.bots, [
    {
      assetId: 'ast_bot',
      name: 'nightly-compile every 1h',
      lifecycle: 'running',
      trigger: 'every 1h from 2026-10-12T00:00:00.000Z',
      triggerLifecycle: 'running',
      mine: true,
      owner: 'prn_dev',
      runs: 3,
      fresh: 2,
    },
  ]);
  await approver.run('bot list');
  assert.match(
    approver.lines.at(-1)!,
    /ast_bot · .* · owner prn_dev$/,
    'someone else’s bot shows its owner, not its runs',
  );

  // A window opened later finds the published run and says so in the footer.
  const later = await person(t, root, 'dev-home', workspace);
  const where = `hub · developer@127.0.0.1:${new URL(server.url).port}`;
  await later.waitForStatus([
    { extension: 'hub', text: `${where} · 2 bot result(s)`, lamp: 'wait' },
  ]);
  assert.deepEqual(
    later.host
      .statuses()
      .filter((item) => item.extension === 'hub')
      .map((item) => [item.text, item.lamp]),
    [
      [
        'hub · developer@127.0.0.1:' +
          new URL(server.url).port +
          ' · 2 bot result(s)',
        'wait',
      ],
    ],
  );
  await later.run('bot runs ast_bot');
  assert.deepEqual(later.lines.slice(-4), [
    '  task_b1 · schedule:2026-10-12T00:00:00.000Z · succeeded · 1 file(s) · 2 missed occurrence(s) since 2026-10-11T22:00:00.000Z folded into this run · /hub get task_b1 saves them',
    `    out/case.xlsx · sha256 ${'c'.repeat(12)}…`,
    '  — · schedule:2026-10-12T01:00:00.000Z · not started: APPROVAL_STALE: Package asset revision is no longer approved',
    '  task_b2 · schedule:2026-10-12T02:00:00.000Z · running',
  ]);
  assert.equal(
    later.host.statuses().find((item) => item.extension === 'hub')?.lamp,
    'ok',
    'shown once, the result is no longer new',
  );

  // A token that runs out: the background look says so in the footer and asks nothing; a
  // command says to sign in again, and /hub login looks once more.
  server.expire();
  const unauthorized = server.pauseNextUnauthorized();
  const stale = await person(t, root, 'dev-home', workspace);
  await unauthorized.waitForRequest();
  // Stored credentials draw the initial footer while the server response is in flight.
  // Keep the actual 401 blocked until that state is observed: startup is asynchronous,
  // so a fixed sleep cannot establish that the background request has finished.
  await stale.waitForStatus([{ extension: 'hub', text: where, lamp: 'ok' }]);
  unauthorized.release();
  await stale.waitForStatus([
    { extension: 'hub', text: `${where} · sign-in expired`, lamp: 'wait' },
  ]);
  assert.deepEqual(
    stale.host
      .statuses()
      .filter((item) => item.extension === 'hub')
      .map((item) => [item.text.replace(/^.* · /, ''), item.lamp]),
    [['sign-in expired', 'wait']],
  );
  await assert.rejects(
    stale.run('bot list'),
    /signed out: the sign-in has expired · \/hub login http:\/\/127\.0\.0\.1:\d+ developer/,
  );
  await stale.run(`login ${server.url} developer`);
  await stale.waitForStatus([{ extension: 'hub', text: where, lamp: 'ok' }]);
  assert.equal(
    stale.host.statuses().find((item) => item.extension === 'hub')?.lamp,
    'ok',
  );

  await dev.run('bot stop ast_bot');
  assert.equal(server.assets.get('ast_bot')!.lifecycle, 'disabled');
  await assert.rejects(
    dev.run('bot every skp_1 soon'),
    /not an interval: soon/,
  );

  // The same skill pack on a connector's event instead of a schedule.
  await dev.run('bot on skp_1 ast_builds source.changed --name "new builds"');
  const [onEvent, eventBot] = server.posted.slice(-2);
  assert.deepEqual(onEvent!.body, {
    scopeId: 'scp_lab',
    version: '1.0.0',
    name: 'new builds',
    kind: 'event',
    sourceAssetId: 'ast_builds',
    eventName: 'source.changed',
  });
  assert.deepEqual(eventBot!.body.inputs, {});
  assert.match(
    dev.lines.at(-2)!,
    /runs skp_1 on source\.changed of ast_builds as you/,
  );
});

test('/hub refresh returns once the view shows what it read, however slowly the footer reads the sign-in', async (t) => {
  const root = scratch(t);
  const workspace = join(root, 'project');
  mkdirSync(workspace, { recursive: true });
  const server = await botServer(t);
  // The footer and the view are drawn after a read of the sign-in from the secrets file,
  // behind a lock other windows share. Slow those reads down, and not the ones the
  // command's own requests make.
  const get = ExtensionSecrets.prototype.get;
  let slowed = 0;
  t.mock.method(
    ExtensionSecrets.prototype,
    'get',
    async function (this: ExtensionSecrets, name: string) {
      const footer = /\bshowStatus\b/.test(new Error().stack ?? '');
      const value = await get.call(this, name);
      if (name === 'token' && footer) {
        slowed += 1;
        await delay(200);
      }
      return value;
    },
  );
  const dev = await person(t, root, 'dev-home', workspace);
  await dev.run(`login ${server.url} developer`);
  // Made after the sign-in read the objects, so only the refresh finds it.
  await dev.run('bot every skp_1 1h --from 2026-10-12T00:00:00Z');
  await dev.run('refresh');
  assert.ok(slowed > 0, 'the footer read the sign-in');
  const view = dev.host.view('hub') as Record<string, any> | undefined;
  assert.deepEqual(
    view?.objects?.bots?.map((item: { assetId: string }) => item.assetId),
    ['ast_bot'],
  );
});
