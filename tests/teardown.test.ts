import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AgentRuntime } from '../src/runtime.js';
import { SessionApp } from '../src/tui/session_app.js';
import { flushTerminalWrite } from '../src/tui/terminal_write.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

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
