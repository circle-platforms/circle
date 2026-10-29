import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  hangingWrap,
  noticeColumns,
  stringWidth,
  stripAnsi,
} from '../src/ink/string_width.js';
import type { Picker } from '../src/ink/components/picker.js';
import { SessionApp } from '../src/tui/session_app.js';
import { renderScreen, transcriptRows } from '../src/tui/render.js';
import {
  parseSlash,
  closeMatch,
  variableCopy,
} from '../src/tui/slash_commands.js';
import { ScriptedModel } from '../src/testing.js';
import { parseFrontmatter } from '../src/skills.js';
import {
  defaultSettings,
  loadCredentials,
  loadSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
  type CircleSettings,
} from '../src/settings.js';
import { emptyUsage, type Message, type ModelResponse } from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';

const answer = (content: string): { message: Message } => ({
  message: { id: crypto.randomUUID(), role: 'assistant', content },
});
// A full-screen session without a terminal: the real runtime, store and event handling, with
// ScriptedModel in place of the endpoint and a clipboard of its own.
async function session(
  t: Parameters<typeof scratch>[0],
  replies: ConstructorParameters<typeof ScriptedModel>[0] = [],
  options: {
    settings?: CircleSettings;
    home?: string;
    workspace?: string;
    /** In place of the machine's home, for its user skill folders. */
    userHome?: string;
    headless?: boolean;
    modelOverride?: string;
    integrations?: boolean;
    /** In place of the extensions that ship with Circle. */
    bundledExtensions?: string;
  } = {},
) {
  const home = options.home ?? scratch(t);
  const workspace = options.workspace ?? scratch(t);
  const settings = options.settings ?? defaultSettings();
  const model = new ScriptedModel(replies);
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  const copied: string[] = [];
  app.clipboard.copyNative = async (text: string) => {
    copied.push(text);
    return true;
  };
  await app.attach({
    workspace,
    home,
    userHome: options.userHome,
    settings,
    model,
    headless: options.headless ?? true,
    modelOverride: options.modelOverride,
    integrations: options.integrations,
    bundledExtensions: options.bundledExtensions,
  });
  const runtime = app.runtime!;
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    for (const view of ui.views.values()) view.interactions.close();
    await (ui.sessions?.close() ?? runtime.close());
    await Promise.all(
      [...ui.browsers.values()].map((browser: any) => browser.close()),
    );
  });
  const key = async (name: string, char = ''): Promise<void> => {
    ui.handle({ type: 'key', key: name, char });
    await delay(20);
  };
  const screen = (): string => {
    ui.repaint();
    return JSON.stringify(app.state.messages) + app.state.notices.join('\n');
  };
  return { app, ui, runtime, model, home, workspace, copied, key, screen };
}
test('TUI resume and continue preserve a waiting approval on its source session (#57)', async (t) => {
  const { app, runtime, model, workspace, key } = await session(t, [
    answer('original conversation'),
    {
      message: {
        id: 'write-request',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'approval-write',
            name: 'write_file',
            args: { file_path: 'approved.txt', content: 'approved TUI bytes' },
          },
        ],
      },
    },
    answer('approval completed'),
  ]);
  await app.submit('save the original conversation');
  const previous = runtime.session.id;
  await app.submit('/new');
  const waitingRuntime = app.runtime!;
  const current = waitingRuntime.session.id;
  const running = app.submit('write after permission');
  await until(() => Boolean(app.state.dialog));
  const approval = app.state.dialog;
  assert(approval);
  await app.submit(`/resume ${previous}`);
  assert.equal(app.runtime, runtime);
  assert.equal(app.state.dialog, undefined);
  assert(waitingRuntime.busy);
  await app.submit('/continue');
  assert.equal(app.runtime!.session.id, current);
  assert.equal(app.state.dialog, approval);
  assert.equal(existsSync(join(workspace, 'approved.txt')), false);
  await key('enter');
  await running;
  assert.equal(
    readFileSync(join(workspace, 'approved.txt'), 'utf8'),
    'approved TUI bytes',
  );
  assert.equal(
    model.requests
      .at(-1)!
      .messages.find((message) => message.tool_call_id === 'approval-write')
      ?.status,
    'success',
  );
  await app.submit(`/resume ${previous}`);
  assert.equal(app.runtime!.session.id, previous);
  assert(
    runtime.harness.messages.some(
      (message) => message.content === 'original conversation',
    ),
  );
});

const said = (request: { messages: Message[] }): string[] =>
  request.messages
    .filter((message) => !message.internal)
    .map((message) => message.content);

test('/undo and /redo put the screen back; the model keeps every turn', async (t) => {
  const { app, runtime, model, screen } = await session(t, [
    answer('answer one'),
    answer('answer two'),
    answer('answer three'),
  ]);
  await app.submit('first question');
  await app.submit('second question');
  await app.submit('/undo');
  assert.ok(!screen().includes('second question'));
  assert.ok(!screen().includes('answer two'));
  assert.ok(screen().includes('answer one'));
  assert.ok(app.state.notices.includes('Undid the last turn'));
  await app.submit('/undo');
  assert.ok(!screen().includes('first question'));
  await app.submit('/undo');
  assert.equal(app.state.flash, 'Nothing to undo');
  await app.submit('/redo');
  assert.ok(screen().includes('answer one'));
  assert.ok(!screen().includes('answer two'));
  assert.ok(app.state.notices.includes('Redid the turn'));
  // A new turn after /undo: the undone turn stays off the screen but goes to the model.
  await app.submit('third question');
  assert.deepEqual(said(model.requests[2]!), [
    'first question',
    'answer one',
    'second question',
    'answer two',
    'third question',
  ]);
  assert.ok(screen().includes('answer three'));
  assert.ok(!screen().includes('second question'));
  assert.equal(
    runtime.store
      .messages(runtime.session.id)
      .filter((message) => message.role === 'user').length,
    3,
  );
  await app.submit('/redo');
  assert.equal(app.state.flash, 'Nothing to redo');
  // Undo belongs to its session; a new conversation cannot hide another one's turn.
  const first = runtime.session.id;
  await app.submit('/new');
  assert.notEqual(app.runtime!.session.id, first);
  await app.submit('/undo');
  assert.equal(app.state.flash, 'Nothing to undo');
  assert.notEqual(app.runtime!.session.id, first);
  await app.submit('/continue');
  await app.submit('/undo');
  assert.equal(app.runtime!.session.id, first);
  assert.ok(!screen().includes('third question'));
  assert.ok(screen().includes('answer one'));
});

test('a command of a shipped extension that is still off names the switch and clears the box', async (t) => {
  // Shipped extensions are off until enabled; extension.json names the command.
  const bundled = scratch(t);
  mkdirSync(join(bundled, 'connector'));
  writeFileSync(
    join(bundled, 'connector', 'extension.json'),
    JSON.stringify({ version: '0.1.0', commands: ['connector'] }),
  );
  writeFileSync(
    join(bundled, 'connector', 'extension.mjs'),
    "export function register(api){api.registerCommand('connector','Connect',()=>{})}",
  );
  const { app, ui, key } = await session(t, [], {
    integrations: true,
    bundledExtensions: bundled,
  });
  ui.setDraft('/connector status');
  await key('enter');
  assert.equal(app.state.draft, '');
  assert.equal(
    app.state.flash,
    'Unknown command /connector · turn it on with /extensions enable connector',
  );
});

test('a mistyped command is cleared with a suggestion; a space, a sentence or a path goes to the model as text', async (t) => {
  const { app, ui, model, key } = await session(t, [
    answer('one'),
    answer('two'),
    answer('three'),
    answer('four'),
  ]);
  ui.setDraft('/modles');
  await key('enter');
  assert.equal(app.state.draft, '');
  assert.equal(
    app.state.flash,
    'Unknown command /modles · did you mean /models?',
  );
  ui.setDraft('/qqqqqqq');
  await key('enter');
  assert.equal(app.state.flash, 'Unknown command /qqqqqqq · /help lists them');
  assert.equal(app.state.draft, '');
  assert.equal(model.requests.length, 0);
  ui.setDraft('/hooks/hotkeys');
  await key('enter');
  assert.equal(app.state.draft, '');
  assert.equal(model.requests.length, 0);
  assert.match(app.state.flash, /^Unknown command \/hooks\/hotkeys/);
  ui.setDraft(' /modles');
  await key('enter');
  await until(() => model.requests.length === 1);
  assert.equal(model.requests[0]!.messages.at(-1)!.content, '/modles');
  await until(() => !app.runtime!.busy);
  await app.submit('/usr/bin/env is missing');
  assert.equal(
    model.requests[1]!.messages.at(-1)!.content,
    '/usr/bin/env is missing',
  );
  // A path alone is no command either: it goes to the model as it was typed
  await until(() => !app.runtime!.busy);
  await app.submit('/usr/bin');
  await until(() => model.requests.length === 3);
  assert.equal(model.requests[2]!.messages.at(-1)!.content, '/usr/bin');
  await until(() => !app.runtime!.busy);
  await app.submit('/Users/me/a.md');
  await until(() => model.requests.length === 4);
  assert.equal(model.requests[3]!.messages.at(-1)!.content, '/Users/me/a.md');
  assert.equal(closeMatch('hepl', ['help', 'hotkeys']), 'help');
  assert.deepEqual(parseSlash('/tasks'), {
    name: 'jobs',
    rawName: 'tasks',
    args: '',
  });
  assert.deepEqual(parseSlash('/rename my work'), {
    name: 'name',
    rawName: 'rename',
    args: 'my work',
  });
  assert.deepEqual(parseSlash('/skill:review src'), {
    name: 'skill',
    rawName: 'skill:review',
    args: 'review src',
  });
});

test('while a turn runs, commands that change it wait; the listed ones still work', async (t) => {
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const { app, runtime } = await session(t, [
    async (): Promise<ModelResponse> => {
      await held;
      return { ...answer('late'), usage: emptyUsage() };
    },
  ]);
  const turn = app.submit('long question');
  await until(() => runtime.busy);
  const id = runtime.session.id;
  await app.submit('/new');
  assert.notEqual(app.runtime, runtime);
  assert(runtime.busy);
  await app.submit(`/resume ${id}`);
  assert.equal(app.runtime, runtime);
  await app.submit('/models other');
  assert.equal(
    app.state.flash,
    'Busy · switch models when the turn has finished',
  );
  await app.submit('/session');
  assert.match(app.state.notices.at(-1)!, new RegExp(`^session  ${id}`));
  // /mode joins /yolo: the mode may change while the turn runs.
  await app.submit('/mode');
  await until(() => runtime.mode === 'accept-edits');
  await app.submit('/yolo');
  assert.ok(runtime.policy.yoloEnabled(id));
  release();
  await turn;
});

test('/settings changes the marked setting and saves only that key', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const saved = trustFolder(defaultSettings(), workspace);
  saved.initialized = true;
  saved.auth.base_url = 'http://127.0.0.1:9/v1';
  saved.auth.model = 'saved-model';
  saved.theme = 'dark';
  saved.future = 'keep';
  saveSettings(saved, home);
  const file = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  const before = file();
  // What holds for this run only: a project's theme, and --model.
  const settings = structuredClone(saved);
  settings.theme = 'light';
  settings.auth.model = 'flag-model';
  const { app, key } = await session(t, [], { home, workspace, settings });
  await app.submit('/settings');
  const picker = app.state.picker!;
  assert.equal(picker.title, 'Settings');
  assert.deepEqual(
    picker.items.map((item) => [item.label, item.meta]),
    [
      ['theme', 'light'],
      ['show thinking', 'on'],
      ['hook allowed notices', 'off'],
      ['esc esc opens', 'tree'],
      ['model', 'scripted · /models'],
      ['thinking depth', 'default · /effort'],
      ['default mode', 'manual'],
      ['endpoint', 'openai · http://127.0.0.1:9/v1'],
      ['trusted folders', '1'],
      ['mcp servers', '0 · /mcp'],
      [
        'data folder',
        home.startsWith(homedir() + sep)
          ? '~' + home.slice(homedir().length)
          : home,
      ],
    ],
  );
  const choose = async (label: string): Promise<void> => {
    const list = app.state.picker!;
    list.focus = list.items.findIndex((item) => item.label === label);
    await key('enter');
  };
  await choose('show thinking');
  assert.equal(app.state.showThinking, false);
  assert.deepEqual(file(), { ...before, hide_thinking: true });
  // The list stays open on the row, showing the new value.
  assert.equal(app.state.picker!.title, 'Settings');
  assert.equal(app.state.picker!.items[app.state.picker!.focus]!.meta, 'off');
  await choose('hook allowed notices');
  assert.equal(app.state.showHookAllow, true);
  assert.deepEqual(file(), {
    ...before,
    hide_thinking: true,
    show_hook_allow: true,
  });
  assert.equal(app.state.picker!.items[app.state.picker!.focus]!.meta, 'on');
  await choose('esc esc opens');
  assert.deepEqual(file(), {
    ...before,
    hide_thinking: true,
    show_hook_allow: true,
    double_escape: 'fork',
  });
  await choose('theme');
  assert.equal(app.settings.theme, 'auto');
  assert.deepEqual(file(), {
    ...before,
    hide_thinking: true,
    show_hook_allow: true,
    double_escape: 'fork',
    theme: 'auto',
  });
  await choose('hook allowed notices');
  assert.equal(app.state.showHookAllow, false);
  assert.deepEqual(file(), {
    ...before,
    hide_thinking: true,
    show_hook_allow: false,
    double_escape: 'fork',
    theme: 'auto',
  });
  await choose('trusted folders');
  assert.equal(app.state.picker!.title, 'Settings');
  assert.equal(loadSettings(home).auth.model, 'saved-model');
});

test('/help lists custom and extension commands; /hotkeys shows what each key does', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  mkdirSync(join(workspace, '.circle', 'commands'), { recursive: true });
  writeFileSync(
    join(workspace, '.circle', 'commands', 'review.md'),
    '---\ndescription: Review a file\nargument-hint: <path>\n---\nReview $1 carefully.\n',
  );
  mkdirSync(join(home, 'extensions', 'hello'), { recursive: true });
  writeFileSync(
    join(home, 'extensions', 'hello', 'extension.mjs'),
    "export function register(api){api.registerCommand('hello','Say hello',(args,ctx)=>ctx.toast('hello '+args))}",
  );
  const { app } = await session(t, [], {
    home,
    workspace,
    settings: trustFolder(defaultSettings(), workspace),
    headless: false,
  });
  await app.submit('/help');
  const help = app.state.notices.at(-1)!;
  assert.match(help, /^Available commands:/);
  assert.match(
    help,
    /\/jobs {7}Background jobs: open one, or stop it \(\/tasks\)/,
  );
  assert.match(help, /Custom commands:\n {2}\/review <path> Review a file/);
  assert.match(help, /\/hello {6}Say hello/);
  assert.match(help, /Skills also: \/skill:name$/);
  await app.submit('/hello world');
  assert.equal(app.state.notices.at(-1), 'hello world');
  await app.submit('/hotkeys');
  const keys = app.state.notices.at(-1)!;
  assert.match(keys, /^Keyboard shortcuts:/);
  assert.match(keys, /ctrl\+q {10}queue a follow-up: sent when the turn ends/);
  assert.match(keys, /esc esc +clear a draft/);
  assert.match(keys, /session tree \(\/tree\)/);
  assert.match(keys, /ctrl\+l +redraw the screen/);
  assert.match(keys, /alt\+l +choose a model/);
});

test('/init sends the initialize template with the focus; a custom command replaces a built-in one', async (t) => {
  const { app, model, workspace } = await session(t, [
    answer('written'),
    answer('again'),
    answer('custom'),
  ]);
  await app.submit('/init focus on the tests');
  const prompt = model.requests[0]!.messages.at(-1)!.content;
  assert.match(prompt, /^Create or update `AGENTS.md` for this repository\./);
  assert.match(prompt, /honor these\):\nfocus on the tests\n/);
  assert.ok(!prompt.includes('$ARGUMENTS'));
  await app.submit('/init');
  assert.match(
    model.requests[1]!.messages.at(-1)!.content,
    /honor these\):\n\(none\)\n/,
  );
  mkdirSync(join(workspace, '.circle', 'commands'), { recursive: true });
  writeFileSync(
    join(workspace, '.circle', 'commands', 'init.md'),
    '/not a command: $ARGUMENTS',
  );
  await app.submit('/init now');
  // The template is sent as it is, even though it starts with a slash.
  assert.equal(
    model.requests[2]!.messages.at(-1)!.content,
    '/not a command: now',
  );
});

test('/jobs lists running jobs first; ctrl+k stops one after asking in the list or removes one that ended', async (t) => {
  const { app, runtime, key, workspace } = await session(t);
  const script = (name: string, code: string): string => {
    writeFileSync(join(workspace, name), code);
    return `"${process.execPath}" "${join(workspace, name)}"`;
  };
  const ended = await runtime.jobs.startShell(script('quick.cjs', ''), {
    sessionId: runtime.session.id,
  });
  await runtime.jobs.wait([ended.id], 5, new AbortController().signal);
  const running = await runtime.jobs.startShell(
    script('slow.cjs', 'setTimeout(()=>{},30000)'),
    { sessionId: 'another' },
  );
  await app.submit('/tasks');
  const picker = app.state.picker!;
  assert.equal(picker.title, 'Background jobs');
  assert.deepEqual(
    picker.items.map((item) => item.key),
    [running.id, ended.id],
  );
  assert.match(picker.items[0]!.meta!, /^running · \d+s · other session$/);
  assert.match(picker.items[1]!.meta!, /^done · \d+s$/);
  // The question is asked in the list; esc keeps the job running.
  await key('ctrl+k');
  assert.equal(app.state.dialog, undefined);
  assert.equal(app.state.picker, picker);
  assert.ok(picker.asking);
  assert.ok(
    picker
      .rows(400)
      .some((row) =>
        row.includes(
          `Stop ${running.id} ${running.title.slice(0, 40)}?  enter confirms · esc cancels`,
        ),
      ),
  );
  await key('escape');
  assert.ok(!picker.asking);
  assert.equal(runtime.jobs.get(running.id)?.status, 'running');
  await key('ctrl+k');
  await key('enter');
  await until(() => runtime.jobs.get(running.id)?.status === 'stopped');
  assert.equal((app as any).ended, false);
  await until(
    () => app.state.picker?.items[0]?.meta?.startsWith('stopped') === true,
  );
  app.state.picker!.focus = 1;
  await key('ctrl+k');
  assert.equal(runtime.jobs.get(ended.id), undefined);
  assert.deepEqual(
    app.state.picker!.items.map((item) => item.key),
    [running.id],
  );
  await key('enter');
  assert.equal(app.state.jobDetail?.id, running.id);
});

test('/yolo takes off, 0, false and no as off; /plan takes on and off and says when nothing changes', async (t) => {
  const { app, runtime } = await session(t);
  const id = runtime.session.id;
  for (const word of ['off', '0', 'false', 'no', 'OFF']) {
    await app.submit('/yolo');
    assert.ok(runtime.policy.yoloEnabled(id));
    assert.equal(
      app.state.notices.at(-1),
      'Auto on · nothing asks: commands that delete, certificate warnings and uploads go ahead · use it where that is safe',
    );
    await app.submit(`/yolo ${word}`);
    assert.ok(!runtime.policy.yoloEnabled(id), word);
    assert.equal(
      app.state.notices.at(-1),
      'Auto off · asking for each call again',
    );
  }
  await app.submit('/plan on');
  assert.ok(runtime.harness.planMode);
  assert.equal(
    app.state.notices.at(-1),
    'Read-only on · writes and shell are blocked, except the plan',
  );
  await app.submit('/plan on');
  assert.equal(app.state.flash, 'Read-only is already on');
  await app.submit('/plan maybe');
  assert.equal(app.state.flash, 'Usage: /plan [on|off]');
  await app.submit('/plan');
  assert.ok(!runtime.harness.planMode);
  assert.equal(app.state.notices.at(-1), 'Read-only off');
});

test('/mode steps through manual, accept edits, plan and auto, and the frame names the mode', async (t) => {
  const { app, runtime } = await session(t);
  const id = runtime.session.id;
  const word = () =>
    renderScreen(app.state, 80, 24)
      .map(stripAnsi)
      .filter((row) => row.startsWith('╰'))
      .at(-1);
  assert.equal(runtime.mode, 'manual');
  await app.submit('/mode');
  assert.equal(runtime.policy.mode(id), 'accept-edits');
  assert.equal(
    app.state.notices.at(-1),
    'Accept edits · workspace file edits run without asking, commands and deletes still ask',
  );
  assert.match(word()!, /accept edits/);
  await app.submit('/mode');
  assert.ok(runtime.harness.planMode);
  assert.match(word()!, /read-only/);
  await app.submit('/mode');
  assert.ok(!runtime.harness.planMode);
  assert.ok(runtime.policy.yoloEnabled(id));
  assert.match(word()!, /auto/);
  await app.submit('/mode');
  assert.equal(runtime.mode, 'manual');
  assert.equal(
    app.state.notices.at(-1),
    'Manual · asking before each change and command',
  );
  assert.doesNotMatch(word()!, /auto|accept|read-only/);
  await app.submit('/mode accept edits');
  assert.equal(runtime.mode, 'accept-edits');
  await app.submit('/mode accept-edits');
  assert.equal(app.state.flash, 'Mode is already accept edits');
  await app.submit('/mode sometimes');
  assert.equal(app.state.flash, 'Usage: /mode [manual|accept-edits|plan|auto]');
});

test('/export, /share and /unshare write the screen as Markdown under names with the time', async (t) => {
  const { app, runtime, home, workspace, copied } = await session(t, [
    answer('the answer'),
  ]);
  await app.submit('the question');
  await app.submit('/export');
  const exports = readdirSync(join(home, 'exports'));
  assert.equal(exports.length, 1);
  assert.match(
    exports[0]!,
    new RegExp(`^circle-${runtime.session.id}-\\d{8}-\\d{6}\\.md$`),
  );
  const markdown = readFileSync(join(home, 'exports', exports[0]!), 'utf8');
  assert.match(
    markdown,
    new RegExp(`^# Circle session \`${runtime.session.id}\``),
  );
  assert.match(markdown, /- title: `the question`/);
  assert.match(markdown, /› the question/);
  assert.match(markdown, /the answer/);
  assert.equal(
    app.state.notices.at(-1),
    `Exported ${join(home, 'exports', exports[0]!)}`,
  );
  await app.submit('/export HTML');
  assert.ok(!existsSync(join(workspace, 'HTML')));
  assert.ok(
    readdirSync(join(home, 'exports')).some((name) => name.endsWith('.html')),
  );
  await app.submit('/export notes/session.jsonl');
  assert.match(
    readFileSync(join(workspace, 'notes', 'session.jsonl'), 'utf8'),
    /"circle-session"/,
  );
  await app.submit('/share');
  const shared = join(home, 'shares', `${runtime.session.id}.md`);
  assert.match(readFileSync(shared, 'utf8'), /the answer/);
  assert.deepEqual(copied, [shared]);
  assert.equal(
    app.state.notices.at(-1),
    `Local share copy: ${shared} · path copied`,
  );
  await app.submit('/unshare');
  assert.ok(!existsSync(shared));
  assert.equal(app.state.notices.at(-1), `Unshared ${shared}`);
  await app.submit('/unshare');
  assert.equal(app.state.flash, 'No active share file');
});

test('/copy copies the last answer, or writes it to a file when there is no clipboard', async (t) => {
  const { app, home, copied } = await session(t, [answer('copy me')]);
  await app.submit('/copy');
  assert.equal(app.state.flash, 'No assistant message to copy');
  await app.submit('question');
  await app.submit('/copy');
  assert.deepEqual(copied, ['copy me']);
  assert.equal(app.state.flash, 'Copied 7 chars');
  app.clipboard.copyNative = async () => false;
  await app.submit('/copy');
  assert.equal(app.state.flash, 'Copied 7 chars');
  assert.equal(existsSync(join(home, 'exports', 'last-copy.txt')), false);
  assert.equal(
    app.state.notices.some((note) => note.includes('Saved to file')),
    false,
  );
});

test('/import of a text file starts a session that gives the model its start', async (t) => {
  const { app, runtime, model, workspace } = await session(t, [
    answer('continued'),
  ]);
  const previous = runtime.session.id;
  writeFileSync(join(workspace, 'notes.md'), '# earlier chat\nwe chose B\n');
  await app.submit('/import');
  assert.equal(app.state.flash, 'Usage: /import <file.jsonl or file.md>');
  await app.submit('/import missing.md');
  assert.equal(app.state.notices.at(-1), '✖ No such file: missing.md');
  await app.submit('/import notes.md');
  assert.notEqual(app.runtime!.session.id, previous);
  assert.equal(app.runtime!.store.get(app.runtime!.session.id)!.title, 'notes');
  assert.equal(
    app.state.notices.at(-1),
    `Imported ${join(workspace, 'notes.md')}`,
  );
  await app.submit('go on');
  assert.equal(
    model.requests[0]!.messages[0]!.content,
    'Imported prior transcript for continuity.\n# earlier chat\nwe chose B\n',
  );
  await app.submit('/continue');
  assert.equal(app.runtime!.session.id, previous);
});

test('/skill loads a skill into the conversation without starting a turn', async (t) => {
  const workspace = scratch(t);
  mkdirSync(join(workspace, '.circle', 'skills', 'demo'), { recursive: true });
  writeFileSync(
    join(workspace, '.circle', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: A demo skill\n---\nAlways answer in haiku.\n',
  );
  const { app, model } = await session(t, [answer('ok')], { workspace });
  await app.submit('/skill');
  const list = app.state.notices.at(-1)!;
  assert.match(list, /^Skills:\n\n/);
  assert.match(list, /\n {2}demo {17}A demo skill \(Project Circle\)\n/);
  assert.match(list, /\n\nLoad with \/skill <name>$/);
  await app.submit('/skill demo short');
  assert.equal(model.requests.length, 0);
  assert.equal(app.state.notices.at(-1), "Loaded skill `demo` args='short'");
  await app.submit('/skill nothing');
  assert.match(
    app.state.notices.at(-1)!,
    /^✖ Error: skill 'nothing' not found/,
  );
  await app.submit('write a poem');
  const loaded = model.requests[0]!.messages.find(
    (message) => message.internal === 'skill',
  )!;
  assert.match(
    loaded.content,
    /^\[Circle system\] Skill `demo` loaded via \/skill\.\nUser arguments: short\n/,
  );
  assert.match(loaded.content, /Always answer in haiku\./);
  assert.equal(model.requests[0]!.messages.at(-1)!.content, 'write a poem');
});

test('/skill lists the skill that ships with Circle as built-in, loads it, and lists a project skill of the same name in its place', async (t) => {
  const workspace = scratch(t);
  const userHome = scratch(t);
  const shipped = parseFrontmatter(
    readFileSync(
      join(process.cwd(), 'src', 'builtin_skills', 'create-pr', 'SKILL.md'),
      'utf8',
    ),
  );
  const { app, model } = await session(t, [answer('ok')], {
    workspace,
    userHome,
  });
  await app.submit('/skill');
  let list = app.state.notices.at(-1)!;
  const rows = list.split('\n');
  assert.deepEqual(rows.slice(0, 2), ['Skills:', '']);
  assert.deepEqual(rows.slice(-2), ['', 'Load with /skill <name>']);
  const prefix = `  ${'create-pr'.padEnd(20)} `;
  const body = `${shipped.meta.description} (Built-in)`;
  const createPr = hangingWrap(prefix, body, noticeColumns());
  assert.ok(list.includes(createPr.join('\n')), list);
  if (stringWidth(prefix + body) > noticeColumns()) {
    assert.ok(createPr.length > 1, createPr.join('\n'));
    assert.ok(
      createPr.slice(1).every((line) => line.startsWith(' '.repeat(23))),
      createPr.join('\n'),
    );
  }
  // No skill folder of this session's has any: each listed skill ships with Circle.
  // A wrapped description continues under the name; the block still ends (Built-in).
  const blocks: string[][] = [];
  for (const row of rows.slice(2, -2)) {
    if (row[2] !== ' ') blocks.push([row]);
    else blocks.at(-1)!.push(row);
  }
  assert.ok(
    blocks.every((block) => block.at(-1)!.endsWith(' (Built-in)')),
    list,
  );
  await app.submit('/skill create-pr');
  assert.equal(app.state.notices.at(-1), 'Loaded skill `create-pr`');
  await app.submit('open a pull request');
  const loaded = model.requests[0]!.messages.find(
    (message) => message.internal === 'skill',
  )!;
  assert.match(
    loaded.content,
    /^\[Circle system\] Skill `create-pr` loaded via \/skill\./,
  );
  assert.ok(loaded.content.includes(shipped.body.trim()));
  mkdirSync(join(workspace, '.circle', 'skills', 'create-pr'), {
    recursive: true,
  });
  writeFileSync(
    join(workspace, '.circle', 'skills', 'create-pr', 'SKILL.md'),
    '---\nname: create-pr\ndescription: Our own pull requests\n---\nUse the release train.\n',
  );
  await app.submit('/skill');
  list = app.state.notices.at(-1)!;
  assert.match(
    list,
    /\n {2}create-pr {12}Our own pull requests \(Project Circle\)\n/,
  );
  assert.equal(list.includes('(Built-in)'), false);
});

test('/name, /session, /approvals, /themes and /effort answer in the transcript', async (t) => {
  const { app, runtime, home, key } = await session(t);
  await app.submit('/name');
  assert.equal(app.state.notices.at(-1), 'Session name: new');
  assert.equal(app.state.flash, '/name <title> renames it');
  await app.submit('/name  my   work ');
  assert.equal(runtime.store.get(runtime.session.id)!.title, 'my work');
  assert.equal(app.state.notices.at(-1), 'Session name → my work');
  await app.submit('/rename  other   name ');
  assert.equal(runtime.store.get(runtime.session.id)!.title, 'other name');
  assert.equal(app.state.notices.at(-1), 'Session name → other name');
  await app.submit('/session');
  const facts = app.state.notices.at(-1)!.split('\n');
  assert.equal(facts[0], `session  ${runtime.session.id} · other name`);
  assert.equal(facts[2], 'model    scripted');
  assert.match(facts[4]!, /^messages 0 · 0 yours · 0 from the model/);
  runtime.policy.store.record(
    runtime.session.id,
    'always',
    'execute',
    'npm *',
    'npm …',
  );
  runtime.policy.store.record(
    runtime.session.id,
    'reject',
    'write_file',
    '',
    '',
  );
  await app.submit('/approvals revoke x');
  assert.equal(app.state.flash, 'Usage: /approvals revoke <number>');
  await app.submit('/approvals revoke 4');
  assert.equal(app.state.flash, 'No rule number 4');
  await app.submit('/approvals');
  assert.equal(app.state.picker!.title, 'Session approvals');
  assert.deepEqual(
    app.state.picker!.items.map((item) => item.label),
    ['1. Revoke: npm …', '2. Close'],
  );
  await key('1');
  assert.deepEqual(runtime.policy.store.rules(runtime.session.id), []);
  assert.match(app.state.notices.at(-1)!, /^Revoked · execute · npm …/);
  await app.submit('/approvals list');
  assert.match(
    app.state.notices.at(-1)!,
    /^No always-allow rules this session\.\nRecent approvals:\n {2}allowed for session · execute\n {2}rejected · write_file\n {2}revoked · execute$/,
  );
  await app.submit('/themes');
  assert.equal(
    app.state.notices.at(-1),
    'Theme: auto · available: auto, dark, light',
  );
  await app.submit('/themes sepia');
  assert.equal(
    app.state.notices.at(-1),
    "✖ Unknown theme 'sepia' · available: auto, dark, light",
  );
  await app.submit('/themes light');
  assert.equal(loadSettings(home).theme, 'light');
  assert.equal(app.state.notices.at(-1), 'Theme → light');
  await app.submit('/effort huge');
  assert.equal(
    app.state.notices.at(-1),
    "✖ Unknown depth 'huge' · choose minimal, low, medium, high, xhigh, max",
  );
  const notes = app.state.notices.length;
  // shift+tab cycles the session mode; the notice lands in the transcript.
  await key('shift+tab');
  await until(() => runtime.mode === 'accept-edits');
  assert.equal(
    app.state.notices.at(-1),
    'Accept edits · workspace file edits run without asking, commands and deletes still ask',
  );
  // alt+t cycles the thinking depth, for this session only.
  await key('alt+t');
  assert.equal(runtime.thinkingLevel, 'minimal');
  assert.equal(app.state.flash, 'Thinking depth → minimal');
  assert.equal(app.state.notices.length, notes + 1);
  await key('shift+tab');
  await until(() => runtime.mode === 'plan');
  await key('shift+tab');
  await until(() => runtime.mode === 'auto');
  await key('shift+tab');
  await until(() => runtime.mode === 'manual');
  await app.submit('/thinking HIGH');
  assert.equal(runtime.thinkingLevel, 'high');
  assert.equal(app.state.notices.at(-1), 'Thinking depth → high');
  await app.submit('/thinking');
  assert.equal(app.state.showThinking, false);
  assert.equal(app.state.flash, 'Thinking hidden');
});

test('/approvals add and remove keep command patterns in the settings and on the policy', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const saved = trustFolder(defaultSettings(), workspace);
  saved.initialized = true;
  saveSettings(saved, home);
  const { app, runtime, key } = await session(t, [], {
    home,
    workspace,
    settings: loadSettings(home),
  });
  await app.submit('/approvals add');
  assert.equal(app.state.flash, 'Usage: /approvals add <pattern>');
  await app.submit('/approvals add npm *');
  assert.deepEqual(loadSettings(home).allowed_commands, ['npm *']);
  assert.deepEqual(runtime.policy.allowedCommands, ['npm *']);
  assert.equal(
    app.state.notices.at(-1),
    'Allowed · commands matching "npm *" run without asking',
  );
  // the pattern answers for matching commands only
  assert.equal(
    runtime.policy.needsApproval(
      'execute',
      { command: 'npm run build' },
      runtime.session.id,
    ),
    false,
  );
  assert.equal(
    runtime.policy.needsApproval(
      'execute',
      { command: 'make build' },
      runtime.session.id,
    ),
    true,
  );
  await app.submit('/approvals add npm *');
  assert.equal(app.state.flash, '"npm *" is already allowed');
  await app.submit('/approvals list');
  assert.equal(
    app.state.notices.at(-1),
    'No always-allow rules this session.\nCommand patterns from settings:\n  1. npm *\nRemove one: /approvals remove <pattern|number>',
  );
  await app.submit('/approvals');
  assert.deepEqual(
    app.state.picker!.items.map((item) => item.label),
    ['1. Allow: npm *', '2. Close'],
  );
  await key('escape');
  await app.submit('/approvals remove 1');
  assert.deepEqual(loadSettings(home).allowed_commands, []);
  assert.deepEqual(runtime.policy.allowedCommands, []);
  assert.equal(
    app.state.notices.at(-1),
    'Removed · commands matching "npm *" ask again',
  );
  await app.submit('/approvals remove npm *');
  assert.equal(app.state.flash, 'No pattern "npm *"');
  await app.submit('/approvals remove 3');
  assert.equal(app.state.flash, 'No pattern number 3');
  await app.submit('/approvals remove');
  assert.equal(app.state.flash, 'Usage: /approvals remove <pattern|number>');
});

test("/approvals remove keeps a trusted project's copy of the same pattern", async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const saved = trustFolder(defaultSettings(), workspace);
  saved.initialized = true;
  saveSettings(saved, home);
  const { app, runtime } = await session(t, [], {
    home,
    workspace,
    settings: loadSettings(home),
  });
  await app.submit('/approvals add npm *');
  mkdirSync(join(workspace, '.circle'), { recursive: true });
  writeFileSync(
    join(workspace, '.circle', 'settings.json'),
    JSON.stringify({ allowed_commands: ['npm *'] }),
  );
  await app.submit('/approvals remove npm *');
  assert.deepEqual(loadSettings(home).allowed_commands, []);
  assert.deepEqual(runtime.policy.allowedCommands, ['npm *']);
  assert.equal(
    app.state.notices.at(-1),
    'Removed from your settings · the project still allows "npm *"',
  );
});

test('/settings picks the mode new sessions start in, and alt+d saves it', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const saved = trustFolder(defaultSettings(), workspace);
  saved.initialized = true;
  saveSettings(saved, home);
  const { app, runtime, key } = await session(t, [], {
    home,
    workspace,
    settings: loadSettings(home),
  });
  const choose = async (label: string): Promise<void> => {
    const list = app.state.picker!;
    list.focus = list.items.findIndex((item) => item.label === label);
    await key('enter');
  };
  await app.submit('/settings');
  await choose('default mode');
  assert.equal(app.state.picker!.title, 'Session mode');
  assert.deepEqual(
    app.state.picker!.items.map((item) => [item.label, item.meta]),
    [
      ['manual', 'asking before each change and command'],
      ['accept edits', 'workspace edits run without asking'],
      ['read-only', 'writes and shell are blocked · except the plan'],
      [
        'auto',
        'nothing asks · deletes, certificate warnings and uploads included',
      ],
    ],
  );
  // enter changes this session only
  await choose('accept edits');
  assert.equal(app.state.picker, undefined);
  assert.equal(runtime.mode, 'accept-edits');
  assert.equal(loadSettings(home).default_mode, '');
  assert.equal(
    app.state.notices.at(-1),
    'Accept edits · workspace file edits run without asking, commands and deletes still ask',
  );
  // alt+d writes default_mode and takes the session with it
  await app.submit('/settings');
  await choose('default mode');
  const list = app.state.picker!;
  list.focus = list.items.findIndex((item) => item.label === 'auto');
  await key('alt+d');
  assert.equal(loadSettings(home).default_mode, 'auto');
  assert.equal(runtime.mode, 'auto');
  assert.equal(
    app.state.notices.at(-1),
    'Auto on · nothing asks: commands that delete, certificate warnings and uploads go ahead · use it where that is safe · saved as the default',
  );
  // /new starts in the saved default, and the list marks it
  await app.submit('/new');
  assert.equal(runtime.mode, 'auto');
  await app.submit('/settings');
  await choose('default mode');
  assert.match(app.state.picker!.items[3]!.meta!, /· default$/);
  await key('escape');
});

test('/logout clears the key and the connection and keeps the session open', async (t) => {
  const home = scratch(t);
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = 'http://127.0.0.1:9/v1';
  settings.auth.model = 'saved-model';
  settings.theme = 'dark';
  saveSettings(settings, home);
  saveCredentials({ api_key: 'secret' }, home);
  const { app, ui, key } = await session(t, [], {
    home,
    settings: structuredClone(settings),
  });
  await app.submit('/logout');
  assert.deepEqual(loadCredentials(home), {});
  const file = loadSettings(home);
  assert.equal(file.initialized, false);
  assert.equal(file.auth.base_url, '');
  assert.equal(file.theme, 'dark');
  assert.equal(ui.ended, false);
  assert.equal(
    app.state.notices.at(-1),
    'Signed out · credentials cleared · /login or `circle --init` before the next turn',
  );
  // /login takes no provider (Circle signs in only with an API URL and key): it asks for
  // the URL, with nothing saved to fill in
  await app.submit('/login openai');
  await key('enter'); // custom endpoint
  const rows = app.state.picker!.rows(120).map((row) => stripAnsi(row).trim());
  assert.deepEqual(rows, [
    'Sign in',
    'base url: ▏  enter continues · esc closes',
    'not signed in',
  ]);
  await key('escape');
  assert.equal(app.state.picker, undefined);
});

test('/resume tells identical titles apart and lines the times up', async (t) => {
  const { app, key } = await session(t, [
    answer('hello there'),
    answer('ready now'),
  ]);
  await app.submit('hi');
  await app.submit('/new');
  await app.submit('hi');
  await app.submit('/resume');
  const picker = app.state.picker!;
  const labels = picker.items.map((item) => item.label).sort();
  assert.deepEqual(labels, ['hi · hello there', 'hi · ready now']);
  picker.query = 'hello';
  assert.deepEqual(
    picker.matches().map((item) => item.label),
    ['hi · hello there'],
  );
  picker.query = '';
  await key('escape');
  await app.submit('/name 尾递归解释');
  await app.submit('/resume');
  const rows = app.state
    .picker!.rows(80)
    .map((row) => stripAnsi(row))
    .filter((row) => row.includes('尾递归解释') || /\bhi\b/.test(row));
  const ages = rows.map((row) =>
    stringWidth(row.slice(0, row.lastIndexOf('now'))),
  );
  assert.equal(ages.length, 2);
  assert.equal(ages[0], ages[1]);
});

test('/continue after a restart opens the latest saved session', async (t) => {
  const { app, runtime } = await session(t, [answer('saved answer')]);
  await app.submit('remember this');
  const saved = runtime.session.id;
  await app.submit('/new');
  assert.notEqual(app.runtime!.session.id, saved);
  (app as unknown as { previousSession: string }).previousSession = '';
  await app.submit('/continue');
  assert.equal(app.runtime!.session.id, saved);
  assert.match(app.state.notices.at(-1) ?? '', new RegExp(`^Resumed ${saved}`));
});

test('/tree, /fork, /clone, /new, /continue and /resume move between branches and sessions', async (t) => {
  const { app, runtime, model, key } = await session(t, [
    answer('answer one'),
    answer('answer two'),
    answer('answer changed'),
  ]);
  await app.submit('/continue');
  assert.equal(app.state.flash, 'No previous session');
  await app.submit('/tree');
  assert.equal(app.state.flash, 'Nothing in this session yet');
  await app.submit('question one');
  await app.submit('question two');
  const pick = async (label: string): Promise<void> => {
    const picker = app.state.picker!;
    picker.focus = picker.matches().findIndex((item) => item.label === label);
    assert.ok(picker.focus >= 0, label);
    await key('enter');
  };
  await app.submit('/tree');
  assert.equal(app.state.picker!.title, 'Session tree');
  await pick('● answer two');
  assert.equal(app.state.flash, 'Already here');
  await app.submit('/tree');
  const picker = app.state.picker!;
  picker.focus = picker
    .matches()
    .findIndex((item) => item.label === '● answer two');
  await key('L');
  assert.equal(app.state.dialog, undefined);
  assert.ok(app.state.picker!.asking);
  for (const char of 'start') await key(char, char);
  await key('enter');
  assert.equal(
    app.state.picker!.items.find((item) => item.label.includes('['))!.label,
    '● [start] answer two',
  );
  assert.deepEqual(
    Object.values(app.runtime!.store.labels(app.runtime!.session.id)),
    ['start'],
  );
  await key('escape');
  await app.submit('/tree two');
  assert.equal(app.state.picker!.query, 'two');
  await pick('› question two');
  assert.equal(app.state.draft, 'question two');
  assert.equal(
    app.state.notices.at(-1),
    'Back before your message · your next message starts a new branch · /tree shows them all',
  );
  await app.submit('question changed');
  assert.deepEqual(said(model.requests[2]!), [
    'question one',
    'answer one',
    'question changed',
  ]);
  const first = app.runtime!.session.id;
  await app.submit('/fork');
  assert.equal(app.state.picker!.title, 'Fork from a message');
  await pick('question one');
  assert.notEqual(app.runtime!.session.id, first);
  assert.equal(app.state.draft, 'question one');
  assert.equal(
    app.state.notices.at(-1),
    `Forked → ${app.runtime!.session.id} · your message is back in the box`,
  );
  assert.deepEqual(app.runtime!.harness.messages, []);
  await app.submit('/continue');
  assert.equal(app.runtime!.session.id, first);
  assert.match(app.state.notices.at(-1)!, new RegExp(`^Continued ${first} · `));
  await app.submit('/clone');
  const cloned = app.runtime!.session.id;
  assert.equal(app.state.notices.at(-1), `Cloned this branch → ${cloned}`);
  assert.deepEqual(said({ messages: app.runtime!.harness.messages }), [
    'question one',
    'answer one',
    'question changed',
    'answer changed',
  ]);
  await app.submit('/new');
  assert.equal(
    app.state.notices.at(-1),
    `New session ${app.runtime!.session.id}`,
  );
  await app.submit(`/resume ${first.slice(-4)}`);
  assert.equal(app.runtime!.session.id, first);
  assert.equal(app.state.notices.at(-1), `Resumed ${first} · question one`);
  await app.submit(`/resume ${first}`);
  assert.equal(app.state.flash, 'Already in that session');
  await app.submit('/resume nothing');
  assert.equal(
    app.state.notices.at(-1),
    "✖ No session 'nothing' in this folder · /resume lists them",
  );
  // The list: ctrl+r renames (the old name is selected) and ctrl+k always asks.
  await app.submit('/resume');
  assert.equal(app.state.picker!.title, 'Sessions · this folder');
  assert.match(
    app.state
      .picker!.rows(160)
      .map((row) => stripAnsi(row))
      .join('\n'),
    /tab every folder/,
  );
  const focus = (id: string): void => {
    const picker = app.state.picker!;
    picker.focus = picker.matches().findIndex((item) => item.key === id);
  };
  focus(first);
  await key('ctrl+k');
  assert.ok(app.state.picker!.asking);
  await key('escape');
  assert.ok(app.runtime!.store.get(first));
  focus(cloned);
  await key('ctrl+r');
  assert.equal(app.state.dialog, undefined);
  assert.ok(app.state.picker!.asking);
  const asked = stripAnsi(app.state.picker!.rows(200).join('\n'));
  assert.match(asked, /Rename:/);
  assert.match(asked, /typing replaces the name/);
  await key('Z', 'Z');
  const replaced = stripAnsi(app.state.picker!.rows(200).join('\n'));
  assert.match(replaced, /Rename: Z/);
  assert.doesNotMatch(replaced, /Rename:.*question/);
  await key('escape');
  focus(cloned);
  await key('ctrl+r');
  await key('ctrl+u');
  for (const char of '  the   clone ') await key(char, char);
  await key('enter');
  assert.equal(app.runtime!.store.get(cloned)!.title, 'the clone');
  assert.equal(
    app.state.picker!.matches()[app.state.picker!.focus]?.key,
    cloned,
  );
  focus(cloned);
  await key('ctrl+k');
  assert.equal(app.state.dialog, undefined);
  assert.ok(app.state.picker!.asking);
  await key('enter');
  assert.equal(app.runtime!.store.get(cloned), undefined);
  assert.ok(app.state.picker!.items.every((item) => item.key !== cloned));
  await key('tab');
  assert.equal(app.state.picker!.title, 'Sessions · every folder');
  assert.match(
    app.state
      .picker!.rows(200)
      .map((row) => stripAnsi(row))
      .join('\n'),
    /tab this folder/,
  );
  const folder = app
    .runtime!.session.workspace.split(/[\\/]/)
    .filter(Boolean)
    .at(-1)!;
  assert.ok(
    app.state.picker!.items.some((item) => (item.meta ?? '').includes(folder)),
  );
  assert.equal(
    app.state.picker!.items.some((item) =>
      (item.meta ?? '').includes(app.runtime!.session.workspace),
    ),
    false,
  );
  app.state.picker!.query = 'answer one';
  assert.ok(app.state.picker!.matches().some((item) => item.key === first));
  app.state.picker!.query = 'no-such-word-zz';
  assert.equal(app.state.picker!.matches().length, 0);
  assert.match(stripAnsi(app.state.picker!.rows(80).join('\n')), /No matches/);
});

test('/compact, /mcp, /extensions, /trust and /reload report what they did', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = 'http://127.0.0.1:9/v1';
  settings.auth.model = 'saved-model';
  saveSettings(settings, home);
  saveCredentials({ api_key: 'test-key' }, home);
  const { app, runtime } = await session(t, [], {
    home,
    workspace,
    settings: structuredClone(settings),
  });
  await app.submit('/compact');
  assert.equal(app.state.flash, 'Nothing to compact yet');
  await app.submit('/mcp');
  assert.equal(
    app.state.notices.at(-1),
    'No MCP servers. Add mcp_servers to settings.json.',
  );
  await app.submit('/mcp reload');
  assert.equal(app.state.notices.at(-1), 'MCP reloaded · 0 tools');
  await app.submit('/extensions');
  // An untrusted folder is not scanned, so the bundled extensions stay unlisted
  // until the folder is trusted and integrations load.
  assert.match(app.state.notices.at(-1)!, /^No extensions\./);
  await app.submit('/trust');
  assert.equal(app.state.notices.at(-1), `Trusted ${workspace}`);
  assert.equal(loadSettings(home).trusted_folders.length, 1);
  await app.submit('/reload');
  assert.equal(app.state.notices.at(-1), 'Reloaded settings and the model');
  assert.equal(runtime.harness.model.model, 'saved-model');
});

test("/login asks for the URL and the key on its list, lists the endpoint's models, and signs in only once a model is chosen", async (t) => {
  // An endpoint that lists its models only under /v1, as setup finds it
  const seen: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request);
    seen.push(
      `${request.method} ${request.url} ${request.headers.authorization ?? ''}`,
    );
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ data: [{ id: 'alpha-one' }, { id: 'beta-two' }] }),
      );
    } else if (
      request.method === 'POST' &&
      request.url === '/v1/chat/completions'
    ) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        'data: ' +
          JSON.stringify({
            choices: [
              { index: 0, delta: { content: 'pong' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end('{"error":"not here"}');
    }
  });
  await new Promise<void>((ready) =>
    server.listen(0, '127.0.0.1', () => ready()),
  );
  cleanup(t, async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const home = scratch(t);
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = 'https://gateway.example/v1/';
  settings.auth.model = 'saved-model';
  saveSettings(settings, home);
  saveCredentials({ api_key: 'old-key' }, home);
  const before = readFileSync(join(home, 'settings.json'), 'utf8');
  // started with `-m`: the model chosen in /login still wins
  const { app, ui, runtime, key } = await session(t, [], {
    home,
    settings: structuredClone(settings),
    modelOverride: 'flag-model',
  });
  // What reached the screen, not only what the list holds
  let painted: string[] = [];
  ui.screen.render = (rows: string[]) => {
    painted = rows.map((text) => stripAnsi(text));
  };
  const typed = async (text: string): Promise<void> => {
    for (const char of text) await key(char, char);
  };
  // The URL straight away, on the list's own line with the saved one filled in; under it,
  // what is in use now. esc there leaves /login.
  const open = (): Picker | undefined => app.state.picker;
  const row = (index: number): string =>
    stripAnsi(open()!.rows(120)[index]!).trim();
  const line = (): string => row(1);
  await app.submit('/login');
  await key('enter'); // custom endpoint
  assert.equal(open()!.title, 'Sign in');
  assert.equal(app.state.dialog, undefined);
  assert.equal(
    line(),
    'base url: https://gateway.example/v1/▏  enter continues · esc closes',
  );
  assert.equal(row(2), 'now gateway.example/v1 · saved-model');
  // The first frame already asks for the URL, before any key
  assert.ok(
    painted.some((text) =>
      text.includes('base url: https://gateway.example/v1/▏'),
    ),
    painted.join('\n'),
  );
  assert.ok(!painted.some((text) => text.includes('type to search')));
  await key('escape');
  assert.equal(open(), undefined);
  await app.submit('/login');
  await key('enter'); // custom endpoint
  const picker = open()!;
  await key('ctrl+u');
  await typed('nonsense');
  await key('enter');
  // Not a URL: the title says why and the line asks again with what was typed
  assert.equal(
    picker.title,
    'Sign in · use an http(s) API base URL without credentials, query or fragment',
  );
  assert.equal(line(), 'base url: nonsense▏  enter continues · esc closes');
  await key('ctrl+u');
  ui.handle({ type: 'paste', text: base });
  await key('enter');
  // The key as dots. The saved key is for gateway.example, another host: an empty enter
  // does not keep it
  assert.equal(line(), 'api key: ▏  enter continues · esc goes back');
  // esc on the key goes back to the URL as it was given
  await key('escape');
  assert.equal(app.state.picker, picker);
  assert.equal(picker.title, 'Sign in');
  assert.equal(line(), `base url: ${base}▏  enter continues · esc closes`);
  await key('enter');
  await key('enter');
  assert.equal(picker.title, 'Sign in · Enter the key for this endpoint');
  assert.equal(line(), 'api key: ▏  enter continues · esc goes back');
  assert.equal(seen.length, 0, seen.join('\n'));
  ui.handle({ type: 'paste', text: 'new-key' });
  assert.equal(line(), 'api key: •••••••▏  enter continues · esc goes back');
  await key('enter');
  // The endpoint's models, searchable; enter on a search nothing matches uses what was typed
  await until(() => app.state.picker?.items.length === 2);
  const models = app.state.picker!;
  assert.equal(models.options.hint, 'discovered 2 models (openai)');
  assert.deepEqual(
    models.items.map((item) => item.label),
    ['alpha-one', 'beta-two'],
  );
  assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), before);
  await typed('gamma');
  assert.equal(models.matches().length, 0);
  assert.ok(
    models
      .rows(120)
      .some((row) =>
        stripAnsi(row).includes('No model matches · enter uses what you typed'),
      ),
  );
  await key('enter');
  await until(() => app.state.notices.at(-1)?.startsWith('Signed in') === true);
  assert.equal(app.state.picker, undefined);
  assert.equal(
    app.state.notices.at(-1),
    `Signed in to 127.0.0.1:${port}/v1 · model gamma`,
  );
  // Saved: the URL that answered, the model and the new key
  const saved = loadSettings(home);
  assert.equal(saved.auth.base_url, `${base}/v1`);
  assert.equal(saved.auth.model, 'gamma');
  assert.equal(loadCredentials(home).api_key, 'new-key');
  // and the next turn goes there, with the new key
  await app.submit('ping');
  assert.ok(
    seen.includes('POST /v1/chat/completions Bearer new-key'),
    seen.join('\n'),
  );
  assert.equal(runtime.harness.model.model, 'gamma');
  assert.equal(app.state.model, 'gamma');
  // Again on the same host: an empty enter keeps the saved URL and key
  await app.submit('/login');
  await key('enter'); // custom endpoint
  assert.equal(line(), `base url: ${base}/v1▏  enter continues · esc closes`);
  await key('enter');
  assert.equal(
    line(),
    'api key (enter keeps the saved one): ▏  enter continues · esc goes back',
  );
  const asked = seen.length;
  await key('enter');
  await until(() => app.state.picker?.items.length === 2);
  assert.deepEqual(seen.slice(asked), ['GET /v1/models Bearer new-key']);
  await typed('beta');
  await key('enter');
  await until(
    () => app.state.notices.at(-1)?.endsWith('model beta-two') === true,
  );
  assert.equal(loadSettings(home).auth.model, 'beta-two');
  assert.equal(loadCredentials(home).api_key, 'new-key');
  // The key saved for gateway.example never went to this endpoint
  assert.ok(!seen.some((line) => line.includes('old-key')), seen.join('\n'));
});

test('/variables and /secrets keep named values, and the model is told the names', async (t) => {
  const { app, model, home, key, screen } = await session(t, [answer('noted')]);
  await app.submit('/variables base_url=https://example.test');
  assert.deepEqual(loadSettings(home).variables, {
    BASE_URL: 'https://example.test',
  });
  // The wording names this system's form: %NAME% on Windows.
  const literal = (text: string) =>
    new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  assert.match(
    screen(),
    literal(
      `BASE_URL=https://example.test · ${variableCopy().saved('BASE_URL')}`,
    ),
  );
  await app.submit('/variables 1BAD=x');
  assert.match(screen(), /Usage: \/variables NAME=value/);
  // A secret's value is never typed in the input box
  await app.submit('/secrets API_TOKEN=typed-in-the-box');
  assert.match(screen(), /Type a secret's value on its masked card/);
  assert.equal(existsSync(join(home, 'secrets.json')), false);
  const saving = app.submit('/secrets api_token');
  await until(() => app.state.dialog?.masked === true);
  for (const char of 'token-value-1') await key(char, char);
  assert.ok(!screen().includes('token-value-1'));
  await key('enter');
  await saving;
  assert.match(
    screen(),
    literal(`Saved secret API_TOKEN · ${variableCopy().saved('API_TOKEN')}`),
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')),
    { secrets: { API_TOKEN: 'token-value-1' } },
  );
  // One name, one kind
  await app.submit('/variables API_TOKEN=x');
  assert.match(screen(), /API_TOKEN is a secret · \/secrets API_TOKEN sets it/);
  // The list puts the command for a row in the input box
  await app.submit('/variables');
  const list = app.state.picker!;
  assert.equal(list.title, 'Variables');
  assert.deepEqual(
    list.items.map((item) => item.label),
    [
      'BASE_URL=https://example.test',
      'API_TOKEN=••••••••',
      'new variable',
      'new secret',
    ],
  );
  await key('enter');
  await until(
    () => app.state.draft === '/variables BASE_URL=https://example.test',
  );
  app.state.draft = '';
  await app.submit('tell me what you know');
  const system = model.requests[0]!.system;
  assert.match(system, /- BASE_URL = https:\/\/example\.test/);
  assert.match(system, /only by name: API_TOKEN/);
  assert.equal(JSON.stringify(model.requests).includes('token-value-1'), false);
  await app.submit('/variables BASE_URL=');
  await app.submit('/secrets API_TOKEN=');
  assert.deepEqual(loadSettings(home).variables, {});
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')),
    { secrets: {} },
  );
  assert.match(screen(), /Removed variable BASE_URL/);
  assert.match(screen(), /Removed secret API_TOKEN/);
});

test('a refused host key from a manual terminal profile connection retires its question', async (t) => {
  const { app, ui } = await session(t, []);
  const requests: { action: string; args: Record<string, unknown> }[] = [];
  ui.terminals.set(app.runtime, {
    request: async (
      _conversation: string,
      action: string,
      args: Record<string, unknown>,
    ) => {
      requests.push({ action, args: structuredClone(args) });
      if (action === 'connect')
        return {
          text: 'the host key needs an answer',
          approval: {
            kind: 'hostkey',
            token: 'manual-hk-token',
            host: 'sw1.lan:22',
            keyType: 'ssh-ed25519',
            fingerprint: 'SHA256:abc',
            privateHost: true,
          },
        };
      return { text: '' };
    },
    views: () => [],
  });
  ui.confirmHostKey = async () => 'reject';
  await ui.connectTerminalProfile('lab');
  assert.deepEqual(requests, [
    { action: 'connect', args: { profile: 'lab' } },
    { action: 'decline-host-key', args: { token: 'manual-hk-token' } },
  ]);
});

test('the terminal asks for files a page would get or gave, and for passing a certificate warning, on cards of their own', async (t) => {
  const { app, ui, key } = await session(t, []);
  const signal = new AbortController().signal;
  const upload = ui.confirmBrowser(
    {
      kind: 'upload',
      token: 'token',
      origin: 'https://device.lan',
      element: 'firmware',
      files: [{ path: '/tmp/fw.bin', name: 'fw.bin', size: 2048 }],
    },
    signal,
  );
  await until(() => Boolean(app.state.dialog));
  assert.equal(app.state.dialog!.title, 'upload');
  assert.match(
    app.state.dialog!.body,
    /Circle wants to give the page these files\nsite: https:\/\/device\.lan\nfield: firmware\nfw\.bin · 2\.0 KB · \/tmp\/fw\.bin/,
  );
  assert.deepEqual(app.state.dialog!.options, ['allow', 'reject']);
  await key('enter');
  assert.equal(await upload, 'once');
  const certificate = ui.confirmBrowser(
    {
      kind: 'certificate',
      token: 'token',
      url: 'https://172.16.6.215:8888/',
      host: '172.16.6.215:8888',
      subject: 'ProductWebUI',
      issuer: 'RSAWebRoot',
      fingerprint: 'AA:BB',
      validExpiry: 2284329600,
      privateHost: true,
    },
    signal,
  );
  await until(() => Boolean(app.state.dialog));
  assert.equal(app.state.dialog!.title, 'certificate');
  assert.match(
    app.state.dialog!.body,
    /issued to: ProductWebUI\nissued by: RSAWebRoot\nvalid until: 2042-05-22\nsha256: AA:BB/,
  );
  assert.deepEqual(app.state.dialog!.options, [
    'allow once',
    'always trust this certificate on this host',
    'reject',
  ]);
  await key('down');
  await key('enter');
  assert.equal(await certificate, 'always');
  // A download the model started: kept, kept from the site for the session, or discarded
  const download = {
    kind: 'download' as const,
    token: 'token',
    site: 'https://device.lan',
    files: [{ name: 'config.bin', size: 12 }],
  };
  const keep = ui.confirmBrowser(download, signal);
  await until(() => Boolean(app.state.dialog));
  assert.equal(app.state.dialog!.title, 'download');
  assert.equal(
    app.state.dialog!.body,
    'Circle downloaded files: keep them?\nsite: https://device.lan\nconfig.bin · 12 B',
  );
  assert.deepEqual(app.state.dialog!.options, [
    'keep',
    'allow downloads from this site for this session',
    'discard',
  ]);
  await key('down');
  await key('down');
  await key('enter');
  assert.equal(await keep, 'reject');
  // auto mode keeps them, passes a certificate warning and gives files, without a card
  ui.runtime!.policy.setMode(ui.runtime!.session.id, 'auto');
  assert.equal(await ui.confirmBrowser(download, signal), 'once');
  assert.equal(
    await ui.confirmBrowser(
      {
        kind: 'certificate',
        token: 'token',
        url: 'https://device.example.net/',
        host: 'device.example.net',
        subject: 'Device',
        issuer: 'Device',
        fingerprint: 'AA:BB',
        validExpiry: 2284329600,
        privateHost: false,
      },
      signal,
    ),
    'auto',
  );
  assert.equal(
    await ui.confirmBrowser(
      {
        kind: 'upload',
        token: 'token',
        origin: 'https://device.lan',
        element: 'firmware',
        files: [{ path: '/tmp/fw.bin', name: 'fw.bin', size: 2048 }],
      },
      signal,
    ),
    'once',
  );
  assert.equal(app.state.dialog, undefined);
  ui.runtime!.policy.setMode(ui.runtime!.session.id, 'manual');
  // Circle hands the person the browser: the card stays until they continue
  let handed = false;
  const handoff = ui
    .handBrowser('sign in with your security key', signal)
    .then(() => (handed = true));
  await until(() => Boolean(app.state.dialog));
  assert.equal(app.state.dialog!.title, 'browser');
  assert.match(
    app.state.dialog!.body,
    /^Circle hands you the browser: sign in with your security key\nUse the browser window\. Circle does not see what you do there; it learns where the tabs went, never what you typed\. When you are done, choose continue\.$/,
  );
  assert.deepEqual(app.state.dialog!.options, ['continue']);
  assert.equal(handed, false);
  await key('enter');
  await handoff;
  assert.equal(handed, true);
});

function descriptionColumn(line: string): number | undefined {
  const match = line.match(/^(.*\S)( {2,})(\S.*)$/);
  if (!match) return undefined;
  return stringWidth(match[1]!) + match[2]!.length;
}

test('/help and /hotkeys hang continuations under the description column at 80 columns', async (t) => {
  const saved = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LANGUAGE: process.env.LANGUAGE,
  };
  const savedColumns = process.stdout.columns;
  // On a Chinese system the terminal's words stay English, laid out the same way
  process.env.LANG = 'zh_CN.UTF-8';
  delete process.env.LC_ALL;
  delete process.env.LANGUAGE;
  Object.defineProperty(process.stdout, 'columns', {
    configurable: true,
    value: 80,
  });
  try {
    const { app } = await session(t, []);
    const shown = async (command: string): Promise<string[]> => {
      await app.submit(command);
      return transcriptRows(app.state, 80).map((row) =>
        stripAnsi(row).replace(/ +$/, ''),
      );
    };
    const help = await shown('/help');
    const helpRow = help.find((row) => row.includes('/hooks'));
    assert.ok(helpRow, help.join('\n'));
    assert.match(helpRow, /^ {5}\//);
    const helpWrap = help.findIndex((row) => /^ {5}\/effort /.test(row));
    assert.ok(helpWrap >= 0, help.join('\n'));
    const column = descriptionColumn(help[helpWrap]!);
    assert.ok(column && column > 5, help[helpWrap]);
    const next = help[helpWrap + 1]!;
    assert.equal(next.slice(0, column), ' '.repeat(column), next);
    assert.notEqual(next[column], ' ');
    assert.ok(help.some((row) => row.includes(' (/connect)')));
    assert.ok(help.some((row) => row.includes(' (/quit, /q)')));
    const hotkeys = await shown('/hotkeys');
    const labelColumn = (line: string, label: string): number => {
      const at = line.indexOf(label);
      assert.ok(at > 0, line);
      const gap = line.slice(at + label.length).match(/^ */)?.[0].length ?? 0;
      return stringWidth(line.slice(0, at + label.length)) + gap;
    };
    const list = hotkeys.find((row) => row.includes('in a list'));
    const drag = hotkeys.find((row) => row.includes('mouse drag'));
    assert.ok(list && drag, hotkeys.join('\n'));
    const hotkeyColumn = labelColumn(list, 'in a list');
    assert.equal(labelColumn(drag, 'mouse drag'), hotkeyColumn);
    assert.match(list, /^ {5}/);
    const hung = hotkeys.find(
      (row, index) =>
        index > 0 &&
        row.startsWith(' '.repeat(hotkeyColumn)) &&
        row[hotkeyColumn] !== ' ' &&
        !row.includes('in a list'),
    );
    assert.ok(hung, hotkeys.join('\n'));
    for (const text of [help, hotkeys].flat())
      assert.equal(/\p{Script=Han}/u.test(text), false, text);
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: savedColumns,
    });
  }
});
