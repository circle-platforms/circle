import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JobWake, answerJobsBeforeLeaving } from '../src/job_wake.js';

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state = {
    notice: true,
    occupied: false,
    closed: false,
    starts: 0,
    start: (): Promise<unknown> => Promise.resolve(),
  };
  const wake = new JobWake({
    hasNotice: () => state.notice,
    occupied: () => state.occupied,
    closed: () => state.closed,
    start: () => {
      state.starts++;
      return state.start();
    },
  });
  return { state, wake, tick: (ms = 1000) => t.mock.timers.tick(ms) };
}

test('a job that ended starts a turn a second later, and jobs ending within that second share it', (t) => {
  const { state, wake, tick } = setup(t);
  wake.jobEnded();
  tick(999);
  assert.equal(state.starts, 0);
  wake.jobEnded();
  tick(999);
  assert.equal(state.starts, 0, 'the second job moves the turn back');
  tick(1);
  assert.equal(state.starts, 1);
  tick(5000);
  assert.equal(state.starts, 1, 'one job end starts one turn');
});

test('a turn or a card holds the wake back until it is over', (t) => {
  const { state, wake, tick } = setup(t);
  state.occupied = true;
  wake.jobEnded();
  tick(5000);
  assert.equal(state.starts, 0);
  state.occupied = false;
  tick();
  assert.equal(state.starts, 1);
});

test('a running turn that read the notice leaves nothing to wake for', (t) => {
  const { state, wake, tick } = setup(t);
  state.occupied = true;
  wake.jobEnded();
  tick();
  state.notice = false;
  state.occupied = false;
  tick(5000);
  assert.equal(state.starts, 0);
});

test('a job with no notice that may wake, such as one the person stopped, starts nothing', (t) => {
  const { state, wake, tick } = setup(t);
  state.notice = false;
  wake.jobEnded();
  tick(5000);
  assert.equal(state.starts, 0);
});

test('a conversation that closed starts nothing', (t) => {
  const { state, wake, tick } = setup(t);
  wake.jobEnded();
  state.closed = true;
  tick(5000);
  assert.equal(state.starts, 0);
});

test('after a stop finished jobs wait for the next message of the person', (t) => {
  const { state, wake, tick } = setup(t);
  wake.snooze();
  wake.jobEnded();
  tick(5000);
  assert.equal(state.starts, 0);
  wake.personSent();
  wake.jobEnded();
  tick();
  assert.equal(state.starts, 1);
});

test('a job that ends after the person stopped a turn does not undo the stop', (t) => {
  const { state, wake, tick } = setup(t);
  wake.jobEnded();
  wake.snooze();
  tick(5000);
  assert.equal(state.starts, 0);
});

test('at most ten turns in a row start by themselves, until the person writes', (t) => {
  const { state, wake, tick } = setup(t);
  for (let i = 0; i < 12; i++) {
    wake.jobEnded();
    tick();
  }
  assert.equal(state.starts, 10);
  wake.personSent();
  wake.jobEnded();
  tick();
  assert.equal(state.starts, 11);
});

test('a turn that fails to start waits for the person instead of trying again', async (t) => {
  const { state, wake, tick } = setup(t);
  state.start = () => Promise.reject(Error('model unavailable'));
  wake.jobEnded();
  tick();
  assert.equal(state.starts, 1);
  await Promise.resolve();
  await Promise.resolve();
  wake.jobEnded();
  tick(5000);
  assert.equal(state.starts, 1);
});

test('a front end with a clock of its own looks when it likes, and nothing starts before the second is up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let starts = 0;
  const wake = new JobWake(
    {
      hasNotice: () => true,
      occupied: () => false,
      closed: () => false,
      start: () => {
        starts++;
        return Promise.resolve();
      },
    },
    { timed: false },
  );
  wake.jobEnded();
  wake.check();
  assert.equal(starts, 0);
  t.mock.timers.tick(5000);
  assert.equal(starts, 0, 'no timer of its own');
  wake.check();
  assert.equal(starts, 1);
});

test('before leaving, the model answers as its jobs end, up to the limit, and what commands left running is stopped', async () => {
  const stopped: string[] = [];
  let notices = 12;
  let running = true;
  const runtime = {
    session: { id: 's' },
    jobs: {
      list: () => [
        { id: 'left', kind: 'adopted', status: 'running', startedBy: 'model' },
        ...(running
          ? [{ id: 'j', kind: 'shell', status: 'running', startedBy: 'model' }]
          : []),
      ],
      stop: async (id: string) => {
        stopped.push(id);
      },
      hasNotices: () => notices > 0,
    },
  };
  let wakes = 0;
  await answerJobsBeforeLeaving(runtime as never, {
    delay: async () => {},
    wake: async () => {
      wakes++;
      notices--;
    },
    wakesSoFar: 3,
  });
  assert.deepEqual(stopped, ['left']);
  assert.equal(wakes, 7, 'ten in a row, counting the ones before');

  notices = 1;
  wakes = 0;
  let looks = 0;
  await answerJobsBeforeLeaving(runtime as never, {
    delay: async () => {
      looks++;
    },
    wake: async () => {
      wakes++;
      notices = 0;
      running = false;
    },
    carryOn: () => looks < 5,
  });
  assert.equal(wakes, 1);
});

test('before leaving, carrying on no longer ends the wait without a turn', async () => {
  const runtime = {
    session: { id: 's' },
    jobs: { list: () => [], stop: async () => {}, hasNotices: () => true },
  };
  let stop = false;
  let wakes = 0;
  await answerJobsBeforeLeaving(runtime as never, {
    delay: async () => {
      stop = true;
    },
    wake: async () => {
      wakes++;
    },
    carryOn: () => !stop,
  });
  assert.equal(wakes, 0);
});
