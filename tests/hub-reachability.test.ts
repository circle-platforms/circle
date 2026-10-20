import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtensionHost, bundledExtensionsRoot } from '../src/extensions.js';
import { cleanup, scratch } from './helpers.js';

async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out');
    await delay(10);
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    );
  });
}

test('the hub footer and /hub follow a server that is down or a sign-in that expired', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  let refuse = false;
  const server = createServer((request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/v1/auth/dev-login')
      return send(200, {
        data: { token: 'tok-hub', tokenType: 'Bearer', scopes: ['scp_lab'] },
      });
    if (refuse)
      return send(401, {
        status: 'failed',
        error: { code: 'UNAUTHENTICATED', message: 'expired' },
      });
    if (url.pathname === '/v1/status')
      return send(200, { data: { apiVersion: '1.0.0' } });
    if (url.pathname === '/v1/packs') return send(200, { data: [] });
    send(404, { status: 'failed', error: { code: 'TARGET_NOT_FOUND' } });
  });
  const port = await listen(server);
  cleanup(
    t,
    () =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      }),
  );
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
    secret: 'pw',
  };
  const command = host.commands().get('hub')!;
  await command.handler(`login http://127.0.0.1:${port} tester`, context);
  await until(() =>
    host
      .statuses()
      .some(
        (item) =>
          item.extension === 'hub' &&
          item.lamp === 'ok' &&
          item.text.includes('tester@'),
      ),
  );

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await assert.rejects(
    async () => command.handler('packs', context),
    /cannot reach the server|无法连接/,
  );
  await until(() =>
    host
      .statuses()
      .some((item) => item.extension === 'hub' && item.lamp === 'error'),
  );
  const down = host.statuses().find((item) => item.extension === 'hub')!;
  assert.match(down.text, /cannot reach/);
  await command.handler('', context);
  assert.match(lines.at(-1)!, /^● /);
  assert.match(lines.at(-1)!, /cannot reach/);

  const again = createServer((request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/v1/auth/dev-login')
      return send(200, {
        data: { token: 'tok-next', tokenType: 'Bearer', scopes: ['scp_lab'] },
      });
    if (refuse)
      return send(401, {
        status: 'failed',
        error: { code: 'UNAUTHENTICATED', message: 'expired' },
      });
    if (url.pathname === '/v1/status')
      return send(200, { data: { apiVersion: '1.0.0' } });
    send(200, { data: [] });
  });
  const next = await listen(again);
  cleanup(
    t,
    () => new Promise<void>((resolve) => again.close(() => resolve())),
  );
  await command.handler(`login http://127.0.0.1:${next} tester`, context);
  await until(() =>
    host
      .statuses()
      .some(
        (item) =>
          item.extension === 'hub' &&
          item.lamp === 'ok' &&
          item.text.includes(`127.0.0.1:${next}`),
      ),
  );
  refuse = true;
  await assert.rejects(
    async () => command.handler('packs', context),
    /expired|登录已过期/,
  );
  await until(() =>
    host
      .statuses()
      .some(
        (item) =>
          item.extension === 'hub' &&
          item.lamp === 'wait' &&
          item.text.includes('sign-in expired'),
      ),
  );
  await command.handler('help', context);
  assert.match(lines.at(-1)!, /^● /);
  assert.match(lines.at(-1)!, /sign-in expired/);
});
