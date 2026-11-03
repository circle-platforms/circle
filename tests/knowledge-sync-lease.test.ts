import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { symlinkSync } from 'node:fs';
import { KnowledgeStore } from '../src/knowledge/store.js';
import { scratch, cleanup } from './helpers.js';
const worker = new URL(
  './fixtures/knowledge-sync/lease-worker.ts',
  import.meta.url,
);
function child(home: string, action: string, now: number, token: string) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(worker),
      home,
      action,
      String(now),
      token,
    ],
    { encoding: 'utf8' },
  );
}

test('the canonical home has one cross-process lease, including aliases', (t) => {
  const home = scratch(t, 'circle-sync-lease-');
  const store = new KnowledgeStore(home);
  cleanup(t, () => store.close());
  assert.equal(store.acquireSyncLease('first', 1000, 30000), true);
  assert.deepEqual(JSON.parse(child(home, 'acquire', 2000, 'second').stdout), {
    acquired: false,
  });
  const alias = join(scratch(t, 'circle-sync-alias-'), 'home');
  try {
    symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    if (
      process.platform === 'win32' &&
      (e as NodeJS.ErrnoException).code === 'EPERM'
    ) {
      t.skip('Windows account cannot create directory links');
      return;
    }
    throw e;
  }
  assert.deepEqual(JSON.parse(child(alias, 'acquire', 2000, 'second').stdout), {
    acquired: false,
  });
  assert.equal(store.renewSyncLease('first', 2000, 30000), true);
  assert.deepEqual(JSON.parse(child(home, 'acquire', 31000, 'second').stdout), {
    acquired: false,
  });
  store.releaseSyncLease('first');
  assert.deepEqual(JSON.parse(child(home, 'acquire', 31000, 'second').stdout), {
    acquired: true,
  });
});

test('an exited process is fenced after expiry and takeover; an old release cannot unlock its successor', (t) => {
  const home = scratch(t, 'circle-sync-takeover-');
  const first = child(home, 'acquire', 1000, 'old');
  assert.equal(first.status, 0);
  assert.equal(JSON.parse(first.stdout).acquired, true);
  const store = new KnowledgeStore(home);
  cleanup(t, () => store.close());
  assert.equal(store.acquireSyncLease('new', 31000, 30000), true);
  assert.notEqual(child(home, 'assert', 32000, 'old').status, 0);
  assert.throws(
    () =>
      store.syncAtomic(
        'old',
        () => 32000,
        () => store.syncWrite('forbidden', 'changed'),
      ),
    /lease lost/,
  );
  assert.equal(store.syncRead('forbidden'), null);
  store.releaseSyncLease('old');
  store.assertSyncLease('new', 32000);
  assert.equal(store.renewSyncLease('old', 32000, 30000), false);
  assert.equal(store.renewSyncLease('new', 61000, 30000), false);
});

test('the ownership fence and journal change roll back together if the lease expires during a write', (t) => {
  const store = new KnowledgeStore(scratch(t, 'circle-sync-fence-'));
  cleanup(t, () => store.close());
  store.acquireSyncLease('owner', 1000, 30000);
  let now = 1001;
  assert.throws(
    () =>
      store.syncAtomic(
        'owner',
        () => now,
        () => {
          store.syncWrite('active', { state: 'never-published' });
          now = 31000;
        },
      ),
    /lease lost/,
  );
  assert.equal(store.syncRead('active'), null);
});

test('a killed holder leaves a durable lease that only an expired successor can take over', async (t) => {
  const home = scratch(t, 'circle-sync-killed-');
  const processChild = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(worker), home, 'hold', '1000', 'killed'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  cleanup(t, async () => {
    if (processChild.exitCode === null && processChild.signalCode === null) {
      const exited = once(processChild, 'exit');
      processChild.kill('SIGKILL');
      await exited;
    }
  });
  const [output] = await once(processChild.stdout, 'data');
  assert.equal(JSON.parse(String(output)).acquired, true);
  const exit = once(processChild, 'exit');
  processChild.kill('SIGKILL');
  await exit;
  const store = new KnowledgeStore(home);
  cleanup(t, () => store.close());
  assert.equal(store.acquireSyncLease('successor', 2000, 30000), false);
  assert.equal(store.acquireSyncLease('successor', 31000, 30000), true);
  assert.throws(() => store.assertSyncLease('killed', 31001), /lease lost/);
});
