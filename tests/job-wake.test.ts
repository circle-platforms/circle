import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  JobWake,
  answerJobsBeforeLeaving,
  mostWakesInARow,
} from '../src/job_wake.js';

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

test('a turn that fails to start is tried again three times, further apart each time, and then waits for the person', async (t) => {
  const { state, wake, tick } = setup(t);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  state.start = () => Promise.reject(Error('model unavailable'));
  wake.jobEnded();
  tick();
  assert.equal(state.starts, 1);
  await settle();
  tick(14_000);
  assert.equal(state.starts, 1, 'not before fifteen seconds');
  tick(2000);
  assert.equal(state.starts, 2);
  await settle();
  tick(61_000);
  assert.equal(state.starts, 3);
  await settle();
  tick(241_000);
  assert.equal(state.starts, 4);
  await settle();
  tick(600_000);
  assert.equal(
    state.starts,
    4,
    'after the third retry it waits for the person',
  );
  assert.equal(wake.snoozed, true);
  assert.equal(
    wake.wakesInARow,
    1,
    'turns that did not start are not turns in a row',
  );
  state.start = () => Promise.resolve();
  wake.personSent();
  wake.jobEnded();
  tick();
  assert.equal(state.starts, 5);
});

test('a turn that starts after a failed one clears the count of failures', async (t) => {
  const { state, wake, tick } = setup(t);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  state.start = () => Promise.reject(Error('model unavailable'));
  wake.jobEnded();
  tick();
  await settle();
  state.start = () => Promise.resolve();
  tick(16_000);
  assert.equal(state.starts, 2);
  await settle();
  state.start = () => Promise.reject(Error('model unavailable'));
  wake.jobEnded();
  tick();
  await settle();
  tick(16_000);
  assert.equal(state.starts, 4, 'the first wait again, not the second');
});

test('CIRCLE_JOB_WAKES sets how many turns in a row start by themselves; anything that is no whole number from one up leaves ten', () => {
  assert.equal(mostWakesInARow({}), 10);
  assert.equal(mostWakesInARow({ CIRCLE_JOB_WAKES: '500' }), 500);
  for (const value of ['0', '-3', '2.5', 'many', ''])
    assert.equal(mostWakesInARow({ CIRCLE_JOB_WAKES: value }), 10, value);
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

test('a turn that took its notice and then failed is run again, though no notice waits any more', async (t) => {
  // What happened in a real run: two jobs ended, each wake took its notice into the conversation
  // and the model's service broke off; nothing waited to be read, so no turn started again.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state = { notice: true, starts: 0, agains: 0, fail: true };
  const wake = new JobWake({
    hasNotice: () => state.notice,
    occupied: () => false,
    closed: () => false,
    start: () => {
      state.starts++;
      // The turn reads the notice before it asks the model.
      state.notice = false;
      return state.fail
        ? Promise.reject(Error('model service broke off'))
        : Promise.resolve();
    },
    again: () => {
      state.agains++;
      return state.fail
        ? Promise.reject(Error('model service broke off'))
        : Promise.resolve();
    },
  });
  const tick = (ms = 1000) => t.mock.timers.tick(ms);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  wake.jobEnded();
  tick();
  assert.equal(state.starts, 1);
  await settle();
  tick(14_000);
  assert.equal(state.agains, 0, 'not before fifteen seconds');
  tick(2000);
  assert.equal(state.agains, 1, 'the turn owed is run again without a notice');
  assert.equal(state.starts, 1, 'the notice is not read twice');
  await settle();
  state.fail = false;
  tick(61_000);
  assert.equal(state.agains, 2);
  await settle();
  tick(600_000);
  assert.equal(state.agains, 2, 'once the turn has run nothing is owed');
  assert.equal(wake.snoozed, false);
  assert.equal(wake.wakesInARow, 1, 'the failed tries are not turns in a row');
  // A later job is an ordinary wake again.
  state.notice = true;
  wake.jobEnded();
  tick();
  assert.equal(state.starts, 2);
});

test('a turn owed that keeps failing waits for the person after the last retry, and a message clears it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state = { notice: true, starts: 0, agains: 0 };
  const wake = new JobWake({
    hasNotice: () => state.notice,
    occupied: () => false,
    closed: () => false,
    start: () => {
      state.starts++;
      state.notice = false;
      return Promise.reject(Error('broke off'));
    },
    again: () => {
      state.agains++;
      return Promise.reject(Error('broke off'));
    },
  });
  const tick = (ms = 1000) => t.mock.timers.tick(ms);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  wake.jobEnded();
  tick();
  for (const wait of [16_000, 61_000, 241_000]) {
    await settle();
    tick(wait);
  }
  await settle();
  assert.equal(state.agains, 3, 'three retries, further apart each time');
  assert.equal(wake.snoozed, true);
  tick(600_000);
  assert.equal(state.agains, 3);
  wake.personSent();
  tick(5000);
  assert.equal(
    state.agains,
    3,
    'the message of the person is the next turn; nothing is owed',
  );
});

test('a front end without a way to run the turn again starts the ordinary turn, which finds nothing to read', async (t) => {
  const { state, wake, tick } = setup(t);
  state.start = () => {
    state.notice = false;
    return Promise.reject(Error('broke off'));
  };
  wake.jobEnded();
  tick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  state.start = () => Promise.resolve();
  tick(16_000);
  assert.equal(state.starts, 2);
});
