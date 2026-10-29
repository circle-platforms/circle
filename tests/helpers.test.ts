import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { cleanup, cleanupServer, scratch, until } from './helpers.js';

function context(): {
  after: (hook: () => void | Promise<void>) => void;
  finish: () => Promise<void>;
} {
  const hooks: (() => void | Promise<void>)[] = [];
  return {
    after: (hook) => {
      hooks.push(hook);
    },
    finish: async () => {
      for (const hook of hooks) await hook();
    },
  };
}

test('scratch cleanup yields to pending process callbacks and removes every owned directory', async () => {
  const t = context();
  const root = scratch(t);
  const nested = join(root, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'output.log'), 'finished');
  const order: string[] = [];
  cleanup(t, () => {
    order.push('first');
  });
  cleanup(t, () => {
    order.push('second');
  });
  let callbackRan = false;
  const callback = nextTurn().then(() => {
    callbackRan = true;
  });
  try {
    await t.finish();
    assert.equal(callbackRan, true);
    assert.deepEqual(order, ['second', 'first']);
    assert.equal(existsSync(root), false);
  } finally {
    await callback;
  }
});

test('a failed resource cleanup still removes scratch files and reports the original failure', async () => {
  const t = context();
  const root = scratch(t);
  writeFileSync(join(root, 'output.log'), 'finished');
  const failure = new Error('resource did not close');
  let anotherClosed = false;
  cleanup(t, () => {
    anotherClosed = true;
  });
  cleanup(t, () => {
    throw failure;
  });
  await assert.rejects(t.finish(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'test resource cleanup failed');
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.equal(anotherClosed, true);
  assert.equal(existsSync(root), false);
});

test('a failed browser cleanup still closes its fixture server and connected socket', async () => {
  const t = context();
  const root = scratch(t);
  const server = createServer();
  cleanupServer(t, server);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const connected = once(server, 'connection');
  const client = createConnection(
    (server.address() as AddressInfo).port,
    '127.0.0.1',
  );
  client.on('error', () => {});
  const disconnected = new Promise<void>((resolve) => {
    client.once('close', resolve);
  });
  const failure = new Error('browser did not close');
  cleanup(t, () => {
    throw failure;
  });
  try {
    await connected;
    await assert.rejects(t.finish(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    });
    await disconnected;
    assert.equal(client.destroyed, true);
    assert.equal(server.listening, false);
    assert.equal(existsSync(root), false);
  } finally {
    client.destroy();
    server.closeAllConnections();
    server.close();
  }
});

test('a wait reads a label function only when it gives up, and ends when its signal aborts', async () => {
  let reads = 0;
  await assert.rejects(
    until(() => false, { timeout: 50, label: () => `state ${++reads}` }),
    { message: 'timed out after 50 ms waiting for state 1' },
  );
  assert.equal(reads, 1);
  const controller = new AbortController();
  const reason = new Error('the test was cancelled');
  const waiting = until(() => false, {
    timeout: 60_000,
    signal: controller.signal,
  });
  controller.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
});
