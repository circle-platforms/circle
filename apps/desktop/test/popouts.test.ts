import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PopoutEvent } from '../src/contracts.ts';
import {
  Popouts,
  validPopoutKind,
  validPopoutSession,
  validPopoutTitle,
  type PopoutWindow,
} from '../src/popouts.ts';

class FakeWindow implements PopoutWindow {
  destroyed = false;
  shown = 0;
  focused = 0;
  title = '';
  constructor(
    readonly kind: string,
    readonly session: string,
    private closed: () => void,
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
    if (this.destroyed) return;
    this.destroyed = true;
    this.closed();
  }
}

function fixture(delay = false) {
  const events: PopoutEvent[] = [];
  const made: FakeWindow[] = [];
  const release: Array<() => void> = [];
  const popouts = new Popouts<FakeWindow>({
    create: async (kind, session, title, hooks) => {
      const window = new FakeWindow(kind, session, hooks.closed);
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
  assert.equal(popouts.has('browser', 's1'), false);
  assert.deepEqual(events.at(-1), {
    kind: 'browser',
    sessionId: 's1',
    open: false,
  });
  // A later press makes a new window.
  await popouts.open('browser', 's1', 'b');
  assert.equal(made.length, 2);
});

test('docking closes the window; docking all, or all but one conversation, closes the rest', async () => {
  const { popouts, events, made } = fixture();
  await popouts.open('browser', 's1', 'b1');
  await popouts.open('terminal', 's1', 't1');
  await popouts.open('browser', 's2', 'b2');
  popouts.dock('browser', 's1');
  assert.equal(made[0]!.destroyed, true);
  assert.equal(popouts.has('terminal', 's1'), true);
  popouts.dockOthers('s2');
  assert.deepEqual(popouts.list(), [{ kind: 'browser', sessionId: 's2' }]);
  popouts.dockAll();
  assert.deepEqual(popouts.list(), []);
  assert.equal(events.filter((event) => !event.open).length, 3);
  // Docking what is not open is nothing.
  popouts.dock('terminal', 's9');
});

test('a window closed while it was still opening is not kept', async () => {
  const events: PopoutEvent[] = [];
  const popouts = new Popouts<FakeWindow>({
    create: async (kind, session, _title, hooks) => {
      const window = new FakeWindow(kind, session, hooks.closed);
      hooks.created(window);
      window.close();
      return window;
    },
    onChange: (event) => events.push(event),
  });
  await popouts.open('browser', 's1', 'b');
  assert.deepEqual(popouts.list(), []);
  assert.deepEqual(events, []);
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
  for (const value of ['', '   ', 'x'.repeat(201), null])
    assert.throws(() => validPopoutTitle(value), /invalid window title/);
});

test("a window is one of the application's while its page loads, and announced once it is up", async () => {
  const { popouts, events, release } = fixture(true);
  const opening = popouts.open('browser', 's1', 'b');
  await new Promise((done) => setImmediate(done));
  // Its page may already ask the main process for what it starts with.
  assert.equal(popouts.all().length, 1);
  assert.deepEqual(popouts.list(), [], 'not announced yet');
  assert.deepEqual(events, []);
  release.splice(0).forEach((go) => go());
  await opening;
  assert.deepEqual(popouts.list(), [{ kind: 'browser', sessionId: 's1' }]);
  assert.deepEqual(events, [{ kind: 'browser', sessionId: 's1', open: true }]);
});
