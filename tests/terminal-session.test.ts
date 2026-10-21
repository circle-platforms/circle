import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScreenRenderer } from '../src/ink/screen.js';
import { AgentRuntime } from '../src/runtime.js';
import { SessionOccupiedError } from '../src/session_lock.js';
import {
  isFolderTrusted,
  loadSettings,
  defaultSettings,
} from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { SessionApp } from '../src/tui/session_app.js';
import { cleanup, scratch } from './helpers.js';

test('circle -c on a session open elsewhere watches it, and print mode still exits', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = defaultSettings();
  const owner = new AgentRuntime({
    workspace,
    home,
    settings,
    model: new ScriptedModel([
      { message: { id: 'stored', role: 'assistant', content: 'stored reply' } },
    ]),
    headless: true,
  });
  cleanup(t, () => owner.close());
  await owner.harness.run('hello from the owner');
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen = new ScreenRenderer(() => {});
  await app.attach({
    workspace,
    home,
    settings,
    model: new ScriptedModel(),
    continue: true,
  });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    await (ui.sessions?.close() ?? app.runtime?.close());
  });
  assert.equal(app.runtime!.viewOnly, true);
  assert.equal(app.runtime!.session.id, owner.session.id);
  assert.ok(
    app.state.notices.some(
      (note) => note.includes('view only') && note.includes('circle --fork'),
    ),
  );
  owner.yieldLease();
  ui.watchLease();
  assert.equal(app.runtime!.viewOnly, false);
  assert.ok(app.state.notices.includes('this session is writable again'));

  assert.throws(
    () =>
      new AgentRuntime({
        workspace,
        home,
        session: owner.session.id,
        settings,
        model: new ScriptedModel(),
        headless: true,
      }),
    SessionOccupiedError,
  );
  // A runtime with a screen of its own (the desktop) is told it is taken too:
  // only the terminal's `circle -c` asks to watch.
  assert.throws(
    () =>
      new AgentRuntime({
        workspace,
        home,
        session: owner.session.id,
        settings,
        model: new ScriptedModel(),
      }),
    SessionOccupiedError,
  );
  owner.yieldLease();
  const again = new AgentRuntime({
    workspace,
    home,
    settings,
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => again.close());
  // A Chinese system leaves the terminal's words English
  const saved = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LANGUAGE: process.env.LANGUAGE,
  };
  process.env.LANG = 'zh_CN.UTF-8';
  process.env.LC_ALL = 'zh_CN.UTF-8';
  delete process.env.LANGUAGE;
  try {
    assert.throws(
      () =>
        new AgentRuntime({
          workspace,
          home,
          session: again.session.id,
          settings,
          model: new ScriptedModel(),
          headless: true,
        }),
      (error: Error) => {
        assert.match(error.message, /open in another terminal/);
        assert.match(
          error.message,
          new RegExp(`circle --fork ${again.session.id}`),
        );
        return true;
      },
    );
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test('/hooks lists what is configured and what a skill has not loaded', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  mkdirSync(join(home, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(workspace, '.circle'), { recursive: true });
  writeFileSync(
    join(home, 'hooks.json'),
    JSON.stringify({
      version: 1,
      hooks: {
        session_start: [{ name: 'hello', command: 'true' }],
      },
    }),
  );
  writeFileSync(
    join(workspace, '.circle', 'hooks.json'),
    JSON.stringify({
      version: 1,
      hooks: { before_tool: [{ name: 'proj', command: 'npm test' }] },
    }),
  );
  writeFileSync(
    join(home, 'skills', 'demo', 'SKILL.md'),
    '# Demo\n\nA skill.\n',
  );
  writeFileSync(
    join(home, 'skills', 'demo', 'hooks.json'),
    JSON.stringify({
      version: 1,
      hooks: { after_tool: [{ name: 'later', command: 'echo hi' }] },
    }),
  );
  const settings = defaultSettings();
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen = new ScreenRenderer(() => {});
  await app.attach({
    workspace,
    home,
    settings,
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    ui.input.close();
    await (ui.sessions?.close() ?? app.runtime?.close());
  });
  await app.submit('/hooks');
  const text = app.state.notices.at(-1) ?? '';
  assert.match(text, /Hooks:/);
  assert.match(text, /hello · user · session_start · true · trusted/);
  assert.match(text, /Skill hooks waiting for load:/);
  assert.match(
    text,
    /later · skill:demo · after_tool · echo hi · waiting for \/skill demo/,
  );
  assert.match(text, /project hooks need trust/);
  await app.submit('/help');
  assert.match(app.state.notices.at(-1)!, /\/hooks\s+List hooks/);
});

test('enter while view-only keeps the draft and sends it only on the next enter', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = defaultSettings();
  const owner = new AgentRuntime({
    workspace,
    home,
    settings,
    model: new ScriptedModel([
      { message: { id: 'stored', role: 'assistant', content: 'stored reply' } },
    ]),
    headless: true,
  });
  cleanup(t, () => owner.close());
  await owner.harness.run('hello from the owner');
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen = new ScreenRenderer(() => {});
  await app.attach({
    workspace,
    home,
    settings,
    model: new ScriptedModel([
      { message: { id: 'later', role: 'assistant', content: 'sent' } },
    ]),
    continue: true,
  });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    await (ui.sessions?.close() ?? app.runtime?.close());
  });
  const users = (): string[] =>
    app
      .runtime!.harness.messages.filter(
        (message) => message.role === 'user' && !message.internal,
      )
      .map((message) => message.content);
  await app.submit('later please', 'later please');
  assert.equal(app.runtime!.viewOnly, true);
  assert.deepEqual(users(), ['hello from the owner']);
  assert.equal(app.state.draft, 'later please');
  assert.ok(app.state.notices.includes('view only, the draft stays'));
  owner.yieldLease();
  await app.submit('later please', 'later please');
  assert.equal(app.runtime!.viewOnly, false);
  assert.deepEqual(users(), ['hello from the owner']);
  assert.equal(app.state.draft, 'later please');
  await app.submit('later please', 'later please');
  assert.ok(users().includes('later please'));
});

test('a card takes its letter at once, and the rest of that burst is not typed into the box', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const app = new SessionApp(workspace, home, defaultSettings());
  const ui = app as unknown as {
    screen: ScreenRenderer;
    askChoice: (
      title: string,
      body: string,
      options: string[],
    ) => Promise<string>;
    dataListener: (data: string) => void;
    input: { close: () => void };
    theme: { close: () => void };
  };
  ui.screen = new ScreenRenderer(() => {});
  cleanup(t, () => {
    ui.theme.close();
    ui.input.close();
  });
  // The trust card at startup answers y as soon as it is shown.
  const trust = ui.askChoice('trust', 'folder', ['trust this folder', 'quit']);
  ui.dataListener('y');
  assert.equal(await trust, 'trust this folder');
  // Keys that arrived with the answer were typed at the card: they are dropped.
  const later = ui.askChoice('q', 'body', ['yes', 'no']);
  ui.dataListener('ys');
  assert.equal(await later, 'yes');
  assert.equal(app.state.draft, '');
  ui.dataListener('s');
  assert.equal(app.state.draft, 's');
});

test('--trust remembers the folder without a card', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.model = 'm';
  settings.auth.base_url = 'http://127.0.0.1:9/v1';
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen = new ScreenRenderer(() => {});
  cleanup(t, () => {
    ui.theme.close();
    ui.input.close();
  });
  assert.equal(await app.initialize(false, true), true);
  assert.equal(isFolderTrusted(loadSettings(home), workspace), true);
});
