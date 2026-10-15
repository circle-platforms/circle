import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createServer as createHttp, request, type Server } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanup, cleanupServer, scratch } from './helpers.js';

function context() {
  const hooks: (() => void | Promise<void>)[] = [];
  return {
    after: (hook: () => void | Promise<void>) => hooks.push(hook),
    finish: async () => {
      for (const hook of hooks) await hook();
    },
  };
}

async function listen(
  server: Server | ReturnType<typeof createHttps>,
): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function close(
  server: Server | ReturnType<typeof createHttps>,
): Promise<void> {
  const closed = new Promise<void>((resolve, reject) =>
    server.close((error) =>
      error &&
      (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        ? reject(error)
        : resolve(),
    ),
  );
  server.closeAllConnections();
  await closed;
}

for (const protocol of ['http', 'https'] as const)
  test(`cleanup closes the owned ${protocol} listener and raw sockets after an earlier cleanup fails`, async () => {
    const t = context();
    const site = protocol === 'http' ? createHttp() : createHttps();
    const originalListeners = site.listenerCount('connection');
    cleanupServer(t, site);
    const port = await listen(site);
    const connected = once(site, 'connection');
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    const clientClosed = once(socket, 'close');
    await connected;
    const original = Error('earlier browser close failed');
    cleanup(t, () => {
      throw original;
    });
    try {
      await assert.rejects(t.finish(), (error) => {
        assert(error instanceof AggregateError);
        assert.deepEqual(error.errors, [original]);
        return true;
      });
      await clientClosed;
      assert.equal(site.listening, false);
      assert.equal(socket.destroyed, true);
      assert.equal(site.listenerCount('connection'), originalListeners);
    } finally {
      socket.destroy();
      await close(site);
    }
  });

test('server cleanup accepts an already closed listener and does not affect another server', async () => {
  const t = context();
  const owned = createHttp();
  const other = createHttp();
  cleanupServer(t, owned);
  await listen(owned);
  const otherPort = await listen(other);
  const connected = once(other, 'connection');
  const otherSocket = createConnection({ host: '127.0.0.1', port: otherPort });
  otherSocket.on('error', () => {});
  await connected;
  await close(owned);
  try {
    await t.finish();
    assert.equal(owned.listening, false);
    assert.equal(other.listening, true);
    assert.equal(otherSocket.destroyed, false);
  } finally {
    otherSocket.destroy();
    await close(other);
  }
});

test('an unknown server close error remains the same failure while owned connections are still disposed', async (t) => {
  const hooks = context();
  const site = createHttp();
  const originalListeners = site.listenerCount('connection');
  cleanupServer(hooks, site);
  const port = await listen(site);
  const connected = once(site, 'connection');
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  const clientClosed = once(socket, 'close');
  await connected;
  const original = Error('unknown server close refusal');
  const stopped = t.mock.method(site, 'close', () => {
    throw original;
  });
  try {
    await assert.rejects(hooks.finish(), (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [original]);
      return true;
    });
    await clientClosed;
    assert.equal(socket.destroyed, true);
    assert.equal(site.listenerCount('connection'), originalListeners);
  } finally {
    stopped.mock.restore();
    socket.destroy();
    await close(site);
  }
});

test('an undefined connection-disposal failure is retained while the listener actually closes', async (t) => {
  const hooks = context();
  const site = createHttp();
  cleanupServer(hooks, site);
  await listen(site);
  const refused = t.mock.method(site, 'closeAllConnections', () => {
    throw undefined;
  });
  try {
    await assert.rejects(hooks.finish(), (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [undefined]);
      return true;
    });
    assert.equal(site.listening, false);
  } finally {
    refused.mock.restore();
    await close(site);
  }
});

async function exchange(port: number, path = '/', method = 'GET') {
  return new Promise<{ status?: number; body?: string; error?: string }>(
    (resolve) => {
      const operation = request(
        { host: '127.0.0.1', port, path, method, agent: false },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode, body }),
          );
        },
      );
      operation.setTimeout(1000, () =>
        operation.destroy(Error('owned loopback request timed out')),
      );
      operation.on('error', (error: NodeJS.ErrnoException) =>
        resolve({ error: error.code ?? error.message }),
      );
      operation.end();
    },
  );
}

test('the Node reporter remains red and exits naturally after all owned servers close', async (t) => {
  const root = scratch(t);
  const file = join(root, 'server-cleanup-report.test.mjs');
  const module = new URL('./helpers.ts', import.meta.url).href;
  writeFileSync(
    file,
    `
import { test } from 'node:test';
import { createServer } from 'node:http';
import { cleanup, cleanupServer, scratch } from ${JSON.stringify(module)};
test('an earlier cleanup failure must not leak the later server', async t => {
  scratch(t);
  const nonce = crypto.randomUUID();
  const site = createServer((req,res) => {
    res.setHeader('Connection','close');
    if (req.method === 'POST' && req.url === '/' + nonce) {
      res.once('finish', () => site.close());
      res.end('owned watchdog disposal');
      return;
    }
    res.end('owned server remains active');
  });
  site.once('close', () => process.send?.({stage:'server-closed'}));
  cleanupServer(t,site);
  await new Promise(resolve => site.listen(0,'127.0.0.1',resolve));
  process.send?.({stage:'ready',port:site.address().port,nonce});
  cleanup(t, () => { throw Error('original browser cleanup refusal'); });
});
`,
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CIRCLE_HOME: join(root, 'reporter-home'),
  };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-isolation=none',
      '--test-reporter=spec',
      file,
    ],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let output = '';
  const messages: any[] = [];
  child.stdout!.on('data', (chunk) => (output += chunk));
  child.stderr!.on('data', (chunk) => (output += chunk));
  child.on('message', (message) => messages.push(message));
  const ended = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  const ready = await Promise.race([
    once(child, 'message').then(
      ([message]) => message as { port: number; nonce: string },
    ),
    ended.then((result) => {
      throw Error(
        'reporter exited before server readiness: ' +
          JSON.stringify(result) +
          ' ' +
          output,
      );
    }),
  ]);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let rescueTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogUsed = false;
  let forcedStop = false;
  let liveBeforeDisposal;
  let rescue;
  try {
    const outcome = await Promise.race([
      ended,
      new Promise<undefined>((resolve) => {
        watchdog = setTimeout(() => resolve(undefined), 2000);
      }),
    ]);
    if (!outcome) {
      watchdogUsed = true;
      liveBeforeDisposal = await exchange(ready.port);
      rescue = await exchange(ready.port, '/' + ready.nonce, 'POST');
      const rescued = await Promise.race([
        ended,
        new Promise<undefined>((resolve) => {
          rescueTimer = setTimeout(() => resolve(undefined), 2000);
        }),
      ]);
      if (!rescued) {
        forcedStop = true;
        child.kill('SIGKILL');
      }
    }
    const result = await ended;
    const after = await exchange(ready.port);
    const receipt = {
      watchdogUsed,
      forcedStop,
      liveBeforeDisposal,
      rescue,
      after,
      result,
      serverClosed: messages.some((m) => m.stage === 'server-closed'),
      originalFailureVisible: output.includes(
        'original browser cleanup refusal',
      ),
    };
    t.diagnostic(JSON.stringify(receipt));
    assert.equal(forcedStop, false, output);
    assert.equal(result.code, 1, output);
    assert.equal(result.signal, null, output);
    assert.match(output, /original browser cleanup refusal/);
    assert.equal(receipt.serverClosed, true, output);
    assert.equal(after.error, 'ECONNREFUSED');
    assert.equal(
      watchdogUsed,
      false,
      'a leaked owned server required the external nonce disposal: ' +
        JSON.stringify(receipt),
    );
  } finally {
    clearTimeout(watchdog);
    clearTimeout(rescueTimer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await ended;
    }
  }
});
