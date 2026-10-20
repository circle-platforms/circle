import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { cardRows } from '../src/ink/components/dialog_card.js';
import { stripAnsi } from '../src/ink/string_width.js';
import { ScreenRenderer } from '../src/ink/screen.js';
import {
  TUI_ZH,
  interfaceLocale,
  t,
  uiAge,
  uiFolderCount,
  uiText,
} from '../src/locale.js';
import { AgentRuntime } from '../src/runtime.js';
import { SessionOccupiedError } from '../src/session_lock.js';
import {
  isFolderTrusted,
  loadSettings,
  defaultSettings,
} from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { SessionApp } from '../src/tui/session_app.js';
import {
  helpText,
  hotkeysText,
  HOTKEY_LINES,
  BUILTIN_SLASH,
  variableCopy,
} from '../src/tui/slash_commands.js';
import { BUSY_VERBS, busyLabel } from '../src/tui/status_rows.js';
import { cleanup, scratch } from './helpers.js';

const root = join(import.meta.dirname, '../src');
function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}
const literal = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
const CALL = new RegExp(String.raw`\b(?:t|uiText)\(\s*(?:${literal})`, 'g');
const unescape = (value: string): string =>
  value.replace(/\\(.)/g, (_, char: string) =>
    char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char,
  );
const han = (text: string): boolean => /\p{Script=Han}/u.test(text);
const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

test('every terminal interface sentence has Simplified Chinese', () => {
  const missing = new Set<string>();
  for (const file of sources(root)) {
    if (file.endsWith(`${join('src', 'tui_zh.ts')}`)) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(CALL)) {
      const key = unescape(match[1] ?? match[2] ?? '');
      if (!Object.hasOwn(TUI_ZH, key)) missing.add(`${key} (${file})`);
    }
  }
  for (const command of BUILTIN_SLASH)
    if (!Object.hasOwn(TUI_ZH, command.description))
      missing.add(command.description);
  for (const platform of ['linux', 'win32']) {
    const copy = variableCopy(platform);
    for (const key of [copy.variables, copy.secrets])
      if (!Object.hasOwn(TUI_ZH, key)) missing.add(key);
  }
  for (const line of HOTKEY_LINES)
    if (!Object.hasOwn(TUI_ZH, line)) missing.add(line);
  for (const verb of BUSY_VERBS)
    if (!Object.hasOwn(TUI_ZH, verb)) missing.add(verb);
  assert.deepEqual([...missing].sort(), []);
  for (const [english, chinese] of Object.entries(TUI_ZH)) {
    assert.deepEqual(placeholders(chinese), placeholders(english), english);
    if (english !== chinese) assert.equal(han(chinese), true, english);
  }
});

test('the phrases on the screen change under zh-CN and keep commands and ids', () => {
  const zh = (text: string): string => uiText(text, 'zh-CN');
  assert.equal(zh('Bash needs your permission'), 'Bash 需要你的批准');
  assert.equal(zh('runs a shell command'), '运行 shell 命令');
  assert.equal(zh('Allow once'), '允许本次');
  assert.equal(
    zh('Allow this exact command for this session'),
    '本会话内允许这条确切的命令',
  );
  assert.equal(zh('Edit needs your permission'), 'Edit 需要你的批准');
  assert.equal(zh('changes files in the workspace'), '修改工作区内的文件');
  assert.equal(
    zh('Allow file changes inside the workspace for this session'),
    '本会话内允许工作区内的文件改动',
  );
  assert.equal(zh('Reject and explain'), '拒绝并说明');
  assert.equal(zh('Considering'), '思考');
  assert.equal(zh('Brewing'), '思考');
  assert.equal(zh('∴ Thought 0.1s'), '∴ 思考了 0.1s');
  assert.equal(zh('Read 1 line · ctrl+o'), '读取了 1 行 · ctrl+o');
  assert.equal(zh('Edited src/app.ts'), '已编辑 src/app.ts');
  assert.equal(zh('waiting for you'), '等待你处理');
  assert.equal(zh('accept edits'), '自动接受编辑');
  assert.equal(zh('read-only'), '只读');
  assert.equal(zh('auto'), '自动');
  assert.equal(zh('? for shortcuts'), '? 查看快捷键');
  assert.equal(zh('recent'), '最近');
  assert.equal(uiAge('now', 'zh-CN'), '刚刚');
  assert.equal(uiAge('3m', 'zh-CN'), '3 分钟前');
  assert.equal(
    uiFolderCount('2 in .circle/skills', 'zh-CN'),
    '2 个在 .circle/skills',
  );
  assert.equal(zh('New session circle-1'), '新会话 circle-1');
  assert.match(zh('hooks active · 1 · lint (before_tool, project)'), /项目/);
  assert.equal(
    zh('Unknown command /modles · did you mean /models?'),
    '未知命令 /modles · 你是说 /models？',
  );
  assert.equal(t('missing API key', {}, 'zh-CN'), '缺少 API 密钥');
  assert.equal(busyLabel('Brewing', 1, 0), 'Brewing… · 1s · ↓ 0');
  const saved = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LANGUAGE: process.env.LANGUAGE,
  };
  process.env.LANG = 'zh_CN.UTF-8';
  process.env.LC_ALL = 'zh_CN.UTF-8';
  delete process.env.LANGUAGE;
  try {
    assert.equal(interfaceLocale(), 'zh-CN');
    assert.equal(busyLabel('Considering', 2, 10), '思考… · 2s · ↓ 10');
    const card = cardRows(
      {
        title: 'Bash needs your permission',
        body: 'runs a shell command',
        options: [
          'Allow once',
          'Allow this exact command for this session',
          'Reject and explain',
        ],
        focus: 0,
      },
      80,
    )
      .map(stripAnsi)
      .join('\n');
    assert.match(card, /Bash 需要你的批准/);
    assert.match(card, /运行 shell 命令/);
    assert.match(card, /允许本次/);
    assert.match(card, /本会话内允许这条确切的命令/);
    assert.match(card, /拒绝并说明/);
    const help = helpText();
    const keys = hotkeysText();
    for (const line of [...help.split('\n'), ...keys.split('\n')])
      if (line.trim()) assert.equal(han(line), true, line);
    assert.match(help, /\/hooks/);
    assert.match(help, /列出钩子/);
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

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
  owner.yieldLease();
  const again = new AgentRuntime({
    workspace,
    home,
    settings,
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => again.close());
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
        assert.match(error.message, /另一终端/);
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
