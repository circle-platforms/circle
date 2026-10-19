// The person's own terminal tabs as the main process's terminal host carries them: the
// runtime's word about each tab rides the window's terminal state, and the person's
// take, return and stop go back to the runtime. Device consoles are not touched.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalPanelHost } from '../src/terminal.ts';
import type { LocalTerminalRow, TerminalEvent } from '../src/contracts.ts';

async function host(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'circle-terminal-tabs-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'runtime-home');
  await mkdir(home, { recursive: true });
  const events: TerminalEvent[] = [];
  const asked: [string, string, string][] = [];
  const answer: LocalTerminalRow[] = [
    {
      id: 'local:tab-1',
      terminal: 'tab-1',
      ordinal: 1,
      state: 'held',
      allowed: true,
      held: 'attach',
    },
  ];
  const panel = new TerminalPanelHost(
    (event) => events.push(event),
    home,
    join(root, 'terminal-host-keys.json'),
    () => '',
    () => 'manual',
    async (conversation, session, action) => {
      asked.push([conversation, session, action]);
      return structuredClone(answer);
    },
  );
  t.after(() => panel.close());
  return { panel, events, asked, answer };
}

test('the runtime’s rows for a conversation’s tabs ride its terminal state, and are cleared when the runtime is gone', async (t) => {
  const f = await host(t);
  assert.deepEqual(f.panel.state('c1').local, []);
  const rows: LocalTerminalRow[] = [
    {
      id: 'local:tab-1',
      terminal: 'tab-1',
      ordinal: 1,
      state: 'operating',
      allowed: true,
    },
  ];
  f.panel.tabsChanged('c1', rows);
  const pushed = f.events.at(-1)!;
  assert(pushed.kind === 'state');
  assert.equal(pushed.state.conversation, 'c1');
  assert.deepEqual(pushed.state.local, rows);
  // another conversation is not told
  assert.deepEqual(f.panel.state('c2').local, []);
  f.panel.tabsGone();
  const cleared = f.events.at(-1)!;
  assert(cleared.kind === 'state');
  assert.deepEqual(cleared.state.local, []);
});

test('take, return and stop on a tab go to the runtime and answer with its state; a device console is no tab', async (t) => {
  const f = await host(t);
  assert.equal(f.panel.isTab('local:tab-1'), true);
  assert.equal(f.panel.isTab('t1'), false);
  const taken = await f.panel.tab('c1', 'local:tab-1', 'take');
  assert.deepEqual(taken.local, f.answer);
  await f.panel.tab('c1', 'local:tab-1', 'return');
  await f.panel.tab('c1', 'local:tab-1', 'stop');
  assert.deepEqual(f.asked, [
    ['c1', 'local:tab-1', 'take'],
    ['c1', 'local:tab-1', 'return'],
    ['c1', 'local:tab-1', 'stop'],
  ]);
  await assert.rejects(
    f.panel.tab('c1', 't1', 'stop'),
    /not one of the user's terminal tabs/,
  );
  await assert.rejects(
    f.panel.tab('c1', 'local:../x', 'take'),
    /invalid terminal/,
  );
  assert.equal(f.asked.length, 3);
  // a device console's take is still the host's own, synchronous
  const device = f.panel.attach('c1', 't1');
  assert.deepEqual(device.sessions, []);
});
