import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { acquireSessionLease } from '../src/session_lock.js';
import {
  noticeFor,
  noticeLocale,
  notesSince,
  releaseNotesUrl,
} from '../src/whats_new.js';
import {
  circleHasHistory,
  dismissWhatsNew,
  hadCircleServer,
  notesBaseline,
  pendingWhatsNew,
  seedWhatsNewFrom,
} from '../src/whats_new_state.js';
import { whatsNewRows } from '../src/tui/whats_new_rows.js';
import { stripAnsi } from '../src/ink/string_width.js';
import { VERSION } from '../src/version.js';
import { cleanup, scratch } from './helpers.js';

test('notes cover the releases after the one last seen', () => {
  const hub = { hub: true };
  assert.equal(notesSince(undefined, VERSION, hub).length, 3);
  assert.equal(notesSince('1.6.0', '1.7.4').length, 2);
  assert.equal(notesSince('1.6.0', '1.7.4', hub).length, 3);
  assert.equal(notesSince('1.7.0', '1.7.4').length, 2);
  assert.equal(notesSince('1.7.4', '1.7.4', hub).length, 0);
  assert.equal(notesSince('0.5.0', '1.6.0', hub).length, 0);
  assert.equal(notesSince('1.7.4', '1.8.0', hub).length, 0);
  const notice = noticeFor('1.7.4', notesSince('1.6.0', '1.7.4', hub));
  assert.equal(notice?.link, releaseNotesUrl('1.7.4'));
  assert.equal(notice?.link.includes('blob/main'), false);
  assert.match(notice!.title.en, /1\.7\.0–1\.7\.4/);
  assert.match(notice!.items[0]!.en, /circle-server/);
  assert.match(notice!.items[0]!['zh-CN'], /原先的 circle-server/);
  assert.match(notice!.items[1]!.en, /alt\+L/);
  assert.equal(notice!.items[1]!.en.includes('alt+i'), false);
  assert.match(notice!.items[2]!.en, /medium/);
  assert.equal(notice!.items[2]!['zh-CN'].includes('那个 xhigh'), false);
  assert.equal(noticeLocale({ LANG: 'zh_CN.UTF-8' }), 'zh-CN');
  assert.equal(noticeLocale({ LANGUAGE: 'zh_CN:en' }), 'zh-CN');
  assert.equal(noticeLocale({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(noticeLocale({ LC_ALL: 'C' }), 'en');
});

test('a later version shows only the releases that were skipped', (t) => {
  const home = scratch(t);
  writeFileSync(join(home, 'credentials.json'), '{}\n');
  assert.equal(pendingWhatsNew(home, '1.8.0', ''), undefined);
  assert.equal(
    JSON.parse(readFileSync(join(home, 'whats-new.json'), 'utf8')).seen,
    '1.8.0',
  );
  const prefix = scratch(t);
  mkdirSync(join(prefix, 'versions', '1.6.0'), { recursive: true });
  mkdirSync(join(prefix, 'versions', '1.7.4'), { recursive: true });
  assert.equal(notesBaseline('1.8.0', undefined, prefix), '1.7.4');
  const from16 = scratch(t);
  mkdirSync(join(from16, 'versions', '1.6.0'), { recursive: true });
  const older = scratch(t);
  writeFileSync(join(older, 'credentials.json'), '{}\n');
  const notice = pendingWhatsNew(older, '1.8.0', from16);
  assert.match(notice!.title.en, /what's new in 1\.7\.4/);
  assert.match(notice!.items.map((item) => item.en).join('\n'), /alt\+L/);
  assert.equal(
    notice!.items.some((item) => /circle-server/.test(item.en)),
    false,
  );
  const seeded = scratch(t);
  seedWhatsNewFrom(seeded, '1.6.0', '1.8.0');
  assert.equal(
    JSON.parse(readFileSync(join(seeded, 'whats-new.json'), 'utf8')).seen,
    '1.6.0',
  );
  seedWhatsNewFrom(seeded, '1.0.0', '1.8.0');
  assert.equal(
    JSON.parse(readFileSync(join(seeded, 'whats-new.json'), 'utf8')).seen,
    '1.6.0',
  );
});

test('a first run records the version and an upgrade shows the notice once', (t) => {
  const fresh = scratch(t);
  assert.equal(circleHasHistory(fresh), false);
  assert.equal(pendingWhatsNew(fresh), undefined);
  assert.equal(
    JSON.parse(readFileSync(join(fresh, 'whats-new.json'), 'utf8')).seen,
    VERSION,
  );
  assert.equal(pendingWhatsNew(fresh), undefined);

  const home = scratch(t);
  writeFileSync(join(home, 'credentials.json'), '{}\n');
  const notice = pendingWhatsNew(home, VERSION, '');
  assert.equal(notice?.version, VERSION);
  assert.match(notice!.title.en, new RegExp(VERSION));
  assert.match(notice!.title['zh-CN'], new RegExp(VERSION));
  assert.equal(hadCircleServer(home), false);
  assert.equal(
    notice!.items.some((item) => /circle-server/.test(item.en)),
    false,
  );
  const rows = stripAnsi(whatsNewRows(notice!, 'zh-CN', 72).join('\n'));
  assert.match(rows, /alt\+L/);
  assert.match(rows, /完整的发布说明/);
  assert.match(rows, /releases\/tag\/v/);
  assert.match(rows, /esc/);
  assert.equal(rows.includes('\x1b'), false);
  dismissWhatsNew(home);
  assert.equal(pendingWhatsNew(home), undefined);
});

test('empty session rows are not history and circle update does not print the notice', (t) => {
  const home = scratch(t);
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  store.create(home, 'model');
  store.close();
  assert.equal(circleHasHistory(home), false);

  const update = readFileSync(
    new URL('../src/update.ts', import.meta.url),
    'utf8',
  );
  assert.equal(update.includes('whats_new'), false);
  assert.equal(update.includes('whats-new'), false);
});

test('a stale session lock is swept and a live one is kept', (t) => {
  const home = scratch(t);
  const locks = join(home, 'session-locks');
  const stale = join(locks, 'stale.lock');
  mkdirSync(locks, { recursive: true });
  mkdirSync(stale);
  const old = new Date(Date.now() - 120_000);
  utimesSync(stale, old, old);
  const held = acquireSessionLease(home, 'circle-live');
  cleanup(t, () => held.release());
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  assert.equal(existsSync(stale), false);
  assert.ok(readdirSync(locks).some((name) => name.endsWith('.lock')));
});

test('only a noted unanswered prompt is marked interrupted', (t) => {
  const home = scratch(t);
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const shell = store.create(home, 'model');
  store.append(shell.id, [
    {
      id: 's',
      role: 'user',
      content: 'I ran this command myself',
      shell: { command: 'ls', output: 'ok', exit_code: 0 },
    },
  ]);
  store.noteTurn(shell.id);
  store.repairInterrupted(shell.id);
  assert.equal(
    store
      .messages(shell.id)
      .some((message) => message.internal === 'interrupted'),
    false,
  );

  const answered = store.create(home, 'model');
  store.append(answered.id, [{ id: 'u', role: 'user', content: 'hi' }]);
  store.noteTurn(answered.id);
  store.append(answered.id, [{ id: 'a', role: 'assistant', content: 'hello' }]);
  const updated = store.get(answered.id)!.updated;
  store.repairInterrupted(answered.id);
  assert.equal(
    store
      .messages(answered.id)
      .some((message) => message.internal === 'interrupted'),
    false,
  );
  assert.equal(store.get(answered.id)!.updated, updated);
});

test('the terminal shows the notice under the welcome and esc dismisses it', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const store = new CheckpointStore(home);
  const session = store.create(workspace, 'model', 'kept');
  store.append(session.id, [
    { id: 'u', role: 'user', content: 'hello' },
    { id: 'a', role: 'assistant', content: 'there' },
  ]);
  store.close();
  const { saveSettings, defaultSettings } = await import('../src/settings.js');
  saveSettings(
    {
      ...defaultSettings(),
      extensions: { 'circle-server': { enabled: true } },
    },
    home,
  );
  const { SessionApp } = await import('../src/tui/session_app.js');
  const { ScriptedModel } = await import('../src/testing.js');
  const app = new SessionApp(workspace, home, defaultSettings());
  const ui = app as unknown as {
    screen: { render: () => void };
    off?: () => void;
    offSignals?: () => void;
    input: { close: () => void };
    views: Map<unknown, { interactions: { close: () => void } }>;
    sessions?: { close: () => Promise<void> };
    browsers: Map<unknown, { close: () => Promise<void> }>;
    handle: (event: { type: string; key: string; char: string }) => void;
    repaint: () => void;
    frameRows: string[];
  };
  ui.screen.render = () => {};
  await app.attach({
    workspace,
    home,
    settings: defaultSettings(),
    model: new ScriptedModel([]),
    headless: true,
  });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    ui.input.close();
    for (const view of ui.views.values()) view.interactions.close();
    await (ui.sessions?.close() ?? app.runtime?.close());
    await Promise.all(
      [...ui.browsers.values()].map((browser) => browser.close()),
    );
  });
  ui.repaint();
  const welcome = stripAnsi(app.state.welcome.join('\n'));
  const visible = stripAnsi(ui.frameRows.join('\n'));
  assert.match(welcome, /what's new in/);
  assert.match(welcome, /circle-server/);
  assert.match(welcome, /full release notes/);
  assert.match(welcome, /releases\/tag\/v/);
  assert.equal(welcome.includes('blob/main'), false);
  assert.match(visible, /circle-server/);
  assert.match(visible, /esc · dismiss/);
  const savedLocale = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LANGUAGE: process.env.LANGUAGE,
  };
  delete process.env.LC_ALL;
  delete process.env.LANGUAGE;
  process.env.LANG = 'zh_CN.UTF-8';
  try {
    ui.repaint();
    const chinese = stripAnsi(app.state.welcome.join('\n'));
    assert.match(chinese, /的变化/);
    assert.match(chinese, /原先的 circle-server/);
  } finally {
    for (const [name, value] of Object.entries(savedLocale)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  ui.handle({ type: 'key', key: 'escape', char: '' });
  assert.equal(
    JSON.parse(readFileSync(join(home, 'whats-new.json'), 'utf8')).seen,
    VERSION,
  );
  ui.repaint();
  assert.equal(
    stripAnsi(app.state.welcome.join('\n')).includes('circle-server'),
    false,
  );
  assert.equal(
    stripAnsi(ui.frameRows.join('\n')).includes('circle-server'),
    false,
  );
});

test('starting a session marks the notice seen, and /new does not', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const store = new CheckpointStore(home);
  const session = store.create(workspace, 'model', 'kept');
  store.append(session.id, [
    { id: 'u', role: 'user', content: 'hello' },
    { id: 'a', role: 'assistant', content: 'there' },
  ]);
  store.close();
  const { defaultSettings } = await import('../src/settings.js');
  const { SessionApp } = await import('../src/tui/session_app.js');
  const { ScriptedModel } = await import('../src/testing.js');
  const app = new SessionApp(workspace, home, defaultSettings());
  const ui = app as unknown as {
    screen: { render: () => void };
    off?: () => void;
    offSignals?: () => void;
    input: { close: () => void };
    views: Map<unknown, { interactions: { close: () => void } }>;
    sessions?: { close: () => Promise<void> };
    browsers: Map<unknown, { close: () => Promise<void> }>;
    repaint: () => void;
  };
  ui.screen.render = () => {};
  await app.attach({
    workspace,
    home,
    settings: defaultSettings(),
    model: new ScriptedModel([
      {
        message: { id: 'a1', role: 'assistant', content: 'ok' },
      },
    ]),
    headless: true,
  });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    ui.input.close();
    for (const view of ui.views.values()) view.interactions.close();
    await (ui.sessions?.close() ?? app.runtime?.close());
    await Promise.all(
      [...ui.browsers.values()].map((browser) => browser.close()),
    );
  });
  ui.repaint();
  assert.match(stripAnsi(app.state.welcome.join('\n')), /what's new in/);
  assert.equal(existsSync(join(home, 'whats-new.json')), false);
  await app.submit('/new');
  ui.repaint();
  assert.match(stripAnsi(app.state.welcome.join('\n')), /what's new in/);
  assert.equal(existsSync(join(home, 'whats-new.json')), false);
  await app.submit('continue from here');
  assert.equal(
    JSON.parse(readFileSync(join(home, 'whats-new.json'), 'utf8')).seen,
    VERSION,
  );
  await app.submit('/new');
  ui.repaint();
  assert.equal(
    stripAnsi(app.state.welcome.join('\n')).includes("what's new in"),
    false,
  );
});
