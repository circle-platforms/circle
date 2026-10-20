import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Picker } from '../src/ink/components/picker.js';
import { stripAnsi } from '../src/ink/string_width.js';
import {
  DATABASE_BUSY_MESSAGE,
  DATABASE_WAIT_STATUS,
  interfaceLocale,
  uiText,
} from '../src/locale.js';
import {
  renderScreen,
  transcriptRows,
  type ScreenState,
} from '../src/tui/render.js';
import { resultRows } from '../src/tui/tool_rows.js';
import { emptyUsage, type Message } from '../src/types.js';

test('interface locale follows LANG the same way a Chinese system does', () => {
  assert.equal(interfaceLocale({ LANG: 'zh_CN.UTF-8' }), 'zh-CN');
  assert.equal(interfaceLocale({ LANGUAGE: 'zh_CN:en' }), 'zh-CN');
  assert.equal(interfaceLocale({ LANG: 'zh-Hans' }), 'zh-CN');
  assert.equal(interfaceLocale({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(interfaceLocale({ LC_ALL: 'C' }), 'en');
  assert.equal(uiText('view only', 'en'), 'view only');
  assert.equal(
    uiText('Resumed circle-abc · title', 'en'),
    'Resumed circle-abc · title',
  );
});

test('a Chinese locale translates the session list, resume line, view only and search quota', () => {
  assert.equal(uiText('view only', 'zh-CN'), '仅查看');
  assert.equal(uiText('Sessions · this folder', 'zh-CN'), '会话 · 此文件夹');
  assert.equal(uiText('Sessions · every folder', 'zh-CN'), '会话 · 所有文件夹');
  assert.equal(
    uiText('Resumed circle-abc · 京都介绍', 'zh-CN'),
    '已恢复 circle-abc · 京都介绍',
  );
  assert.equal(uiText('↑ 6 more above', 'zh-CN'), '↑ 上方还有 6 个');
  assert.equal(
    uiText('this session is writable again', 'zh-CN'),
    '另一端已关闭，可以继续对话了',
  );
  assert.equal(
    uiText(
      'Open in another terminal · view only · circle --fork circle-abc copies it here',
      'zh-CN',
    ),
    '已在另一终端打开 · 仅查看 · 用 circle --fork circle-abc 复制一份到这里继续',
  );
  assert.equal(
    uiText('Allow "echo …" for this session', 'zh-CN'),
    '本会话内允许“echo …”',
  );
  assert.equal(uiText('Exit code: 0', 'zh-CN'), '退出码 0');
  assert.equal(
    uiText('The user rejected this tool call. The user said: no', 'zh-CN'),
    '已拒绝 · 你说：no',
  );
  assert.equal(
    uiText('Native search unavailable: search quota exceeded', 'zh-CN'),
    '原生搜索不可用：搜索额度不足',
  );

  const saved = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LANGUAGE: process.env.LANGUAGE,
  };
  process.env.LANG = 'zh_CN.UTF-8';
  process.env.LC_ALL = 'zh_CN.UTF-8';
  delete process.env.LANGUAGE;
  try {
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
    assert.match(listed, /会话 · 此文件夹/);
    assert.match(listed, /回车打开 · tab 所有文件夹/);
    assert.match(listed, /输入以搜索/);
    const lines = listed.split('\n').map((line) => line.trim());
    const above = lines.findIndex((line) => line.includes('上方还有 6 个'));
    const search = lines.findIndex((line) => line.includes('输入以搜索'));
    assert.ok(above > search);
    assert.match(lines[above + 1] ?? '', /session /);
    assert.equal(
      lines.slice(search + 1, above).some((line) => line.includes('session ')),
      false,
    );
    assert.match(listed, /session 11 · 当前/);

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
    assert.match(quota, /提供方：DuckDuckGo/);
    assert.equal(
      uiText(DATABASE_BUSY_MESSAGE, 'zh-CN'),
      '数据库正忙 · 另一个 Circle 正在使用此数据文件夹。请稍候再启动',
    );
    assert.equal(uiText(DATABASE_WAIT_STATUS, 'zh-CN'), '正在等待数据库…');
    assert.equal(
      uiText(DATABASE_WAIT_STATUS, 'en'),
      'waiting for the database…',
    );
    assert.match(quota, /原生搜索不可用：搜索额度不足/);
    assert.equal(quota.includes('Provider: DuckDuckGo'), false);
    assert.equal(quota.includes('search quota exceeded'), false);

    const screen = {
      welcome: [],
      messages: [] as Message[],
      notices: [
        'Resumed circle-abc · title',
        'Open in another terminal · view only · circle --fork circle-abc copies it here',
        'this session is writable again',
      ],
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
      viewOnly: true,
      autoMode: false,
      todos: [],
      usage: emptyUsage(),
      flash: '',
      started: 0,
      scroll: 0,
      storeWait: true,
    } as ScreenState;
    const transcript = stripAnsi(transcriptRows(screen, 80).join('\n'));
    assert.match(transcript, /已恢复 circle-abc · title/);
    assert.match(transcript, /已在另一终端打开 · 仅查看/);
    assert.match(transcript, /另一端已关闭，可以继续对话了/);
    assert.equal(transcript.includes('view only'), false);
    assert.equal(transcript.includes('Resumed'), false);
    const frame = stripAnsi(renderScreen(screen, 80, 24).join('\n'));
    assert.match(frame, /仅查看/);
    assert.equal(
      frame.split('\n').filter((line) => line.includes('正在等待数据库…'))
        .length,
      1,
    );
    assert.equal(frame.includes('view only'), false);
    assert.equal(frame.includes('waiting for the database'), false);
  } finally {
    process.env.LANG = saved.LANG;
    process.env.LC_ALL = saved.LC_ALL;
    if (saved.LANGUAGE === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = saved.LANGUAGE;
  }
});

test('an English screen says it is waiting for the database', () => {
  const saved = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LANGUAGE: process.env.LANGUAGE,
  };
  process.env.LANG = 'en_US.UTF-8';
  process.env.LC_ALL = 'en_US.UTF-8';
  delete process.env.LANGUAGE;
  try {
    const frame = stripAnsi(
      renderScreen(
        {
          welcome: [],
          messages: [],
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
          storeWait: true,
        } as ScreenState,
        80,
        24,
      ).join('\n'),
    );
    assert.equal(
      frame
        .split('\n')
        .filter((line) => line.includes('waiting for the database…')).length,
      1,
    );
    assert.equal(frame.includes('正在等待数据库'), false);
  } finally {
    process.env.LANG = saved.LANG;
    process.env.LC_ALL = saved.LC_ALL;
    if (saved.LANGUAGE === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = saved.LANGUAGE;
  }
});
