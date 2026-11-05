import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { nativeText } from '../src/native-text.ts';
import {
  differentInstanceBuild,
  instanceDataPath,
  InstanceActivation,
} from '../src/instance.ts';
import {
  DATA_IN_USE,
  DesktopDataInUseError,
  isDesktopDataInUse,
  runtimeFailure,
} from '../src/runtime-failure.ts';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('instance notices use native English and Chinese words', () => {
  for (const key of [
    'Circle is already running from another build',
    'quit the running app before opening another build',
    'Circle data is in use',
    'quit the other app using this data folder and try again',
  ]) {
    assert.equal(nativeText('en')(key), key);
    assert.notEqual(nativeText('zh-CN')(key), key);
  }
});

test('data ownership uses the actual directory, including a relative path and junction', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'circle-instance-path-'));
  try {
    const path = instanceDataPath(join(temp, 'data'));
    assert.equal(instanceDataPath(relative(process.cwd(), path)), path);
    await symlink(
      path,
      join(temp, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.equal(instanceDataPath(join(temp, 'alias')), path);
    assert.notEqual(instanceDataPath(join(temp, 'other')), path);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('activation waits for startup, serializes restoration and stops during quit', async () => {
  let restores = 0;
  let notices = 0;
  let release!: () => void;
  const failures: unknown[] = [];
  const activation = new InstanceActivation(
    async () => {
      restores++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    async () => {
      notices++;
    },
    (error) => failures.push(error),
  );
  activation.request();
  activation.request(true);
  assert.equal(restores, 0);
  activation.start();
  assert.equal(restores, 1);
  activation.request();
  release();
  await settle();
  assert.equal(notices, 1);
  assert.equal(restores, 2);
  activation.stop();
  activation.request(true);
  release();
  await settle();
  assert.equal(restores, 2);
  assert.equal(notices, 1);
  assert.deepEqual(failures, []);
});

test('only validated build identities request a different-build notice', () => {
  const own = {
    protocol: 'circle-instance/1' as const,
    build: '/build/a',
    version: '1.14.0',
  };
  assert.equal(differentInstanceBuild(own, own), false);
  assert.equal(
    differentInstanceBuild(own, { ...own, build: '/build/b' }),
    true,
  );
  assert.equal(
    differentInstanceBuild(own, { ...own, version: '1.15.0' }),
    true,
  );
  for (const value of [
    null,
    [],
    {},
    { ...own, build: '\n' },
    { ...own, version: 'x'.repeat(101) },
    { ...own, protocol: 'foreign' },
  ])
    assert.equal(differentInstanceBuild(own, value), false);
});

test('private data-occupancy failures have fixed text and preserve the local cause', () => {
  const cause = Error('synthetic lock cause');
  const error = new DesktopDataInUseError({ cause });
  assert.equal(error.cause, cause);
  assert.equal(isDesktopDataInUse(error), true);
  assert.equal(isDesktopDataInUse(Error('active writer')), false);
  assert.equal(
    isDesktopDataInUse(
      Object.assign(Error('localized database message'), {
        code: 'CIRCLE_DATABASE_BUSY',
      }),
    ),
    true,
  );
  const received = runtimeFailure({
    type: 'runtime-failure',
    code: DATA_IN_USE,
    message: 'secret',
  });
  assert.equal(isDesktopDataInUse(received), true);
  assert.doesNotMatch(received!.message, /secret/);
  assert.equal(
    runtimeFailure({ type: 'update', code: DATA_IN_USE }),
    undefined,
  );
  assert.equal(
    runtimeFailure({ type: 'runtime-failure', code: 'other' }),
    undefined,
  );
});
