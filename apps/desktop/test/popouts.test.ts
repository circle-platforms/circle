import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PopoutEvent } from '../src/contracts.ts';
import {
  MAX_POPOUT_TITLE,
  Popouts,
  validPopoutAddress,
  validPopoutKind,
  validPopoutSession,
  validPopoutTitle,
  type PopoutHooks,
  type PopoutWindow,
} from '../src/popouts.ts';

/**
 * A window as Electron closes one: `close` says at once that it is closing, its page
 * unloads, and only later is it closed and destroyed. `hold` keeps it closing until
 * `finish` is called.
 */
class FakeWindow implements PopoutWindow {
  closing = false;
  destroyed = false;
  shown = 0;
  focused = 0;
  title = '';
  hold = false;
  constructor(
    readonly kind: string,
    readonly session: string,
    private hooks: Pick<PopoutHooks<FakeWindow>, 'closing' | 'closed'>,
  ) {}
  isDestroyed() {
    return this.destroyed;
  }
  show() {
    this.shown++;
  }
  focus() {
    this.focused++;
  }
  setTitle(title: string) {
    this.title = title;
  }
  close() {
    if (this.closing || this.destroyed) return;
    this.closing = true;
    this.hooks.closing();
    if (!this.hold) setImmediate(() => this.finish());
  }
  finish() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hooks.closed();
  }
}

/** Every window that was asked to close has closed. */
const settle = () => new Promise<void>((done) => setImmediate(done));

function fixture(delay = false) {
  const events: PopoutEvent[] = [];
  const made: FakeWindow[] = [];
  const release: Array<() => void> = [];
  const popouts = new Popouts<FakeWindow>({
    create: async (kind, session, title, hooks) => {
      const window = new FakeWindow(kind, session, hooks);
      window.title = title;
      made.push(window);
      hooks.created(window);
      if (delay) await new Promise<void>((resolve) => release.push(resolve));
      return window;
    },
    onChange: (event) => events.push(event),
  });
  return { popouts, events, made, release };
}

test('a mode opens in one window, and opening it again brings that window forward', async () => {
  const { popouts, events, made } = fixture();
  await popouts.open('browser', 's1', 'browser · first');
  assert.equal(made.length, 1);
  assert.deepEqual(events, [{ kind: 'browser', sessionId: 's1', open: true }]);
  await popouts.open('browser', 's1', 'browser · renamed');
  assert.equal(made.length, 1, 'no second window');
  assert.equal(made[0]!.title, 'browser · renamed');
  assert.deepEqual([made[0]!.shown, made[0]!.focused], [1, 1]);
  assert.equal(events.length, 1, 'bringing it forward is no change');
  // The terminal of the same conversation, and the browser of another, are windows of their own.
  await popouts.open('terminal', 's1', 'terminal · first');
  await popouts.open('browser', 's2', 'browser · second');
  assert.equal(made.length, 3);
  assert.deepEqual(
    popouts
      .list()
      .map((one) => `${one.kind}:${one.sessionId}`)
      .sort(),
    ['browser:s1', 'browser:s2', 'terminal:s1'],
  );
});

test('two presses before the window is up make one window', async () => {
  const { popouts, made, release } = fixture(true);
  const first = popouts.open('terminal', 's1', 't');
  const second = popouts.open('terminal', 's1', 't');
  release.splice(0).forEach((go) => go());
  await Promise.all([first, second]);
  assert.equal(made.length, 1);
});

test('closing a window by hand puts the mode back, and says so', async () => {
  const { popouts, events, made } = fixture();
  await popouts.open('browser', 's1', 'b');
  made[0]!.close();
  // Gone from the moment it begins to close, before it is destroyed.
  assert.equal(made[0]!.destroyed, false);
  assert.equal(popouts.has('browser', 's1'), false);
  assert.deepEqual(events.at(-1), {
    kind: 'browser',
    sessionId: 's1',
    open: false,
  });
  await settle();
  assert.equal(made[0]!.destroyed, true);
  assert.equal(events.filter((event) => !event.open).length, 1, 'said once');
  // A later press makes a new window.
  await popouts.open('browser', 's1', 'b');
  assert.equal(made.length, 2);
});

test('pressing a mode again while its window is closing makes a new window, which stays', async () => {
  const { popouts, events, made } = fixture();
  await popouts.open('browser', 's1', 'b');
  made[0]!.hold = true;
  made[0]!.close();
  assert.equal(made[0]!.isDestroyed(), false, 'still closing');
  await popouts.open('browser', 's1', 'b again');
  assert.equal(made.length, 2, 'a new window, not the dying one');
  assert.deepEqual(
    [made[0]!.shown, made[0]!.focused],
    [0, 0],
    'the closing window is not brought forward',
  );
  assert.equal(popouts.window('browser', 's1'), made[1]);
  // The old window finishes closing: the new one is still the mode's window.
  made[0]!.finish();
  assert.equal(popouts.has('browser', 's1'), true);
  assert.equal(popouts.window('browser', 's1'), made[1]);
  assert.deepEqual(popouts.list(), [{ kind: 'browser', sessionId: 's1' }]);
  assert.deepEqual(events, [
    { kind: 'browser', sessionId: 's1', open: true },
    { kind: 'browser', sessionId: 's1', open: false },
    { kind: 'browser', sessionId: 's1', open: true },
  ]);
  // And docking closes the new window, not the closed one.
  popouts.dock('browser', 's1');
  assert.equal(made[1]!.closing, true);
  await settle();
  assert.equal(popouts.has('browser', 's1'), false);
});

test('a window closing while its page loads is gone: a press makes another', async () => {
  const { popouts, made, release, events } = fixture(true);
  const first = popouts.open('terminal', 's1', 't');
  made[0]!.hold = true;
  made[0]!.close();
  const second = popouts.open('terminal', 's1', 't');
  assert.equal(made.length, 2, 'the press did not wait on the closing window');
  release.splice(0).forEach((go) => go());
  await Promise.all([first, second]);
  made[0]!.finish();
  assert.equal(popouts.window('terminal', 's1'), made[1]);
  assert.deepEqual(events, [{ kind: 'terminal', sessionId: 's1', open: true }]);
});

test('docking closes the window; docking all, or all but one conversation, closes the rest', async () => {
  const { popouts, events, made } = fixture();
  await popouts.open('browser', 's1', 'b1');
  await popouts.open('terminal', 's1', 't1');
  await popouts.open('browser', 's2', 'b2');
  popouts.dock('browser', 's1');
  assert.equal(made[0]!.closing, true);
  assert.equal(popouts.has('terminal', 's1'), true);
  popouts.dockOthers('s2');
  assert.deepEqual(popouts.list(), [{ kind: 'browser', sessionId: 's2' }]);
  popouts.dockAll();
  assert.deepEqual(popouts.list(), []);
  await settle();
  assert.deepEqual(
    made.map((window) => window.destroyed),
    [true, true, true],
  );
  assert.equal(events.filter((event) => !event.open).length, 3);
  // Docking what is not open is nothing.
  popouts.dock('terminal', 's9');
});

test('a window closed while it was still opening is not kept', async () => {
  const events: PopoutEvent[] = [];
  const popouts = new Popouts<FakeWindow>({
    create: async (kind, session, _title, hooks) => {
      const window = new FakeWindow(kind, session, hooks);
      hooks.created(window);
      window.close();
      return window;
    },
    onChange: (event) => events.push(event),
  });
  await popouts.open('browser', 's1', 'b');
  assert.deepEqual(popouts.list(), []);
  await settle();
  assert.deepEqual(popouts.list(), []);
  assert.deepEqual(events, []);
});

test('a window is known by the mode it shows while it is open or closing, and not after', async () => {
  const { popouts, made } = fixture();
  await popouts.open('browser', 's1', 'b');
  await popouts.open('terminal', 's2', 't');
  assert.deepEqual(popouts.owner(made[0]!), {
    kind: 'browser',
    sessionId: 's1',
  });
  assert.deepEqual(popouts.owner(made[1]!), {
    kind: 'terminal',
    sessionId: 's2',
  });
  made[0]!.hold = true;
  made[0]!.close();
  // A closing window's page is still answered, as its own.
  assert.deepEqual(popouts.owner(made[0]!), {
    kind: 'browser',
    sessionId: 's1',
  });
  assert.equal(popouts.all().includes(made[0]!), true);
  made[0]!.finish();
  assert.equal(popouts.owner(made[0]!), undefined);
  assert.equal(popouts.all().includes(made[0]!), false);
  const stranger = new FakeWindow('browser', 's1', {
    closing: () => {},
    closed: () => {},
  });
  assert.equal(popouts.owner(stranger), undefined);
});

test('what the renderer sends is checked before a window is made', () => {
  assert.equal(validPopoutKind('browser'), 'browser');
  assert.equal(validPopoutKind('terminal'), 'terminal');
  for (const value of ['files', '', undefined, 3, 'browser:x'])
    assert.throws(() => validPopoutKind(value), /invalid window kind/);
  assert.equal(validPopoutSession('abc-123_x'), 'abc-123_x');
  for (const value of ['', 'a/b', 'a b', '../x', 'x'.repeat(101), 5])
    assert.throws(() => validPopoutSession(value), /invalid conversation/);
  assert.equal(
    validPopoutTitle(' Browser · Fix the race \n'),
    'Browser · Fix the race',
  );
  assert.equal(MAX_POPOUT_TITLE, 200);
  assert.equal(validPopoutTitle('x'.repeat(200)), 'x'.repeat(200));
  for (const value of ['', '   ', 'x'.repeat(201), null])
    assert.throws(() => validPopoutTitle(value), /invalid window title/);
});

test('an address for the browser window is a web address, as an extension may open', () => {
  assert.equal(
    validPopoutAddress('https://example.test/a?b=1'),
    'https://example.test/a?b=1',
  );
  assert.equal(
    validPopoutAddress('http://127.0.0.1:8080'),
    'http://127.0.0.1:8080/',
  );
  for (const value of [
    '',
    'example.test',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'circle://workbench/index.html',
    'https://user:secret@example.test/',
    'https://example.test/' + 'x'.repeat(4096),
    5,
    null,
  ])
    assert.throws(() => validPopoutAddress(value), /invalid address/);
});
