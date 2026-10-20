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

test('a quick connect password reaches SSH as a one-time secret and dies with the conversation', async (t) => {
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
  // The conversation going away takes the one-time password with it.
  const name = seen.target?.passwordSecret ?? '';
  sessions.releaseSession('c1');
  assert.equal(seen.env?.secret(name), '');
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
