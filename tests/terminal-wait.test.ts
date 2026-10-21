// The wait, list and hand mechanics of the session manager, against a fake device whose
// bytes the test pushes by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TerminalSessions,
  type TerminalSessionsOptions,
} from '../src/terminal/sessions.js';
import type {
  ConnectEnv,
  Connector,
  TerminalTarget,
  TerminalTransport,
} from '../src/terminal/transport.js';
import type { TerminalProfile } from '../src/terminal/profiles.js';
import { telnetConnector } from '../src/terminal/telnet.js';
import { sshConnector } from '../src/terminal/ssh.js';

class FakeConsole implements TerminalTransport {
  private data: (bytes: Buffer) => void = () => {};
  private end: (reason: string) => void = () => {};
  typed: Buffer[] = [];
  sizes: { cols: number; rows: number }[] = [];
  closed = false;
  onData(handler: (bytes: Buffer) => void): void {
    this.data = handler;
  }
  onEnd(handler: (reason: string) => void): void {
    this.end = handler;
  }
  write(bytes: Buffer | string): void {
    this.typed.push(Buffer.from(bytes as never));
  }
  resize(cols: number, rows: number): void {
    this.sizes.push({ cols, rows });
  }
  close(): void {
    this.closed = true;
    this.end('disconnected');
  }
  /** What the device shows. */
  emit(text: string): void {
    this.data(Buffer.from(text, 'latin1'));
  }
  died(reason: string): void {
    this.end(reason);
  }
}

const signal = new AbortController().signal;

function harness(
  options: Partial<Pick<TerminalSessionsOptions, 'profiles' | 'hand'>> = {},
) {
  let console = new FakeConsole();
  let askHost = false;
  const connector: Connector = async () => {
    if (askHost)
      return {
        hostkey: { host: 'a.lan:23', keyType: '', fingerprint: 'SHA256:x' },
      };
    return { transport: console };
  };
  const sessions = new TerminalSessions({
    connectors: { ssh: connector, telnet: connector },
    profiles: options.profiles ?? ((): TerminalProfile[] => []),
    secret: () => '',
    keyFile: (path) => path,
    onChange: () => {},
    ...(options.hand ? { hand: options.hand } : {}),
  });
  const open = async (id = 'c1') => {
    const result = await sessions.request(
      id,
      'connect',
      { host: 'a.lan', transport: 'telnet' },
      signal,
    );
    return result;
  };
  return {
    sessions,
    open,
    device: () => console,
    needHostKey: (on = true) => {
      askHost = on;
    },
    replaceDevice(next: FakeConsole) {
      console = next;
    },
  };
}

test('wait: quiet resolves what rests, pattern resolves what arrives, timeout bounds the rest', async (t) => {
  const h = harness();
  t.after(() => h.sessions.close());
  await h.open();
  // The screen has rested since connect's own settle: a short idle answers at once
  const quiet = await h.sessions.request(
    'c1',
    'wait',
    { session: 't1', idle_ms: 100, timeout_ms: 1000 },
    signal,
  );
  assert.match(quiet.text, /quiet for 0\.1s/);
  // A pattern that is not on the screen yet arrives mid-wait. A busy runner delays the
  // timers: the caps are wide, and only the capped case leans on time.
  const pattern = (async () => {
    setTimeout(() => h.device().emit('booting...\r\n'), 50);
    setTimeout(() => h.device().emit('READY\r\ncon> '), 250);
    return h.sessions.request(
      'c1',
      'wait',
      { session: 't1', pattern: 'READY', idle_ms: 30000, timeout_ms: 30000 },
      signal,
    );
  })();
  const late = (await pattern).text;
  assert.match(late, /matched READY/);
  assert.match(late, /con>/);
  // A session that dies mid-wait answers with that, not a timeout
  setTimeout(() => h.device().died('the cable was cut'), 100);
  const dead = await h.sessions.request(
    'c1',
    'wait',
    { session: 't1', pattern: 'NEVER', idle_ms: 30000, timeout_ms: 20000 },
    signal,
  );
  assert.match(dead.text, /the session ended: the cable was cut/);
  // A pattern on a fresh console that never comes is bounded: its own conversation
  const h2 = harness();
  t.after(() => h2.sessions.close());
  await h2.open('c2');
  const capped = await h2.sessions.request(
    'c2',
    'wait',
    { session: 't1', pattern: 'NEVER', idle_ms: 30000, timeout_ms: 1200 },
    signal,
  );
  assert.match(capped.text, /still going after 1s/);
});

/**
 * Resolves once a wait on the console has begun, so what the device prints next is
 * printed during it; given the check of an earlier attempt, once the next one began.
 * It follows the wait's own state, never the runner's clock.
 */
async function waitBegun(
  h: ReturnType<typeof harness>,
  conversation: string,
  earlier?: () => void,
): Promise<() => void> {
  const session = h.sessions.session(conversation, 't1')!;
  for (let turn = 0; turn < 100_000; turn++) {
    const [check] = session.watchers;
    if (check && check !== earlier) return check;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error('the wait never began');
}
/** The lines of a result's During the wait section, and nothing after it. */
function during(text: string): string[] {
  const [, section] = text.split('\n### During the wait\n');
  assert.ok(section !== undefined, `no During the wait section in:\n${text}`);
  return section.split('\n### ')[0]!.split('\n');
}

test('wait: changed is exactly what the device printed during the wait', async (t) => {
  // Each screen is one where counting the session's buffer lines went wrong.
  const old = (count: number) =>
    Array.from({ length: count }, (_, n) => `old line ${n}\r\n`).join('');
  const cases: [string, string, string, string[]][] = [
    [
      'a screen that has not scrolled yet',
      'before the wait\r\n',
      'first new line\r\nsecond new line\r\nEND\r\n',
      ['first new line', 'second new line', 'END'],
    ],
    [
      'scrollback at its 2000-line cap',
      old(2100),
      'new line\r\nEND\r\n',
      ['new line', 'END'],
    ],
    [
      'a screen cleared before the wait',
      old(30) + '\x1b[H\x1b[2J\x1b[3J',
      'after the clear\r\nEND\r\n',
      ['after the clear', 'END'],
    ],
    [
      'a full-screen program the wait sees end',
      old(200) + '\x1b[?1049hpager page\r\n',
      '\x1b[?1049l$ back at the prompt\r\nEND\r\n',
      ['$ back at the prompt', 'END'],
    ],
    [
      'a clear during the wait',
      old(3),
      'one\r\ntwo\r\n\x1b[H\x1b[2J\x1b[3Jthree\r\nEND\r\n',
      ['one', 'two', 'three', 'END'],
    ],
  ];
  for (const [name, before, printed, expected] of cases) {
    const h = harness();
    t.after(() => h.sessions.close());
    await h.open(name);
    h.device().emit(before);
    const waited = h.sessions.request(
      name,
      'wait',
      {
        session: 't1',
        pattern: 'END',
        changed: true,
        idle_ms: 30000,
        timeout_ms: 30000,
      },
      signal,
    );
    await waitBegun(h, name);
    h.device().emit(printed);
    assert.deepEqual(during((await waited).text), expected, name);
  }
  // Nothing printed is said as such, not as an empty section.
  const h = harness();
  t.after(() => h.sessions.close());
  await h.open('quiet');
  h.device().emit('sw1# ');
  const quiet = await h.sessions.request(
    'quiet',
    'wait',
    { session: 't1', changed: true, idle_ms: 100, timeout_ms: 1000 },
    signal,
  );
  assert.match(quiet.text, /quiet for 0\.1s/);
  assert.deepEqual(during(quiet.text), ['(the device printed nothing)']);
});

test('wait: absent looks only at what the device printed since the wait began, and names that line', async (t) => {
  const h = harness();
  t.after(() => h.sessions.close());
  await h.open();
  // An earlier step's deliberate mistake is still on the screen
  h.device().emit('% Invalid input detected at the earlier step\r\nsw1# ');
  const passed = h.sessions.request(
    'c1',
    'wait',
    {
      session: 't1',
      pattern: 'READY',
      absent: 'Invalid input',
      idle_ms: 30000,
      timeout_ms: 30000,
    },
    signal,
  );
  await waitBegun(h, 'c1');
  h.device().emit('READY\r\nsw1# ');
  assert.match(
    (await passed).text,
    /· matched READY on the line: sw1# READY\n/,
  );
  // This step's own mistake ends its wait at once, even with a pattern that would never
  // match, and the result names the new line rather than the earlier one.
  const failed = h.sessions.request(
    'c1',
    'wait',
    {
      session: 't1',
      pattern: 'NEVER',
      absent: 'Invalid input',
      idle_ms: 30000,
      timeout_ms: 30000,
    },
    signal,
  );
  await waitBegun(h, 'c1');
  h.device().emit('% Invalid input detected at step two\r\nsw1# ');
  assert.match(
    (await failed).text,
    /· the absent pattern Invalid input appeared on the line: % Invalid input detected at step two\n/,
  );
});

test('wait: an absent line that arrives with the expected one still fails the check', async (t) => {
  const h = harness();
  t.after(() => h.sessions.close());
  await h.open();
  const waited = h.sessions.request(
    'c1',
    'wait',
    {
      session: 't1',
      pattern: 'sw1#',
      absent: 'Invalid input',
      idle_ms: 30000,
      timeout_ms: 30000,
    },
    signal,
  );
  await waitBegun(h, 'c1');
  // One burst: the screen shows the prompt the pattern wants as soon as the error
  h.device().emit('% Invalid input detected\r\nsw1# ');
  assert.match(
    (await waited).text,
    /· the absent pattern Invalid input appeared on the line: % Invalid input detected\n/,
  );
});

test('wait: retries wait again after a timeout, on a clock the test drives', async (t) => {
  const h = harness();
  t.after(() => h.sessions.close());
  await h.open();
  // The wait's clock and ticks are the test's: no timer of the runner races the cap.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  // The answer comes once the first attempt has run out: the second one sees it.
  const retried = h.sessions.request(
    'c1',
    'wait',
    {
      session: 't1',
      pattern: 'LATE READY',
      idle_ms: 30000,
      timeout_ms: 1000,
      retries: 3,
    },
    signal,
  );
  const first = await waitBegun(h, 'c1');
  t.mock.timers.tick(1050);
  await waitBegun(h, 'c1', first);
  h.device().emit('LATE READY\r\n');
  assert.match(
    (await retried).text,
    /· matched LATE READY in 2 attempts on the line: LATE READY\n/,
  );
  // Without retries the same silence is a timeout, as before.
  const capped = h.sessions.request(
    'c1',
    'wait',
    { session: 't1', pattern: 'NEVER', idle_ms: 30000, timeout_ms: 1000 },
    signal,
  );
  await waitBegun(h, 'c1');
  t.mock.timers.tick(1050);
  const once = (await capped).text;
  assert.match(once, /· still going after 1s\n/);
  assert.doesNotMatch(once, /attempts/);
  // Every attempt used up: the result counts them all.
  const exhausted = h.sessions.request(
    'c1',
    'wait',
    {
      session: 't1',
      pattern: 'NEVER',
      idle_ms: 30000,
      timeout_ms: 1000,
      retries: 2,
    },
    signal,
  );
  let attempt = await waitBegun(h, 'c1');
  for (let next = 0; next < 2; next++) {
    t.mock.timers.tick(1050);
    attempt = await waitBegun(h, 'c1', attempt);
  }
  t.mock.timers.tick(1050);
  assert.match(
    (await exhausted).text,
    /· still going after 3s in 3 attempts\n/,
  );
});

test('a quick connect password reaches SSH as a one-time secret, gone once the connector read it', async (t) => {
  const device = new FakeConsole();
  const seen: {
    target?: TerminalTarget;
    env?: ConnectEnv;
    secret?: string;
  } = {};
  const connector: Connector = async (target, env) => {
    seen.target = target;
    seen.env = env;
    seen.secret = target.passwordSecret
      ? env.secret(target.passwordSecret)
      : '';
    return { transport: device };
  };
  const sessions = new TerminalSessions({
    connectors: { ssh: connector, telnet: connector },
    profiles: () => [],
    secret: () => '',
    keyFile: (path) => path,
    onChange: () => {},
  });
  t.after(() => sessions.close());
  await sessions.request(
    'c1',
    'connect',
    { host: 'a.lan', transport: 'ssh', user: 'admin', password: 'pw1' },
    signal,
  );
  assert.match(seen.target?.passwordSecret ?? '', /^once:/);
  assert.equal(seen.secret, 'pw1');
  // The password is a secret name on the wire level, never text in a result.
  const list = await sessions.request('c1', 'sessions', {}, signal);
  assert.doesNotMatch(list.text, /pw1/);
  // The connector read it as it started; after that no name reaches it.
  const name = seen.target?.passwordSecret ?? '';
  assert.equal(seen.env?.secret(name), '');
});

test('closing a console the person holds goes through at once and frees what waited on it', async (t) => {
  const h = harness();
  t.after(() => h.sessions.close());
  await h.open();
  assert.equal(h.sessions.attach('c1', 't1'), true);
  let outcome: unknown = false;
  const parked = h.sessions.request(
    'c1',
    'send',
    { session: 't1', text: 'later', enter: true },
    signal,
  );
  parked.then(
    () => (outcome = 'sent'),
    (error) =>
      (outcome = error instanceof Error ? error.message : String(error)),
  );
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(
    outcome,
    false,
    'a send waits while the person holds the console',
  );
  // Closing it is their own act: it does not queue behind their own hold.
  h.sessions.disconnectForPerson('c1', 't1');
  assert.equal(
    h.sessions.views('c1').find((view) => view.id === 't1')?.state,
    'closed',
  );
  const deadline = Date.now() + 4000;
  while (outcome === false && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 20));
  assert.notEqual(outcome, false, 'the parked send stopped waiting');
  assert.match(String(outcome), /is closed/);
});

test("Circle's own disconnect of a console the person holds waits until they give it back", async (t) => {
  const h = harness();
  t.after(() => h.sessions.close());
  await h.open();
  assert.equal(h.sessions.attach('c1', 't1'), true);
  let closed: unknown = false;
  const asked = h.sessions.request(
    'c1',
    'disconnect',
    { session: 't1' },
    signal,
  );
  asked.then((result) => (closed = result.text));
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(closed, false, 'the model cut off a console the person holds');
  assert.equal(
    h.sessions.views('c1').find((view) => view.id === 't1')?.state,
    'ready',
  );
  h.sessions.detach('c1', 't1');
  assert.match((await asked).text, /was cut off/);
});

test('wait: an aborted stop is an error, not a result', async (t) => {
  const h = harness();
  t.after(() => h.sessions.close());
  await h.open();
  const stop = new AbortController();
  const waiting = h.sessions.request(
    'c1',
    'wait',
    { session: 't1', pattern: 'NEVER', idle_ms: 30000, timeout_ms: 60000 },
    stop.signal,
  );
  setTimeout(() => stop.abort(Error('the user stopped it')), 60);
  await assert.rejects(waiting, /the user stopped it/);
});

test('a handoff parks the model until the person gives the console back', async (t) => {
  let released: (() => void) | undefined;
  const card = (
    _conversation: string,
    _session: string,
    _reason: string,
    _signal: AbortSignal,
  ) => new Promise<void>((done) => (released = done));
  const h = harness({ hand: card });
  t.after(() => h.sessions.close());
  await h.open();
  let done = false;
  const handing = h.sessions
    .request(
      'c1',
      'handoff',
      { session: 't1', reason: 'type the console password' },
      signal,
    )
    .then((result) => {
      done = true;
      return result;
    });
  // Wait until the action has reached the card, then check it truly waits there
  const cardRose = () => released !== undefined;
  for (let at = 0; at < 320 && !cardRose(); at++)
    await new Promise((finish) => setTimeout(finish, 25));
  assert.ok(cardRose(), 'the handoff never reached the person');
  assert.equal(done, false);
  // The person types, then continues
  assert.equal(h.sessions.input('c1', 't1', 's3cret\r'), true);
  released?.();
  h.sessions.detach('c1', 't1');
  const result = await handing;
  assert.match(
    result.text,
    /handed to the user for: type the console password/,
  );
  assert.match(result.text, /the user typed/);
  assert.match(result.text, /gave the terminal back/);
  assert.equal(result.text.includes('s3cret'), false);
  assert.deepEqual(
    h.device().typed.map((bytes) => bytes.toString()),
    ['s3cret\r'],
  );
});

test('terminal_sessions lists what is open and what is saved', async (t) => {
  const h = harness({
    profiles: () => [
      {
        name: 'lab',
        transport: 'ssh',
        host: 'sw.lan',
        port: 22,
        user: 'operator',
        passwordSecret: 'P',
        cols: 80,
        rows: 24,
      },
    ],
  });
  t.after(() => h.sessions.close());
  await h.open();
  const list = await h.sessions.request('c1', 'sessions', {}, signal);
  assert.match(list.text, /### Terminals\n- t1 · a\.lan:23 · telnet a\.lan:23/);
  assert.match(list.text, /### Profiles\n- lab \(ssh sw\.lan:22\)/);
  // Reading a device that is not there says so plainly, and nothing else broke
  await assert.rejects(
    h.sessions.request('c1', 'read', { session: 't9' }, signal),
    /no terminal t9/,
  );
  h.sessions.releaseSession('c1');
  const empty = await h.sessions.request('c1', 'sessions', {}, signal);
  assert.match(empty.text, /- none/);
});

test('press takes the named keys, and refuses what it does not know', async (t) => {
  const h = harness();
  t.after(() => h.sessions.close());
  await h.open();
  await h.sessions.request(
    'c1',
    'press',
    { session: 't1', key: 'Ctrl_C' },
    signal,
  );
  await h.sessions.request(
    'c1',
    'press',
    { session: 't1', key: 'ArrowUp' },
    signal,
  );
  assert.deepEqual(
    h.device().typed.map((bytes) => bytes.toString('latin1')),
    ['\x03', '\x1b[A'],
  );
  await assert.rejects(
    h.sessions.request('c1', 'press', { session: 't1', key: 'F7' }, signal),
    /no such key: F7/,
  );
});
