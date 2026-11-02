import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AgentRuntime } from '../src/runtime.js';
import { SessionApp } from '../src/tui/session_app.js';
import {
  flushTerminalWrite,
  SETTLE_MS,
  settleTerminalInput,
} from '../src/tui/terminal_write.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { cleanup, scratch, until } from './helpers.js';

test('shutdown keeps raw input until the main-screen write actually completes', async (t) => {
  const root = scratch(t);
  const app = new SessionApp(root, root, defaultSettings());
  let inputEnabled = true;
  let written = '';
  let flushed: (() => void) | undefined;
  app.terminal.input = (enabled) => {
    inputEnabled = enabled;
  };
  t.mock.method(process.stdout, 'write', (text: string, done?: () => void) => {
    written += text;
    if (text.includes('\x1b[?1049l')) flushed = done;
    else done?.();
    return true;
  });
  const closing = app.close();
  try {
    assert.ok(flushed, 'the restore write must request completion');
    assert.equal(
      inputEnabled,
      true,
      'an unfinished write cannot enable cooked input',
    );
    assert.match(written, /\x1b\[\?1049l/);
  } finally {
    flushed?.();
    await closing;
  }
  assert.equal(
    inputEnabled,
    false,
    'cooked input returns after the buffer is restored',
  );
});

test('leaving reads the answers the terminal still owes, up to its device attributes', async () => {
  const input = new PassThrough();
  const asked: string[] = [];
  const output = {
    write: (text: string): void => {
      asked.push(text);
      // The colours asked at start come first, then the attributes, in two pieces
      input.write(
        '\x1b]10;rgb:2a2a/2424/2222\x07\x1b]11;rgb:f5f5/f0f0/f0f0\x07\x1b[?62;',
      );
      input.write('22c');
    },
  };
  assert.equal(await settleTerminalInput(input, output), true);
  assert.deepEqual(asked, ['\x1b[c']);
  assert.equal(input.listenerCount('data'), 0);
});

test('a terminal that does not answer is waited for at most SETTLE_MS', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new PassThrough();
  const settled = settleTerminalInput(input, { write: () => {} });
  t.mock.timers.tick(SETTLE_MS);
  assert.equal(await settled, false);
  assert.equal(input.listenerCount('data'), 0);
});

test('shutdown takes in what the terminal still owes before it gives the input back', async (t) => {
  const root = scratch(t);
  const app = new SessionApp(root, root, defaultSettings());
  const calls: string[] = [];
  let answered!: () => void;
  app.terminal.input = (enabled) => {
    calls.push(`input ${enabled}`);
  };
  app.terminal.write = (text) => {
    if (text.includes('\x1b[?1049l')) calls.push('restore');
  };
  app.terminal.settle = () => {
    calls.push('settle');
    return new Promise<void>((resolve) => (answered = resolve));
  };
  const closing = app.close();
  await until(() => calls.includes('settle'));
  await nextTurn();
  assert.deepEqual(
    calls,
    ['restore', 'settle'],
    "the input stays Circle's until the answers are in",
  );
  answered();
  await closing;
  assert.deepEqual(calls, ['restore', 'settle', 'input false']);
});

test('a failed restore write still restores input and closes the actual session store', async (t) => {
  const root = scratch(t);
  const settings = defaultSettings();
  const app = new SessionApp(root, root, settings);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model: new ScriptedModel(),
    headless: true,
  });
  app.runtime = runtime;
  let restoredInput = false;
  app.terminal.input = (enabled) => {
    restoredInput = !enabled;
  };
  const failure = new Error('the console output pipe closed');
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(failure);
    },
  });
  app.terminal.write = (text) => flushTerminalWrite(output, text);
  await assert.rejects(app.close(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.equal(restoredInput, true);
  assert.throws(
    () => runtime.store.get(runtime.session.id),
    /closed|not open/i,
  );
  await nextTurn();
  assert.equal(output.destroyed, true);
  assert.equal(output.listenerCount('error'), 0);
});

test('a repaint that comes after the runtime closed reads nothing from the closed session store', async (t) => {
  const root = scratch(t);
  const settings = defaultSettings();
  const app = new SessionApp(root, root, settings);
  const ui = app as any;
  let painted = 0;
  ui.screen.render = () => {
    painted++;
  };
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  app.runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model: new ScriptedModel(),
    headless: true,
  });
  ui.repaint();
  assert.equal(painted, 1);
  // a stopped job or a late reply settles after leaving and asks for a repaint
  await app.runtime.close();
  app.runtime.store.get = () => {
    throw new Error('late store get');
  };
  app.runtime.store.messages = () => {
    throw new Error('late store messages');
  };
  assert.doesNotThrow(() => ui.repaint());
  assert.equal(painted, 1);
});
