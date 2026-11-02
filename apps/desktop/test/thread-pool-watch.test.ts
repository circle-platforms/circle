import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stat } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  pendingResources,
  ThreadPoolWatch,
  type ThreadPoolStall,
} from '../src/thread-pool-watch.ts';

/** A watch driven by hand: the test says when time passes and when probes finish. */
function manual(stallMs = 30) {
  let now = 0;
  const probes: (() => void)[] = [];
  const stalls: ThreadPoolStall[] = [];
  const watch = new ThreadPoolWatch({
    probe: (done) => probes.push(done),
    onStall: (stall) => stalls.push(stall),
    stallMs,
    now: () => now,
  });
  return {
    watch,
    probes,
    stalls,
    at(time: number) {
      now = time;
      watch.check();
    },
  };
}

test('a pool that answers is never reported, and a look starts a probe only when none is in flight', () => {
  const run = manual();
  for (let time = 0; time <= 300; time += 10) {
    run.at(time);
    run.probes.at(-1)!();
  }
  assert.equal(run.stalls.length, 0);
  assert.equal(run.probes.length, 31, 'each look after an answer starts one');
  run.at(310);
  run.at(320);
  assert.equal(run.probes.length, 32, 'none while one is unanswered');
});

test('a probe still unanswered at two overdue looks is a stall, reported once', () => {
  const run = manual(30);
  run.at(0);
  assert.equal(run.probes.length, 1);
  for (const time of [10, 20, 30])
    // Not overdue at 10 and 20; overdue for the first time at 30.
    run.at(time);
  assert.equal(run.stalls.length, 0, 'one overdue look is not enough');
  run.at(40);
  assert.deepEqual(run.stalls, [{ waitedMs: 40 }]);
  assert.equal(run.probes.length, 1, 'no probe was added meanwhile');
  // The watch stops itself: nothing more is probed or reported.
  run.at(50);
  run.at(60);
  assert.equal(run.stalls.length, 1);
  assert.equal(run.probes.length, 1);
});

test('a process that was suspended is not taken for a stopped pool', () => {
  const run = manual(30);
  run.at(0);
  // The event loop did not run for a minute: the first look afterwards finds the probe
  // long overdue, but the loop delivers its answer before the second look.
  run.at(60);
  run.probes[0]!();
  run.at(70);
  run.at(80);
  assert.equal(run.stalls.length, 0);
  assert.equal(run.probes.length, 2, 'the next look started a fresh probe');
});

test('a probe that cannot start is not counted, and a late answer to an old probe changes nothing', () => {
  let calls = 0;
  let now = 0;
  const stalls: ThreadPoolStall[] = [];
  const late: (() => void)[] = [];
  const watch = new ThreadPoolWatch({
    probe: (done) => {
      calls++;
      if (calls === 1) throw Error('no file descriptors');
      late.push(done);
    },
    onStall: (stall) => stalls.push(stall),
    stallMs: 30,
    now: () => now,
  });
  watch.check();
  now = 10;
  watch.check();
  assert.equal(calls, 2, 'the failed start left no probe in flight');
  // Started at 10: overdue first at 40, again at 50.
  for (now = 20; now <= 60; now += 10) watch.check();
  assert.deepEqual(stalls, [{ waitedMs: 40 }]);
  assert.equal(calls, 2, 'nothing is probed after the stall');
  late[0]!();
  watch.check();
  assert.equal(stalls.length, 1);
});

test('with a real file probe and timers, a working pool is never reported', async () => {
  const stalls: ThreadPoolStall[] = [];
  let answered = 0;
  const watch = new ThreadPoolWatch({
    probe: (done) =>
      stat('/', () => {
        answered++;
        done();
      }),
    onStall: (stall) => stalls.push(stall),
    intervalMs: 20,
    stallMs: 60,
  });
  watch.start();
  try {
    await delay(400);
  } finally {
    watch.stop();
  }
  assert.equal(stalls.length, 0);
  assert(answered >= 5, `the probe ran and finished (${answered} times)`);
});

test('what the process waits on is told by kind and count only', () => {
  assert.deepEqual(
    pendingResources([
      'FSReqPromise',
      'FSReqCallback',
      'FSReqPromise',
      'GetAddrInfoReqWrap',
      '/Users/someone/secret',
      'kind with spaces',
    ]),
    { FSReqPromise: 2, FSReqCallback: 1, GetAddrInfoReqWrap: 1 },
  );
});
