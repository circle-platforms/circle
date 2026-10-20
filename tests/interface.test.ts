import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputParser } from '../src/ink/parse_keypress.js';
import {
  buildPalette,
  contrastRatio,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  DESKTOP_LIGHT,
  setPalette,
  hexToRgb,
  rgbToHex,
} from '../src/ink/theme.js';
import {
  hangingWrap,
  stripAnsi,
  stringWidth,
  wrap,
  truncate,
} from '../src/ink/string_width.js';
import { renderScreen, type ScreenState } from '../src/tui/render.js';
import { CompactionProgress } from '../src/compaction.js';
import { emptyUsage } from '../src/types.js';
import { parseCli, UsageError } from '../src/cli.js';
import { substituteArguments } from '../src/commands.js';
import { fromJsonl, toJsonl, toHtml } from '../src/session_export.js';
function state(): ScreenState {
  return {
    messages: [],
    notices: [],
    welcome: [],
    draft: '中文 draft',
    draftCursor: 3,
    model: 'model',
    workspace: '/project',
    version: 'test',
    busy: false,
    waiting: false,
    planMode: false,
    autoMode: false,
    todos: [],
    showThinking: false,
    showTools: false,
    streaming: '',
    thinking: '',
    usage: emptyUsage(),
    flash: '',
    started: 0,
    scroll: 0,
    hiddenTurns: 0,
  };
}
test('input parser buffers fragmented bracketed paste and terminal reports never type letters', () => {
  const parser = new InputParser();
  assert.deepEqual(parser.feed('\x1b[200~hello\n\x1b[20'), []);
  assert.deepEqual(parser.feed('1~'), [{ type: 'paste', text: 'hello\n' }]);
  assert.deepEqual(parser.feed('\x1b[?2031;2$y'), []);
  assert.deepEqual(parser.feed('\x1b[?997;2n'), [
    { type: 'scheme', dark: false },
  ]);
  assert.deepEqual(parser.feed('\x1b]11;rgb:ffff/ffff/ffff\x1b\\'), [
    { type: 'color', slot: 11, color: '#ffffff' },
  ]);
  assert.deepEqual(parser.feed('\x1b[A\x1b\r'), [
    { type: 'key', key: 'up', char: '' },
    { type: 'key', key: 'shift+enter', char: '\r' },
  ]);
});
test('an esc in front of an arrow or page key is that key with alt, not esc and then the key', () => {
  const parser = new InputParser();
  const keys = (bytes: string) =>
    parser.feed(bytes).map((event) => (event.type === 'key' ? event.key : ''));
  // Terminal.app with "Use Option as Meta key", iTerm2 with option as Esc+
  assert.deepEqual(keys('\x1b\x1b[A'), ['alt+up']);
  assert.deepEqual(keys('\x1b\x1bOB'), ['alt+down']);
  assert.deepEqual(keys('\x1b\x1b[5~'), ['alt+pageup']);
  assert.deepEqual(keys('\x1b\x1b[1;2C'), ['alt+shift+right']);
  // xterm's own form stays as it was
  assert.deepEqual(keys('\x1b[1;3A'), ['alt+up']);
  // split between two reads
  assert.deepEqual(keys('\x1b\x1b['), []);
  assert.deepEqual(keys('A'), ['alt+up']);
  // esc then something that is not a key is still esc first
  assert.deepEqual(parser.feed('\x1b\x1b[200~x\x1b[201~'), [
    { type: 'key', key: 'escape', char: '' },
    { type: 'paste', text: 'x' },
  ]);
  assert.deepEqual(keys('\x1b\x1bx'), ['escape', 'alt+x']);
  // esc and then ↑ typed quickly come in two reads: still esc, then ↑
  assert.deepEqual(keys('\x1b'), []);
  assert.deepEqual(keys('\x1b[A'), ['escape', 'up']);
  // a CSI-u key after esc is not taken for an F key
  assert.deepEqual(keys('\x1b\x1b[13;2u'), ['escape', 'shift+enter']);
  // esc and then a letter typed quickly: esc, then the letter, not alt+q
  assert.deepEqual(keys('\x1b'), []);
  assert.deepEqual(keys('quick'), ['escape', 'q', 'u', 'i', 'c', 'k']);
  // option+letter sent as esc and the letter in one read stays alt+letter
  assert.deepEqual(keys('\x1bv'), ['alt+v']);
  // keypad Enter and kitty Enter / Esc used to be dropped, so a reason row
  // never saw them
  assert.deepEqual(keys('\x1bOM'), ['enter']);
  assert.deepEqual(keys('\x1b[13u'), ['enter']);
  assert.deepEqual(keys('\x1b[13;1u'), ['enter']);
  assert.deepEqual(keys('\x1b[27u'), ['escape']);
  assert.deepEqual(keys('\x1b[27;1u'), ['escape']);
});
test('Chinese and graphemes occupy terminal cells, and truncation preserves filename tails', () => {
  assert.equal(stringWidth('中文'), 4);
  assert.deepEqual(wrap('中文abc', 4), ['中文', 'abc']);
  assert.equal(stringWidth(truncate('文件/file.ts', 7, true)), 7);
});
test('wrap breaks CJK anywhere and keeps ASCII runs and quoted spans whole', () => {
  assert.deepEqual(wrap('detail page', 8), ['detail', 'page']);
  // A lone Han glyph is pulled back onto the previous break, so the last line is not one character.
  assert.deepEqual(wrap('中文中文', 6), ['中文', '中文']);
  assert.deepEqual(wrap('MCP 服务器', 8), ['MCP 服', '务器']);
  assert.deepEqual(wrap('甲（乙丙丁', 4), ['甲', '（乙', '丙丁']);
  assert.ok(!wrap('甲（乙丙丁', 4).some((line) => line.endsWith('（')));
  assert.deepEqual(wrap('    密码在卡片上', 12), ['    密码在卡', '    片上']);
  assert.deepEqual(wrap('abc readers', 10), ['abc', 'readers']);
  assert.deepEqual(wrap('run hook191-command please', 16), [
    'run',
    'hook191-command',
    'please',
  ]);
  assert.ok(
    !wrap('run hook191-command please', 16).some((line) => line === 'hoo'),
  );
  assert.deepEqual(wrap('前「好 N」后', 10), ['前「好 N」', '后']);
  const quoted = wrap('see 「事件 N」 please', 14);
  assert.ok(quoted.some((line) => line.includes('「事件 N」')));
  assert.deepEqual(wrap('readers', 4), ['read', 'ers']);
  const flow =
    '把这个文件交给它做，跟随，并保存结果（module-execute 要的是流程输入 JSON，不是文件）';
  const forbidden = /^[，。、）」』》〉〗〕｝！？：；]/;
  const at = wrap(flow, 39);
  assert.ok(
    at.every((line) => !forbidden.test(line)),
    at.join('\n'),
  );
  assert.equal(
    at.some((line) => line === '，不' || line.startsWith('，')),
    false,
  );
  const prefix = '/hub submit <pack> <file>'.padEnd(38);
  const shown = wrap(hangingWrap(prefix, flow, 77).join('\n'), 77);
  assert.ok(shown.some((line) => line.includes('module-execute')));
  assert.ok(
    shown.every((line) => !forbidden.test(line.trimStart())),
    shown.join('\n'),
  );
  assert.equal(
    shown.some((line) => line.trim() === '，不'),
    false,
  );
  const hung = hangingWrap('  /hub  ', 'revoke the token at the server', 24);
  assert.equal(hung[0]?.startsWith('  /hub  '), true);
  assert.ok(hung.length > 1);
  assert.ok(hung.slice(1).every((line) => line.startsWith(' '.repeat(8))));
  assert.ok(hung.every((line) => stringWidth(line) <= 24));
});
test('palette contrast is readable across panel and all type surfaces in dark and light themes', () => {
  for (const defaults of [DEFAULT_DARK, DEFAULT_LIGHT, DESKTOP_LIGHT]) {
    const p = buildPalette(...defaults);
    const sgrToHex = (sgr: string) =>
      rgbToHex(
        sgr.match(/\d+/g)!.slice(-3).map(Number) as [number, number, number],
      );
    const dim = sgrToHex(p.dim);
    const faint = sgrToHex(p.faint);
    for (const surface of [
      p.bg_hex,
      sgrToHex(p.panel_bg),
      p.read_bg_hex,
      p.write_bg_hex,
      p.think_bg_hex,
      p.agent_bg_hex,
    ]) {
      assert.ok(contrastRatio(dim, surface) >= 4.5);
      assert.ok(contrastRatio(faint, surface) >= 3);
    }
  }
  assert.deepEqual(hexToRgb('#fff'), [255, 255, 255]);
});
test('screen rows respect width, short dialogs keep options, and read-only wins over auto', () => {
  for (const palette of [
    buildPalette(...DEFAULT_DARK),
    buildPalette(...DEFAULT_LIGHT),
  ]) {
    setPalette(palette);
    for (const width of [24, 60, 100]) {
      const screen = state();
      screen.planMode = true;
      screen.autoMode = true;
      const rows = renderScreen(screen, width, 24);
      assert.equal(rows.length, 24);
      for (const row of rows)
        assert.equal(stringWidth(row), width, stripAnsi(row));
      assert.ok(rows.some((row) => stripAnsi(row).includes('read-only')));
      assert.ok(!rows.some((row) => stripAnsi(row).includes(' auto ')));
    }
  }
  const screen = state();
  screen.dialog = {
    title: 'approval',
    body: 'long\n'.repeat(100),
    options: ['allow this call', 'reject'],
    focus: 1,
  };
  const rendered = renderScreen(screen, 60, 12).map(stripAnsi).join('\n');
  assert.match(rendered, /reject/);
  assert.match(rendered, /\+\d+ lines/);
});
test('background job rows stay below the input and use the shared terminal palette without leaking command escapes', () => {
  const screen = state();
  screen.jobs = [
    {
      id: 'j1',
      kind: 'shell',
      title: '\x1b]52;c;c2VjcmV0\x07npm test',
      sessionId: 'session',
      status: 'running',
      reason: '',
      started: Date.now(),
      outputPath: '/missing-output',
      virtualPath: '/background_jobs/test/job.log',
    },
  ];
  for (const height of [8, 24]) {
    const rows = renderScreen(screen, 60, height);
    assert.equal(rows.length, height);
    const plain = rows.map(stripAnsi);
    const jobHeader = plain.findIndex((row) => row.includes('Jobs · 1'));
    assert.ok(jobHeader > plain.findIndex((row) => row.includes('╰')));
    assert.ok(rows.every((row) => !row.includes('\x1b]52;')));
    assert.ok(rows.every((row) => stringWidth(row) === 60));
  }
});
test('compaction and cost/context footer rows retain the established labels and never show a percentage for an unknown window', () => {
  const screen = state();
  screen.contextInput = 12_000;
  screen.costText = 'N/A';
  const unknown = renderScreen(screen, 120, 24).map(stripAnsi).join('\n');
  assert.match(unknown, /ctx 12.0k\/N\/A/);
  assert.ok(!unknown.split('ctx')[1]!.includes('%'));
  screen.contextWindow = 1_000_000;
  screen.costText = '$0.0030';
  const known = renderScreen(screen, 120, 24).map(stripAnsi).join('\n');
  assert.match(known, /ctx 12.0k\/1.0M \(1%\)/);
  assert.match(known, /\$0.0030/);
  screen.busy = true;
  screen.compaction = new CompactionProgress('tool');
  screen.compaction.apply({
    sessionId: 'session',
    phase: 'summarizing',
    trigger: 'tool',
  });
  assert.match(
    renderScreen(screen, 120, 24).map(stripAnsi).join('\n'),
    /compacting.*summarizing/,
  );
});
test('CLI preserves print flag placement and rejects conflicting saved-session options', () => {
  const options = parseCli(
    ['-p', '-c', 'hello', '.', '--tools', 'read,grep'],
    process.cwd(),
  );
  assert.equal(options.print, true);
  assert.equal(options.continue, true);
  assert.deepEqual(options.prompts, ['hello']);
  assert.deepEqual(options.run.tools, ['read_file', 'grep']);
  for (const args of [
    ['--fork', 'id', '-c'],
    ['--no-session', '--session', 'id'],
    ['-r', '-p', 'hello'],
    ['--line', 'hello there'],
    ['--thinking', 'invalid'],
  ])
    assert.throws(() => parseCli(args), UsageError);
});
test('custom argument substitution is one pass and retains quoted values', () => {
  assert.equal(
    substituteArguments(
      '$1 / $2 / ${3:-fallback} / ${@:2:1}',
      '"hello world" "$1"',
    ),
    'hello world / $1 / fallback / $1',
  );
});
test('session export round-trips exact raw tool output, validates references, and escapes HTML', () => {
  const meta = {
    thread_id: 'one',
    title: '<title>',
    model: 'test',
    workspace: '/project',
  };
  const messages = [
    { id: '1', role: 'user' as const, content: '<script>bad</script>' },
    {
      id: '2',
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id: 'call', name: 'read', args: {} }],
    },
    {
      id: '3',
      role: 'tool' as const,
      content: 'raw\n\u0000',
      tool_call_id: 'call',
      name: 'read',
    },
  ];
  assert.deepEqual(fromJsonl(toJsonl(messages, meta)).messages, messages);
  assert.throws(
    () => fromJsonl(toJsonl(messages.slice(0, 2), meta)),
    /pending/,
  );
  const html = toHtml(messages, meta);
  assert.ok(!html.includes('<script>bad'));
  assert.match(html, /&lt;script&gt;/);
});
