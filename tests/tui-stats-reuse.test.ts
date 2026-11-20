import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionApp, statsReuseMs } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { scratch, cleanup } from './helpers.js';

test('the usage statistics are reused for a quarter second, or ten times what reading them cost, at most ten seconds', () => {
  assert.equal(statsReuseMs(0), 250);
  assert.equal(statsReuseMs(10), 250);
  assert.equal(statsReuseMs(120), 1200);
  assert.equal(statsReuseMs(5000), 10_000);
});

test('repaints in a row read the usage statistics once, read again when the wait is over, the turn state changes or the conversation gains a message, and never share the costs they show', async (t) => {
  const home = scratch(t),
    workspace = scratch(t),
    settings = defaultSettings();
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  app.terminal = {
    platform: process.platform,
    write: () => {},
    input: () => {},
    kill: () => {},
  };
  await app.attach({
    workspace,
    home,
    settings,
    model: new ScriptedModel([]),
    headless: true,
  });
  cleanup(t, () => app.close());
  const runtime = app.runtime!;
  const stats = runtime.stats.bind(runtime);
  let reads = 0;
  runtime.stats = () => {
    reads++;
    return stats();
  };
  ui.statsMemo = undefined;
  for (let n = 0; n < 20; n++) ui.repaint();
  assert.equal(reads, 1, 'twenty repaints in a row read the statistics once');
  // The wait is over: the next repaint reads again.
  ui.statsMemo.at -= 300;
  ui.repaint();
  assert.equal(reads, 2);
  // A reading that cost 400 ms is reused for four seconds, not a quarter second.
  ui.statsMemo.cost = 400;
  ui.statsMemo.at -= 300;
  ui.repaint();
  assert.equal(reads, 2, 'a costly reading is reused for longer');
  ui.statsMemo.at -= 4000;
  ui.repaint();
  assert.equal(reads, 3);
  // The turn state changed: the numbers of the turn that ended are read at once.
  ui.statsMemo.busy = !runtime.busy;
  ui.repaint();
  assert.equal(reads, 4);
  // A message this conversation gained: its usage is in the footer on the next repaint.
  ui.statsMemo.busy = runtime.busy;
  runtime.store.append(runtime.session.id, [
    { id: 'gained', role: 'user', content: 'one more' },
  ]);
  ui.repaint();
  assert.equal(reads, 5);
  ui.repaint();
  assert.equal(reads, 5);
  // What one repaint adds to the costs it shows does not reach the next.
  const first = ui.runtimeStats(),
    second = ui.runtimeStats();
  first.costs.amounts.USD = 123;
  first.usage.input_tokens = 99;
  assert.notEqual(second.costs.amounts.USD, 123);
  assert.notEqual(ui.runtimeStats().usage.input_tokens, 99);
  assert.equal(reads, 5);
});
