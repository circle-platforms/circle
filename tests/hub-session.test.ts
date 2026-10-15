import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtensionHost, bundledExtensionsRoot } from '../src/extensions.js';
import { submitAnswer } from '../src/secret_prompt.js';

const PASSWORD = 'pw-session-8812-kk';
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

// A stand-in server whose tokens run out: a login lasts `ttlMs`, POST /v1/auth/refresh
// issues a new token and the old one dies five seconds later (or is missing, as on an
// older server), and expire() turns every token down.
async function sessionServer(t: Parameters<typeof scratch>[0]) {
  const state = {
    ttlMs: 3_600_000,
    refreshRoute: true,
    refuseWithDetails: false,
    holdEvents: false,
    releaseEvents: undefined as (() => void) | undefined,
  };
  const expiries = new Map<string, number>();
  const counts = {
    logins: 0,
    refreshes: 0,
    missingRefresh: 0,
    toolCalls: 0,
    events: 0,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const text = (await read(request)).toString();
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const fail = (status: number, code: string) =>
      send(status, { status: 'failed', error: { code, message: code } });
    const issued = (token: string, ttl: number) => {
      expiries.set(token, Date.now() + ttl);
      return {
        token,
        tokenType: 'Bearer',
        expiresAt: new Date(Date.now() + ttl).toISOString(),
        principalId: 'prn_tester',
        tenantId: 'tnt_x',
        scopes: ['scp_lab'],
      };
    };
    if (url.pathname === '/v1/auth/dev-login') {
      if (JSON.parse(text).password !== PASSWORD) return fail(401, 'BAD');
      counts.logins++;
      return send(200, {
        data: issued(`tok-session-${counts.logins}`, state.ttlMs),
      });
    }
    const token = String(request.headers.authorization).replace(/^Bearer /, '');
    const valid = (expiries.get(token) ?? 0) > Date.now();
    if (url.pathname === '/v1/auth/refresh') {
      if (!state.refreshRoute) {
        counts.missingRefresh++;
        return fail(404, 'TARGET_NOT_FOUND');
      }
      if (!valid) return fail(401, 'UNAUTHENTICATED');
      counts.refreshes++;
      // The hub rotates the token: a fresh one, and the old one dies five seconds later.
      expiries.set(token, Date.now() + 5_000);
      return send(200, {
        data: issued(
          `tok-session-${counts.logins}-r${counts.refreshes}`,
          3_600_000,
        ),
      });
    }
    if (!valid) return fail(401, 'UNAUTHENTICATED');
    if (url.pathname === '/v1/status')
      return send(200, { data: { apiVersion: '1.0.0' } });
    if (url.pathname === '/v1/tools')
      return send(200, {
        data: [
          {
            name: 'docs.list',
            description: 'Documents in a folder.',
            inputSchema: { type: 'object', properties: {} },
            effect: 'read',
            mode: 'sync',
          },
        ],
      });
    if (url.pathname === '/v1/tools/docs.list/call') {
      counts.toolCalls++;
      if (state.refuseWithDetails)
        return send(422, {
          status: 'failed',
          error: {
            code: 'SKILLPACK_CHECK_FAILED',
            message: 'Skill tools do not match the declared accessible catalog',
            details: {
              check: {
                undeclaredTools: ['env.framework_files'],
                missingTools: [],
              },
            },
          },
        });
      return send(200, { data: { result: { entries: ['a.md'] } } });
    }
    if (url.pathname === '/v1/tasks/task_x/status')
      return send(200, { data: { taskId: 'task_x', phase: 'failed' } });
    if (url.pathname === '/v1/tasks/task_x/result')
      return send(200, {
        status: 'failed',
        data: {
          taskId: 'task_x',
          status: 'failed',
          error: {
            code: 'SOURCE_FORBIDDEN',
            message: 'Knowledge record is not available to this identity',
          },
        },
      });
    if (url.pathname === '/v1/tasks/task_f/status')
      return send(200, { data: { taskId: 'task_f', phase: 'running' } });
    if (url.pathname === '/v1/tasks/task_f/events') {
      counts.events++;
      if (state.holdEvents)
        await new Promise<void>((resolve) => {
          state.releaseEvents = resolve;
        });
      else await delay(50);
      // The poll's token may have died while the poll was open: check it again now.
      if ((expiries.get(token) ?? 0) <= Date.now())
        return fail(401, 'UNAUTHENTICATED');
      return send(200, { data: { events: [] } });
    }
    if (url.pathname === '/v1/assets')
      return send(200, { data: { items: [] } });
    if (['/v1/tasks', '/v1/packs', '/v1/skillpacks'].includes(url.pathname))
      return send(200, { data: [] });
    fail(404, 'TARGET_NOT_FOUND');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    counts,
    expire: () => expiries.clear(),
    // Rotation grace has elapsed: every token but the newest one is dead.
    expireStale: () => {
      let newest = 0;
      for (const at of expiries.values()) newest = Math.max(newest, at);
      for (const [tok, at] of expiries) if (at < newest) expiries.delete(tok);
    },
  };
}

async function connect(t: Parameters<typeof scratch>[0]) {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
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
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
  };
  const command = host.commands().get('hub')!;
  const config = () =>
    JSON.parse(
      readFileSync(join(home, 'extension_data', 'hub', 'config.json'), 'utf8'),
    );
  return {
    host,
    home,
    prompts,
    lines,
    config,
    run: async (args: string) => command.handler(args, context),
  };
}

test('a sign-in close to running out is renewed at the server without asking, and its new end is kept', async (t) => {
  const server = await sessionServer(t);
  server.state.ttlMs = 3_000;
  const session = await connect(t);
  await session.run(`login ${server.url} tester`);
  await until(() => server.counts.refreshes >= 1);
  assert.ok(
    Date.parse(session.config().expiresAt) > Date.now() + 30 * 60_000,
    'the renewed end is remembered',
  );
  const renewed = server.counts.refreshes;
  await session.run('packs');
  assert.equal(server.counts.refreshes, renewed, 'no renewal while far off');
  assert.equal(session.prompts.length, 1, 'only signing in asked');
});

test('an older server without the renewal route is asked once and then left alone', async (t) => {
  const server = await sessionServer(t);
  server.state.ttlMs = 3_000;
  server.state.refreshRoute = false;
  const session = await connect(t);
  await session.run(`login ${server.url} tester`);
  await session.run('packs');
  await session.run('packs');
  assert.equal(server.counts.missingRefresh, 1);
  assert.equal(session.prompts.length, 1);
});

test('a model tool call and a followed task that meet an expired sign-in say so and ask for nothing', async (t) => {
  const server = await sessionServer(t);
  const session = await connect(t);
  await session.run(`login ${server.url} tester`);
  await session.run('task task_f');
  await delay(150);
  server.expire();

  const tool = session.host
    .tools()
    .find((item) => item.name === 'hub_tool_docs_list')!;
  const run = { signal: new AbortController().signal, sessionId: 's' } as never;
  const answer = await session.host
    .toolBoundary({ tool, args: {}, context: run }, (request) =>
      tool.run(request.args, request.context),
    )
    .then(
      (value) => JSON.stringify(value),
      (error) => String(error),
    );
  assert.match(
    answer,
    /signed out: the sign-in has expired · \/hub login http:\/\/127\.0\.0\.1:\d+ tester/,
  );
  await until(() => session.lines.some((line) => /✖ task_f:/.test(line)));
  assert.match(
    session.lines.find((line) => /✖ task_f:/.test(line))!,
    /✖ task_f: signed out: the sign-in has expired · \/hub login .* · \/hub task task_f picks it up again/,
  );
  assert.equal(
    session.prompts.length,
    1,
    'no password card in the middle of work',
  );
  await delay(100);
});

test('a refusal reaches the model with what the server named besides its message', async (t) => {
  const server = await sessionServer(t);
  server.state.refuseWithDetails = true;
  const session = await connect(t);
  await session.run(`login ${server.url} tester`);
  const tool = session.host
    .tools()
    .find((item) => item.name === 'hub_tool_docs_list')!;
  const run = { signal: new AbortController().signal, sessionId: 's' } as never;
  const answer = await session.host
    .toolBoundary({ tool, args: {}, context: run }, (request) =>
      tool.run(request.args, request.context),
    )
    .then(
      (value) => JSON.stringify(value),
      (error) => String(error),
    );
  assert.match(answer, /SKILLPACK_CHECK_FAILED: Skill tools do not match/);
  assert.match(answer, /"undeclaredTools":\["env\.framework_files"\]/);
});

test('a task that ended failed is shown with its own error, not as a failed request', async (t) => {
  const server = await sessionServer(t);
  const session = await connect(t);
  await session.run(`login ${server.url} tester`);
  const tool = session.host.tools().find((item) => item.name === 'hub_task')!;
  const run = { signal: new AbortController().signal, sessionId: 's' } as never;
  const answer = JSON.stringify(await tool.run({ task_id: 'task_x' }, run));
  assert.match(answer, /SOURCE_FORBIDDEN/);
  assert.match(answer, /Knowledge record is not available to this identity/);
  assert.doesNotMatch(answer, /request failed/);
});

test('a long poll that meets a 401 after the token rotated retries once on the current token', async (t) => {
  const server = await sessionServer(t);
  const session = await connect(t);
  await session.run(`login ${server.url} tester`);
  server.state.holdEvents = true;
  await session.run('task task_f');
  await until(() => server.counts.events >= 1, 5000); // the poll is open on the old token
  // The next request notices the session is due and refreshes: the hub rotates the token.
  writeFileSync(
    join(session.home, 'extension_data', 'hub', 'config.json'),
    JSON.stringify({
      ...session.config(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  );
  await session.run('packs');
  assert.equal(server.counts.refreshes, 1, 'the expired-soon session rotated');
  server.expireStale(); // the old token's five-second grace has elapsed
  server.state.holdEvents = false;
  server.state.releaseEvents!();
  await until(() => server.counts.events >= 2, 5000); // retried once, on the new token
  await delay(100);
  assert.ok(
    !session.lines.some((line) => /signed out/.test(line)),
    'a rotated poll is not a sign-out',
  );
});
