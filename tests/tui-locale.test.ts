import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { helpText as cliHelpText } from '../src/cli.js';
import { connectionModels } from '../src/connection_models.js';
import { Picker } from '../src/ink/components/picker.js';
import { stripAnsi } from '../src/ink/string_width.js';
import {
  DATABASE_WAIT_STATUS,
  desktopChinese,
  desktopText,
} from '../src/locale.js';
import { resolveEndpoint } from '../src/probe.js';
import { formatHotkeys } from '../src/tui/hotkeys_text.js';
import {
  renderScreen,
  transcriptRows,
  type ScreenState,
} from '../src/tui/render.js';
import { helpText } from '../src/tui/slash_commands.js';
import { busyLabel } from '../src/tui/status_rows.js';
import { resultRows } from '../src/tui/tool_rows.js';
import { emptyUsage, type Message } from '../src/types.js';
import { scratch } from './helpers.js';

const han = (text: string): boolean => /\p{Script=Han}/u.test(text);
const LOCALE = ['LANG', 'LC_ALL', 'LANGUAGE', 'CIRCLE_DESKTOP_RUNTIME_HOME'];
function withLocale(values: Record<string, string>, run: () => void): void {
  const saved = Object.fromEntries(
    LOCALE.map((name) => [name, process.env[name]]),
  );
  for (const name of LOCALE) delete process.env[name];
  Object.assign(process.env, values);
  try {
    run();
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}
function screen(overrides: Partial<ScreenState> = {}): ScreenState {
  return {
    welcome: [],
    messages: [] as Message[],
    notices: [],
    hiddenTurns: 0,
    showThinking: false,
    showTools: false,
    streaming: '',
    thinking: '',
    draft: '',
    draftCursor: 0,
    model: 'test',
    workspace: '/tmp',
    version: '0',
    busy: false,
    waiting: false,
    planMode: false,
    autoMode: false,
    todos: [],
    usage: emptyUsage(),
    flash: '',
    started: 0,
    scroll: 0,
    ...overrides,
  } as ScreenState;
}

test('a Chinese system leaves the session list, the transcript and the help English', () => {
  withLocale({ LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' }, () => {
    const picker = new Picker(
      'Sessions · this folder',
      Array.from({ length: 12 }, (_, index) => ({
        key: String(index),
        label: `session ${index}`,
        current: index === 11,
      })),
      () => {},
      () => {},
      {
        hint: 'enter opens · tab every folder · ctrl+r renames · ctrl+k deletes',
        focusKey: '0',
      },
    );
    picker.focus = 11;
    const listed = stripAnsi(picker.rows(60, 6).join('\n'));
    assert.match(listed, /Sessions · this folder/);
    assert.match(listed, /enter opens · tab every folder/);
    // The count of rows above sits after the hint and the search line
    const lines = listed.split('\n').map((line) => line.trim());
    const above = lines.findIndex((line) => line === '↑ 6 more above');
    const search = lines.findIndex((line) => line === 'type to search');
    assert.ok(search > 0 && above > search);
    assert.match(lines[above + 1] ?? '', /session /);
    assert.match(listed, /session 11 · current/);
    const aged = new Picker(
      'Sessions · this folder',
      [
        { key: 's', label: 's', meta: '50m' },
        { key: 'h', label: 'later', meta: '1h · running' },
      ],
      () => {},
      () => {},
    );
    const ages = stripAnsi(aged.rows(80, 6).join('\n'));
    assert.match(ages, /50m/);
    assert.match(ages, /1h · running/);
    aged.confirm('Delete “s” and its messages?', () => {});
    assert.match(
      stripAnsi(aged.rows(80, 6).join('\n')),
      /Delete “s” and its messages\? {2}enter confirms · esc cancels/,
    );
    aged.ask('Rename', 's', () => {}, {
      replace: true,
      keys: 'typing replaces the name · enter saves · esc cancels',
    });
    const rename = stripAnsi(aged.rows(80, 6).join('\n'));
    assert.match(rename, /Rename: s/);
    assert.match(rename, /typing replaces the name · enter saves/);

    const quota = stripAnsi(
      resultRows(
        { id: 'call', name: 'websearch', args: { query: 'circle' } },
        {
          id: 'result',
          role: 'tool',
          tool_call_id: 'call',
          content:
            'Provider: DuckDuckGo\nNative search unavailable: search quota exceeded',
        },
        { width: 80, expanded: true },
      ).join('\n'),
    );
    assert.match(quota, /Provider: DuckDuckGo/);
    assert.match(quota, /Native search unavailable: search quota exceeded/);

    const state = screen({
      notices: [
        'Resumed circle-abc · title',
        'Open in another terminal · view only · circle --fork circle-abc copies it here',
        'this session is writable again',
        '✖ Interrupted',
      ],
      viewOnly: true,
      storeWait: true,
    });
    const transcript = stripAnsi(transcriptRows(state, 80).join('\n'));
    assert.match(transcript, /Resumed circle-abc · title/);
    assert.match(transcript, /Open in another terminal · view only/);
    assert.match(transcript, /this session is writable again/);
    assert.match(transcript, /✖ Interrupted/);
    assert.equal(han(transcript), false);
    const frame = stripAnsi(renderScreen(state, 80, 24).join('\n'));
    assert.match(frame, /view only/);
    assert.equal(
      frame.split('\n').filter((line) => line.includes(DATABASE_WAIT_STATUS))
        .length,
      1,
    );
    assert.equal(han(frame), false);

    assert.equal(busyLabel('Considering', 2, 10), 'Considering… · 2s · ↓ 10');
    const help = helpText();
    assert.match(help, /\/hooks\s+List hooks/);
    const keys = formatHotkeys(80);
    assert.match(keys, /^Keyboard shortcuts:/);
    assert.match(keys, /ctrl\+q\s+queue a follow-up/);
    const usage = cliHelpText(80);
    assert.match(usage, /^usage: circle \[options\]/);
    for (const text of [help, keys, usage]) assert.equal(han(text), false);
  });
});

test('an English screen says it is waiting for the database', () => {
  withLocale({ LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }, () => {
    const frame = stripAnsi(
      renderScreen(screen({ storeWait: true }), 80, 24).join('\n'),
    );
    assert.equal(
      frame
        .split('\n')
        .filter((line) => line.includes('waiting for the database…')).length,
      1,
    );
  });
});

test('the desktop runtime keeps the Chinese of the messages it shows', async (t) => {
  const desktop = scratch(t);
  const zh = { CIRCLE_DESKTOP_RUNTIME_HOME: desktop };
  assert.equal(desktopChinese({ LANG: 'zh_CN.UTF-8' }), false);
  assert.equal(desktopChinese({ ...zh, LANG: 'zh_CN.UTF-8' }), true);
  assert.equal(desktopChinese({ ...zh, LANGUAGE: 'zh_CN:en' }), true);
  assert.equal(desktopChinese({ ...zh, LANG: 'zh-Hans' }), true);
  assert.equal(desktopChinese({ ...zh, LANG: 'en_US.UTF-8' }), false);
  assert.equal(desktopChinese({ ...zh, LC_ALL: 'C' }), false);
  assert.equal(
    desktopText('missing API key', { ...zh, LANG: 'zh_CN.UTF-8' }),
    '缺少 API 密钥',
  );
  // Words it has no Chinese for stay as written
  assert.equal(
    desktopText('something else', { ...zh, LANG: 'zh_CN.UTF-8' }),
    'something else',
  );

  const missingKey = async (): Promise<string[]> => {
    const probed = await resolveEndpoint('http://127.0.0.1:9/v1', '');
    const listed = await connectionModels('http://127.0.0.1:9/v1', '').then(
      () => '',
      (error: Error) => error.message,
    );
    return [probed.detail ?? '', listed];
  };
  const saved = Object.fromEntries(
    LOCALE.map((name) => [name, process.env[name]]),
  );
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  for (const name of LOCALE) delete process.env[name];
  process.env.LANG = 'zh_CN.UTF-8';
  assert.deepEqual(await missingKey(), ['missing API key', 'missing API key']);
  process.env.CIRCLE_DESKTOP_RUNTIME_HOME = desktop;
  assert.deepEqual(await missingKey(), ['缺少 API 密钥', '缺少 API 密钥']);
});

test('the terminal and the installers hold no Chinese words', () => {
  const root = join(import.meta.dirname, '..');
  const files = (folder: string): string[] =>
    readdirSync(folder).flatMap((name) => {
      const path = join(folder, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  const terminal = [
    ...files(join(root, 'src', 'tui')),
    ...files(join(root, 'src', 'ink')),
    ...[
      'cli.ts',
      'extensions.ts',
      'install_manager.ts',
      'line_setup.ts',
      'net.ts',
      'update.ts',
    ].map((name) => join(root, 'src', name)),
    join(root, 'install.sh'),
    join(root, 'install.ps1'),
  ];
  const found = terminal.filter((path) => han(readFileSync(path, 'utf8')));
  assert.deepEqual(found, []);
});
