import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  JobWake,
  answerJobsBeforeLeaving,
  mostWakesInARow,
  turnsStartedByJobs,
  unsaidNotices,
  waitingSentence,
} from '../src/job_wake.js';

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state = {
    notice: true,
    occupied: false,
    closed: false,
    starts: 0,
    owed: 0,
    start: (): Promise<unknown> => Promise.resolve(),
  };
  const wake = new JobWake({
    hasNotice: () => state.notice,
    occupied: () => state.occupied,
    closed: () => state.closed,
    start: (owed) => {
      state.starts++;
      if (owed) state.owed++;
      return state.start();
    },
  });
  return { state, wake, tick: (ms = 1000) => t.mock.timers.tick(ms) };
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

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

test('at most twenty turns in a row start by themselves, until the person writes', (t) => {
  const { state, wake, tick } = setup(t);
  for (let i = 0; i < 22; i++) {
    wake.jobEnded();
    tick();
  }
  assert.equal(state.starts, 20);
  wake.personSent();
  wake.jobEnded();
  tick();
  assert.equal(state.starts, 21);
});

test('a turn that fails to start is tried again three times, further apart each time, and then waits for the person', async (t) => {
  const { state, wake, tick } = setup(t);
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

test('CIRCLE_JOB_WAKES sets how many turns in a row start by themselves; anything that is no whole number from one up leaves twenty', () => {
  assert.equal(mostWakesInARow({}), 20);
  assert.equal(mostWakesInARow({ CIRCLE_JOB_WAKES: '500' }), 500);
  for (const value of ['0', '-3', '2.5', 'many', ''])
    assert.equal(mostWakesInARow({ CIRCLE_JOB_WAKES: value }), 20, value);
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
  let notices = 22;
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
  const atTheLimit = await answerJobsBeforeLeaving(runtime as never, {
    delay: async () => {},
    wake: async () => {
      wakes++;
      notices--;
    },
    wakesSoFar: 3,
  });
  assert.deepEqual(stopped, ['left']);
  assert.equal(wakes, 17, 'twenty in a row, counting the ones before');
  assert.deepEqual(
    atTheLimit,
    { why: 'limit', most: 20 },
    'it says it left at the limit, with notices unread',
  );

  notices = 1;
  wakes = 0;
  let looks = 0;
  const done = await answerJobsBeforeLeaving(runtime as never, {
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
  assert.equal(done, undefined, 'every notice was read: nothing to say');
});

test('before leaving, the limit named is the one CIRCLE_JOB_WAKES sets, and it is reached only with a notice unread', async (t) => {
  const before = process.env.CIRCLE_JOB_WAKES;
  process.env.CIRCLE_JOB_WAKES = '2';
  t.after(() => {
    if (before === undefined) delete process.env.CIRCLE_JOB_WAKES;
    else process.env.CIRCLE_JOB_WAKES = before;
  });
  let notices = 5;
  const runtime = {
    session: { id: 's' },
    jobs: {
      list: () => [],
      stop: async () => {},
      hasNotices: () => notices > 0,
    },
  };
  const options = {
    delay: async () => {},
    wake: async () => {
      notices = 0;
    },
  };
  assert.deepEqual(
    await answerJobsBeforeLeaving(runtime as never, {
      ...options,
      wake: async () => {
        notices--;
      },
    }),
    { why: 'limit', most: 2 },
  );
  // The limit used up by the turns before, and every notice read: nothing is left unsaid
  notices = 0;
  assert.equal(
    await answerJobsBeforeLeaving(runtime as never, {
      ...options,
      wakesSoFar: 2,
    }),
    undefined,
  );
});

test('before leaving, carrying on no longer ends the wait without a turn', async () => {
  const runtime = {
    session: { id: 's' },
    jobs: { list: () => [], stop: async () => {}, hasNotices: () => true },
  };
  let stop = false;
  let wakes = 0;
  const left = await answerJobsBeforeLeaving(runtime as never, {
    delay: async () => {
      stop = true;
    },
    wake: async () => {
      wakes++;
    },
    carryOn: () => !stop,
  });
  assert.equal(wakes, 0);
  assert.equal(left, undefined, 'it did not leave at the limit');
});

test('a turn that took its notice and then failed is run again, though no notice waits any more', async (t) => {
  const { state, wake, tick } = setup(t);
  let fail = true;
  state.start = () => {
    state.notice = false;
    return fail
      ? Promise.reject(Error('model service broke off'))
      : Promise.resolve();
  };
  wake.jobEnded();
  tick();
  assert.deepEqual([state.starts, state.owed], [1, 0]);
  await settle();
  tick(14_000);
  assert.equal(state.starts, 1, 'not before fifteen seconds');
  tick(2000);
  assert.deepEqual(
    [state.starts, state.owed],
    [2, 1],
    'the turn owed is run again without a notice',
  );
  await settle();
  fail = false;
  tick(61_000);
  assert.deepEqual([state.starts, state.owed], [3, 2]);
  await settle();
  tick(600_000);
  assert.equal(state.starts, 3, 'once the turn has run nothing is owed');
  assert.equal(wake.snoozed, false);
  assert.equal(wake.wakesInARow, 1, 'the failed tries are not turns in a row');
  state.notice = true;
  wake.jobEnded();
  tick();
  assert.deepEqual([state.starts, state.owed], [4, 2]);
});

test('a turn owed that keeps failing waits for the person after the last retry, and a message clears it', async (t) => {
  const { state, wake, tick } = setup(t);
  state.start = () => {
    state.notice = false;
    return Promise.reject(Error('broke off'));
  };
  wake.jobEnded();
  tick();
  for (const wait of [16_000, 61_000, 241_000]) {
    await settle();
    tick(wait);
  }
  await settle();
  assert.equal(state.owed, 3, 'three retries, further apart each time');
  assert.equal(wake.snoozed, true);
  tick(600_000);
  assert.equal(state.owed, 3);
  wake.personSent();
  tick(5000);
  assert.equal(
    state.owed,
    3,
    'the message of the person is the next turn; nothing is owed',
  );
});

// The front end is told when a notice waits and no turn will start for it, so that the person is not left
// looking at a conversation that has gone quiet.
function setupHolding(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state = {
    notice: true,
    occupied: false,
    starts: 0,
    holds: [] as unknown[],
  };
  const wake = new JobWake({
    hasNotice: () => state.notice,
    occupied: () => state.occupied,
    closed: () => false,
    start: () => {
      state.starts++;
      return Promise.resolve();
    },
    holding: (hold) => {
      state.holds.push(hold);
    },
  });
  return { state, wake, tick: (ms = 1000) => t.mock.timers.tick(ms) };
}

test('the limit of turns in a row holds a notice back: the front end is told once for the jobs that ended, and again for a job that ends after', (t) => {
  const { state, wake, tick } = setupHolding(t);
  for (let i = 0; i < 20; i++) {
    wake.jobEnded();
    tick();
  }
  assert.equal(state.starts, 20);
  assert.deepEqual(
    state.holds,
    [],
    'twenty turns started, nothing is held yet',
  );
  wake.jobEnded();
  tick();
  assert.equal(state.starts, 20, 'the twenty-first waits for the person');
  assert.deepEqual(state.holds, [{ why: 'limit', most: 20 }]);
  tick(5000);
  assert.equal(state.holds.length, 1, 'once, not at every look');
  wake.jobEnded();
  tick();
  assert.equal(state.holds.length, 2, 'a job that ends after is a notice more');
  wake.personSent();
  wake.jobEnded();
  tick();
  assert.equal(
    state.starts,
    21,
    'a message of the person lets the next turn start',
  );
  assert.equal(state.holds.length, 2);
});

test('the limit is told with the number CIRCLE_JOB_WAKES set', (t) => {
  const before = process.env.CIRCLE_JOB_WAKES;
  process.env.CIRCLE_JOB_WAKES = '2';
  t.after(() => {
    if (before === undefined) delete process.env.CIRCLE_JOB_WAKES;
    else process.env.CIRCLE_JOB_WAKES = before;
  });
  const { state, wake, tick } = setupHolding(t);
  for (let i = 0; i < 3; i++) {
    wake.jobEnded();
    tick();
  }
  assert.equal(state.starts, 2);
  assert.deepEqual(state.holds, [{ why: 'limit', most: 2 }]);
});

test('a stop holds a notice back the same way, and the front end is told', (t) => {
  const { state, wake, tick } = setupHolding(t);
  wake.snooze();
  wake.jobEnded();
  tick();
  assert.equal(state.starts, 0);
  assert.deepEqual(state.holds, [{ why: 'stopped' }]);
  wake.personSent();
  wake.jobEnded();
  tick();
  assert.equal(state.starts, 1);
  assert.equal(state.holds.length, 1);
});

test('nothing is said while a turn or a card holds the conversation, and it is said when that is over', (t) => {
  const { state, wake, tick } = setupHolding(t);
  wake.snooze();
  state.occupied = true;
  wake.jobEnded();
  tick(5000);
  assert.deepEqual(state.holds, [], 'the turn may still read the notice');
  state.occupied = false;
  tick();
  assert.deepEqual(state.holds, [{ why: 'stopped' }]);
});

test('nothing is said when no notice waits that could start a turn, such as one of a job the person stopped', (t) => {
  const { state, wake, tick } = setupHolding(t);
  wake.snooze();
  state.notice = false;
  wake.jobEnded();
  tick(5000);
  assert.deepEqual(state.holds, []);
});

// The turn a job started failed on every retry, and a notice still waits: the person is told as after a stop, whether the
// front end has a clock of its own or looks itself.
function failingWake(t: TestContext, options?: { timed: boolean }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state = { starts: 0, holds: [] as unknown[] };
  const wake = new JobWake(
    {
      hasNotice: () => true,
      occupied: () => false,
      closed: () => false,
      start: () => {
        state.starts++;
        return Promise.reject(Error('model unavailable'));
      },
      holding: (hold) => {
        state.holds.push(hold);
      },
    },
    options,
  );
  return { state, wake };
}

test('after the last retry a notice that still waits is told to a front end with a clock of its own, once', async (t) => {
  const { state, wake } = failingWake(t);
  wake.jobEnded();
  t.mock.timers.tick(1000);
  for (const wait of [16_000, 61_000, 241_000]) {
    await settle();
    t.mock.timers.tick(wait);
  }
  await settle();
  assert.equal(state.starts, 4, 'the turn and its three retries');
  assert.equal(wake.snoozed, true);
  assert.deepEqual(state.holds, [], 'nothing before it looks again');
  t.mock.timers.tick(1000);
  assert.deepEqual(state.holds, [{ why: 'stopped' }]);
  t.mock.timers.tick(600_000);
  assert.equal(state.holds.length, 1, 'once, not at every look');
  assert.equal(state.starts, 4);
});

test('after the last retry a front end that looks itself is told when it looks, and has no timer to look for it', async (t) => {
  const { state, wake } = failingWake(t, { timed: false });
  wake.jobEnded();
  t.mock.timers.tick(1000);
  wake.check();
  for (const wait of [16_000, 61_000, 241_000]) {
    await settle();
    t.mock.timers.tick(wait);
    wake.check();
  }
  await settle();
  assert.equal(state.starts, 4);
  t.mock.timers.tick(600_000);
  assert.deepEqual(
    state.holds,
    [],
    'no clock of its own: it says nothing by itself',
  );
  wake.check();
  assert.deepEqual(state.holds, [{ why: 'stopped' }]);
  wake.check();
  assert.equal(state.holds.length, 1, 'once');
});

test('after the last retry a front end that does not ask to be told is not looked at again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let looks = 0;
  let starts = 0;
  const wake = new JobWake({
    hasNotice: () => {
      looks++;
      return true;
    },
    occupied: () => false,
    closed: () => false,
    start: () => {
      starts++;
      return Promise.reject(Error('model unavailable'));
    },
  });
  wake.jobEnded();
  t.mock.timers.tick(1000);
  for (const wait of [16_000, 61_000, 241_000]) {
    await settle();
    t.mock.timers.tick(wait);
  }
  await settle();
  assert.equal(starts, 4);
  const after = looks;
  t.mock.timers.tick(600_000);
  assert.equal(looks, after, 'no timer of its own after it gave up');
});

test('a front end that does not ask to be told is not looked at again while a notice is held', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let looks = 0;
  const wake = new JobWake({
    hasNotice: () => {
      looks++;
      return true;
    },
    occupied: () => false,
    closed: () => false,
    start: () => Promise.resolve(),
  });
  wake.snooze();
  wake.jobEnded();
  t.mock.timers.tick(1000);
  const first = looks;
  t.mock.timers.tick(60_000);
  assert.equal(looks, first, 'no timer of its own after the first look');
});

// What a front end says when it is told: each notice that waits, once, in the sentence the terminal prints.
test('a notice that waits is news once, and again only when a turn has read it and another waits', () => {
  const waiting: { id: string; line: string }[] = [
    { id: 'j1', line: 'j1 done · stage 1 · 3s' },
  ];
  const asked: string[] = [];
  const runtime = {
    session: { id: 'conversation' },
    jobs: {
      waitingNotices: (sessionId: string) => {
        asked.push(sessionId);
        return structuredClone(waiting);
      },
    },
  };
  const said = new Set<string>();
  const news = () => unsaidNotices(runtime as never, said).map((n) => n.id);
  assert.deepEqual(news(), ['j1']);
  assert.deepEqual(news(), [], 'said once');
  waiting.push({ id: 'j2', line: 'j2 done · stage 2 · 4s' });
  assert.deepEqual(news(), ['j2'], 'a notice more is news, the first is not');
  assert.deepEqual(
    asked,
    Array(3).fill('conversation'),
    'this conversation only',
  );
  // A turn read them: they are forgotten, so one that waits again is news again
  waiting.length = 0;
  assert.deepEqual(news(), []);
  assert.equal(said.size, 0);
  waiting.push({ id: 'j1', line: 'j1 done · stage 1 · 3s' });
  assert.deepEqual(news(), ['j1']);
});

test('the limit in words counts a single turn in the singular', () => {
  assert.equal(turnsStartedByJobs(20), '20 turns in a row started by jobs');
  assert.equal(turnsStartedByJobs(1), '1 turn started by jobs');
});

test('the sentence of a notice that waits says why: after the limit with its number, a single turn in the singular, or after a stop with none', () => {
  const line = 'j21 done · stage 21 · 7m 38s';
  assert.equal(
    waitingSentence(line, { why: 'limit', most: 20 }),
    'j21 done · stage 21 · 7m 38s · waits for your message after 20 turns in a row started by jobs',
  );
  assert.equal(
    waitingSentence(line, { why: 'limit', most: 1 }),
    'j21 done · stage 21 · 7m 38s · waits for your message after 1 turn started by jobs',
  );
  assert.equal(
    waitingSentence(line, { why: 'stopped' }),
    'j21 done · stage 21 · 7m 38s · waits for your message',
  );
});
