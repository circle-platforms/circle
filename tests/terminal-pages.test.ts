// The terminal page as the contract draws it: strip rows, the two-row band, the emulated
// screen with colours only from the palette's ANSI map, and the keys while attached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  palette,
  setPalette,
  terminalAnsiBg,
  terminalAnsiFg,
  type Palette,
} from '../src/ink/theme.js';
import { stringWidth, stripAnsi } from '../src/ink/string_width.js';
import { renderScreen, type ScreenState } from '../src/tui/render.js';
import { terminalRows } from '../src/tui/strip_rows.js';
import {
  TerminalSessions,
  type TerminalView,
} from '../src/terminal/sessions.js';
import type {
  Connector,
  TerminalTransport,
} from '../src/terminal/transport.js';
import { emptyUsage } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';

const PALETTES: [string, Palette][] = [
  ['dark', buildPalette(...DEFAULT_DARK)],
  ['light', buildPalette(...DEFAULT_LIGHT)],
];

class FakeConsole implements TerminalTransport {
  private data: (bytes: Buffer) => void = () => {};
  private end: (reason: string) => void = () => {};
  typed: string[] = [];
  sizes: [number, number][] = [];
  onData(handler: (bytes: Buffer) => void): void {
    this.data = handler;
  }
  onEnd(handler: (reason: string) => void): void {
    this.end = handler;
  }
  write(bytes: Buffer | string): void {
    this.typed.push(Buffer.from(bytes as never).toString('utf8'));
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }
  close(): void {
    this.end('disconnected');
  }
  emit(text: string): void {
    // bytes, as a device sends them: the emulator decodes UTF-8 itself
    this.data(Buffer.from(text, 'utf8'));
  }
}

function harness() {
  const consoles: FakeConsole[] = [];
  const connector: Connector = async () => {
    const one = new FakeConsole();
    consoles.push(one);
    return { transport: one };
  };
  const changes: string[] = [];
  const manager = new TerminalSessions({
    connectors: { ssh: connector, telnet: connector },
    profiles: () => [],
    secret: () => '',
    keyFile: (path) => path,
    onChange: (conversation) => changes.push(conversation),
  });
  const signal = AbortSignal.timeout(10000);
  return {
    manager,
    consoles,
    open: (id = 'c1') =>
      manager.request(
        id,
        'connect',
        { host: 'sw1.lan', transport: 'ssh' },
        signal,
      ),
  };
}

function bigScreen(t: Parameters<typeof scratch>[0]): void {
  for (const [name, value] of [
    ['rows', 60],
    ['columns', 110],
  ] as const) {
    const before = Object.getOwnPropertyDescriptor(process.stdout, name);
    Object.defineProperty(process.stdout, name, {
      value,
      configurable: true,
      writable: true,
    });
    cleanup(t, () => {
      if (before) Object.defineProperty(process.stdout, name, before);
      else delete (process.stdout as never as Record<string, unknown>)[name];
    });
  }
}

async function attached(
  t: Parameters<typeof scratch>[0],
  model: ScriptedModel,
) {
  bigScreen(t);
  const root = scratch(t);
  const settings = trustFolder(defaultSettings(), root);
  const app = new SessionApp(root, root, settings);
  const ui = app as never as Record<string, any>;
  let rendered: string[] = [];
  ui.screen.render = (rows: string[]) => {
    rendered = rows;
  };
  await app.attach({
    workspace: root,
    home: root,
    settings,
    model,
    headless: true,
  });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    await app.runtime?.close();
  });
  return { app, ui, frame: (): string[] => (ui.repaint(), rendered) };
}

function screen(): ScreenState {
  return {
    messages: [],
    notices: [],
    welcome: [],
    draft: '',
    draftCursor: 0,
    model: 'model-x',
    workspace: '/project/app',
    version: '1.0.0',
    busy: false,
    waiting: false,
    planMode: false,
    autoMode: false,
    todos: [],
    showThinking: true,
    showTools: false,
    streaming: '',
    thinking: '',
    usage: emptyUsage(),
    flash: '',
    started: Date.now(),
    scroll: 0,
    hiddenTurns: 0,
  };
}

// Colours on a device page come from the palette's ANSI map: allow each slot's own codes
// beside the palette's; anything else fails.
function terminalColours(p: Palette, text: string): void {
  const allowed = new Set<string>();
  for (const sgr of [
    p.text,
    p.dim,
    p.faint,
    p.em,
    p.green,
    p.yellow,
    p.red,
    p.blue,
    p.reset,
    ...Array.from({ length: 16 }, (_, slot) => terminalAnsiFg(slot)),
  ])
    for (const match of sgr.matchAll(/\x1b\[([\d;]*)m/g))
      allowed.add(match[1]!);
  const bgs = [
    p.panel_bg,
    p.sel_bg,
    p.write_bg,
    p.agent_bg,
    p.read_bg,
    ...Array.from({ length: 16 }, (_, slot) => terminalAnsiBg(slot)),
  ].map((sgr) => sgr.slice(2, -1));
  for (const [, params] of text.matchAll(/\x1b\[([\d;]*)m/g)) {
    const parts = params!.split(';');
    for (let index = 0; index < parts.length; index++) {
      const code = parts[index]!;
      if (code === '38' || code === '48') {
        const value = parts.slice(index, index + 5).join(';');
        index += 4;
        assert.ok(
          allowed.has(value) || bgs.includes(value),
          `colour ${value} is neither palette nor ANSI map`,
        );
      } else if (/^(3|4|9|10)\d$/.test(code))
        assert.ok(
          allowed.has(code) ||
            [...allowed].some((sgr) => sgr.split(';').includes(code)),
          `colour ${code} is neither palette nor ANSI map`,
        );
    }
  }
}

test('strip rows: lamp, name, the last line the device showed and its quiet time', () => {
  const view: TerminalView = {
    id: 't1',
    name: 'LAB-DEVICE-01',
    target: 'sw1.lan:22',
    transport: 'ssh',
    state: 'ready',
    detail: '',
    held: undefined,
    quiet: 3000,
    cols: 80,
    rows: 24,
    last: 'ran: show version',
  };
  const rows = terminalRows([view], { width: 80, now: Date.now() });
  assert.equal(rows.length, 1);
  const plain = stripAnsi(rows[0]!);
  assert.match(plain, /^ ● t1 LAB-DEVICE-01 +ran: show version +3s $/);
  assert.equal(stringWidth(plain), 80);
  for (const [, p] of PALETTES) {
    setPalette(p);
    terminalColours(p, terminalRows([view], { width: 80 }).join('\n'));
  }
  setPalette(PALETTES[0]![1]);
  const held = terminalRows([{ ...view, held: 'attach' as const }], {
    width: 80,
  });
  assert.match(stripAnsi(held[0]!), /waiting for you/);
});

test('the page draws the device screen, band included, on both palettes', async (t) => {
  const h = harness();
  t.after(() => h.manager.close());
  await h.open();
  // fill most of the screen first: the page shows the device screen as the device
  // filled it, bottom-up when the window is shorter than the console
  h.consoles[0]!.emit('\r\n'.repeat(19));
  h.consoles[0]!.emit('banner line\r\n');
  h.consoles[0]!.emit('\x1b[31mRED\x1b[0m 中 ready\r\nsw1# ');
  await new Promise((done) => setTimeout(done, 120));
  const session = h.manager.session('c1', 't1')!;
  const state = screen();
  state.terminals = h.manager.views('c1');
  state.terminalDetail = session;
  for (const [, p] of PALETTES) {
    setPalette(p);
    const rows = renderScreen({ ...state, terminalAttached: false }, 80, 24);
    assert.equal(rows.length, 24);
    for (const row of rows) assert.equal(stringWidth(stripAnsi(row)), 80);
    const plain = rows.map(stripAnsi);
    // band: lamp and name, then the transport and address; no esc hint while browsing
    assert.match(plain[2]!, /^ ● t1 sw1\.lan:22 /);
    assert.match(plain[3]!, /^   ssh sw1\.lan:22 +$/);
    assert.equal(
      plain.slice(0, 5).join('\n').includes('esc'),
      false,
      'a browsing page shows no way-out hint',
    );
    const body = plain.slice(4).join('\n');
    assert.match(body, /RED 中 ready/);
    assert.match(body, /sw1#/);
    // the device's own colours stay, but only as the ANSI map's codes
    terminalColours(p, rows.join('\n'));
    // attached: the way out says so, and the cursor cell is lit
    const attached = renderScreen({ ...state, terminalAttached: true }, 80, 24);
    assert.match(attached[3]!, /typing goes to the device · ctrl\+\] detaches/);
    const cursorRow = attached.find((row) => stripAnsi(row).includes('sw1#'))!;
    assert.ok(
      [...cursorRow.matchAll(/\x1b\[([\d;]*)m/g)].some((match) =>
        match[1]!.split(';').includes('7'),
      ),
      'the attached cursor cell is not lit',
    );
    terminalColours(p, attached.join('\n'));
    // a page narrower than the device: rows still fill the width exactly
    const narrow = renderScreen({ ...state, terminalAttached: false }, 40, 24);
    for (const row of narrow.slice(4))
      assert.equal(stringWidth(stripAnsi(row)), 40);
  }
  setPalette(PALETTES[0]![1]);
});

test('the strip names live terminals in its header and keeps them off it once gone', async (t) => {
  const h = harness();
  t.after(() => h.manager.close());
  await h.open();
  const state = screen();
  state.terminals = h.manager.views('c1');
  const rows = renderScreen(state, 100, 30).map(stripAnsi);
  const header = rows.find((row) => row.includes('Terminals'));
  assert.ok(header, 'no Terminals in the strip header');
  assert.match(header!, /Terminals · 1/);
  // a cut console leaves the strip: state alone is not enough to hold a row
  await h.manager.request(
    'c1',
    'disconnect',
    { session: 't1' },
    AbortSignal.timeout(5000),
  );
  const gone = screen();
  gone.terminals = h.manager.views('c1');
  const after = renderScreen(gone, 100, 30).map(stripAnsi);
  assert.equal(
    after.some((row) => row.includes('Terminals')),
    false,
  );
});

test('attached typing reaches the device, ctrl+c belongs to the console, and cards outrank it', async (t) => {
  const model = new ScriptedModel([
    { message: { id: 'x', role: 'assistant', content: 'ok' } },
  ]);
  const { app, ui } = await attached(t, model);
  const fake = harness();
  t.after(() => fake.manager.close());
  const conversation = app.runtime!.session.id;
  // the app's own manager, with its real connectors, stands down for the fake
  ui.terminals.set(app.runtime, fake.manager);
  await fake.open(conversation);
  ui.openTerminalPage('t1');
  assert.equal(app.state.terminalDetail?.id, 't1');
  assert.equal(app.state.terminalAttached, false);
  ui.attachTerminal(true);
  assert.equal(app.state.terminalAttached, true);
  ui.handle({ type: 'key', key: 'x', char: 'x' });
  ui.handle({ type: 'key', key: 'enter', char: '\r' });
  ui.handle({ type: 'key', key: 'ctrl+c', char: '\x03' });
  assert.equal(fake.consoles[0]!.typed.join(''), 'x\r\x03');
  assert.equal(app.state.draft, '', 'attached keys never reach the box');
  ui.handle({ type: 'paste', text: 'show clock' });
  assert.equal(fake.consoles[0]!.typed.at(-1), 'show clock');
  // a size change reaches the device (the SSH test proves it for the real wire)
  ui.terminalManager.resize(conversation, 't1', 100, 40);
  assert.deepEqual(fake.consoles[0]!.sizes.at(-1), [100, 40]);
  // any card that is not a handoff takes the frame: attach and page both let go
  const waiting = ui.dialog({
    title: 'q',
    body: 'b',
    options: ['ok'],
    focus: 0,
  });
  assert.equal(app.state.terminalAttached, false);
  assert.equal(app.state.terminalDetail, undefined);
  ui.pending?.complete('ok');
  await waiting;
  ui.handle({ type: 'key', key: 'y', char: 'y' });
  assert.equal(app.state.draft, 'y', 'after the card the box takes keys again');
  // ctrl+] gives the keys back but keeps the page: only the card's continue gives
  // the console to the model
  const detailId = (): string => app.state.terminalDetail?.id ?? '';
  ui.openTerminalPage('t1');
  ui.attachTerminal(true);
  ui.handle({ type: 'key', key: 'ctrl+]', char: '\x1d' });
  assert.equal(app.state.terminalAttached, false);
  assert.equal(detailId(), 't1');
  // browsing: enter attaches again
  ui.handle({ type: 'key', key: 'enter', char: '\r' });
  assert.equal(app.state.terminalAttached, true);
  ui.handle({ type: 'key', key: 'ctrl+]', char: '\x1d' });
  // and esc on the browsing page leaves it
  ui.handle({ type: 'key', key: 'escape', char: '' });
  assert.equal(app.state.terminalDetail, undefined);
});
