import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceOpenCoordinator } from '../src/model/source-open.ts';
test('late absolute alias resolution cannot select a source after switching conversations', async () => {
  let session = 'first';
  let finish!: (value: { path: string }) => void;
  const coordinator = new SourceOpenCoordinator(() => session);
  const pending = coordinator.open(
    'first',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  session = 'second';
  finish({ path: 'README.md' });
  assert.deepEqual(await pending, { status: 'superseded' });
});
test('a newer click wins over an older deferred path resolution', async () => {
  const coordinator = new SourceOpenCoordinator(() => 'same');
  let finish!: (value: { path: string }) => void;
  const first = coordinator.open(
    'same',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const second = await coordinator.open('same', async () => ({
    path: 'SECOND.md',
    line: 12,
  }));
  finish({ path: 'README.md' });
  assert.deepEqual(second, {
    status: 'opened',
    source: { path: 'SECOND.md', line: 12 },
  });
  assert.deepEqual(await first, { status: 'superseded' });
});
test('explicit navigation cancellation preserves the current view and suppresses stale failures', async () => {
  const coordinator = new SourceOpenCoordinator(() => 'same');
  let reject!: (error: Error) => void;
  const pending = coordinator.open(
    'same',
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  coordinator.cancel();
  reject(Error('old lookup failed'));
  assert.deepEqual(await pending, { status: 'superseded' });
  const error = Error('outside current workspace');
  assert.deepEqual(
    await coordinator.open('same', async () => {
      throw error;
    }),
    { status: 'failed', error },
  );
});
