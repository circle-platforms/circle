import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ScanPacer } from '../src/workspace/scan-pacer.ts';

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const scans: (() => void)[] = [];
  const pacer = new ScanPacer(
    () => new Promise<void>((done) => scans.push(done)),
  );
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    pacer,
    scans,
    settle,
    finishAfter: async (ms: number) => {
      t.mock.timers.tick(ms);
      scans.at(-1)!();
      await settle();
    },
    tick: (ms: number) => t.mock.timers.tick(ms),
  };
}

test('a scan rests nine times as long as it took before the next', async (t) => {
  const { pacer, scans, finishAfter, tick } = setup(t);
  pacer.request();
  assert.equal(scans.length, 1);
  await finishAfter(100);
  pacer.request();
  assert.equal(scans.length, 1, 'still resting');
  tick(899);
  assert.equal(scans.length, 1);
  tick(1);
  assert.equal(scans.length, 2, 'the request waited, it was not dropped');
});

test('requests during a rest make one scan', async (t) => {
  const { pacer, scans, finishAfter, tick } = setup(t);
  pacer.request();
  await finishAfter(100);
  for (let i = 0; i < 5; i++) pacer.request();
  tick(900);
  assert.equal(scans.length, 2);
  await finishAfter(0);
  tick(10_000);
  assert.equal(scans.length, 2);
});

test('a change during a scan gets another scan, after the rest', async (t) => {
  const { pacer, scans, finishAfter, tick } = setup(t);
  pacer.request();
  pacer.request();
  pacer.request();
  assert.equal(scans.length, 1, 'one scan at a time');
  await finishAfter(100);
  assert.equal(scans.length, 1);
  tick(900);
  assert.equal(scans.length, 2);
});

test('a very slow scan rests at most thirty seconds', async (t) => {
  const { pacer, scans, finishAfter, tick } = setup(t);
  pacer.request();
  await finishAfter(60_000);
  pacer.request();
  tick(30_000);
  assert.equal(scans.length, 2);
});

test('a stopped pacer starts nothing', async (t) => {
  const { pacer, scans, finishAfter, tick } = setup(t);
  pacer.request();
  await finishAfter(100);
  pacer.request();
  pacer.stop();
  tick(5000);
  pacer.request();
  assert.equal(scans.length, 1);
});
