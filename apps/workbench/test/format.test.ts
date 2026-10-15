import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentActivityText } from '../src/model/activity.ts';
import { setLanguage } from '../src/i18n/index.ts';
import { planVisible } from '../../../src/plan_state.ts';
import {
  contextPercent,
  formatBusyElapsed,
  formatTokens,
  formatWindow,
  nextBusySeconds,
} from '../src/model/format.ts';
import { focusMarkedField } from '../src/model/dialog-focus.ts';
import {
  DESKTOP_SEARCH_CHORD,
  DESKTOP_SETTINGS_CHORD,
  formatChord,
  isDesktopSearch,
  isDesktopSettings,
} from '../src/model/shortcuts.ts';
import {
  browserApprovalInput,
  browserEventAddress,
  browserOpened,
  browserTabChanged,
  dialogSource,
  hasToolInput,
  isSessionBrowser,
  shownDialog,
} from '../src/model/browser.ts';

test('completed plans hide in either renderer, except while their plan-exit decision waits', () => {
  assert.equal(planVisible([{ status: 'completed' }]), false);
  assert.equal(planVisible([{ status: 'completed' }], true), true);
  assert.equal(planVisible([{ status: 'pending' }]), true);
});

test('agent activity localizes interface state, keeps real tool text and gives waiting priority', (t) => {
  t.after(() => setLanguage('en'));
  const agent = {
    status: 'running' as const,
    activity: 'Read(notes.txt)',
    description: 'old task description',
  };
  assert.equal(agentActivityText(agent), 'Read(notes.txt)');
  assert.equal(
    agentActivityText({ ...agent, status: 'waiting' }),
    'waiting for you',
  );
  setLanguage('zh-CN');
  assert.equal(agentActivityText(agent), 'Read(notes.txt)');
  assert.equal(
    agentActivityText({ ...agent, status: 'waiting' }),
    '等待你处理',
  );
  assert.equal(agentActivityText({ ...agent, activity: 'working' }), '工作中');
});

// tests/desktop-format.test.ts in the root suite holds these equal to the terminal's.
test('the footer and busy word write numbers as the terminal does', () => {
  assert.deepEqual([0, 840, 1000, 12_345, 7_824_000].map(formatTokens), [
    '0',
    '840',
    '1.0k',
    '12.3k',
    '7.8M',
  ]);
  assert.equal(formatWindow(1_000_000), '1.0M');
  assert.equal(formatWindow(128_000), '128.0k');
  assert.deepEqual([12.44, 185, 3725].map(formatBusyElapsed), [
    '12.4s',
    '3m 5s',
    '1h 2m',
  ]);
  assert.equal(contextPercent(12_500, 1_000_000), 1.25);
  assert.equal(contextPercent(null, 1_000_000), null);
  assert.equal(contextPercent(10, null), null);
  assert.equal(contextPercent(5_000_000, 1000), 999);
  assert.equal(nextBusySeconds(undefined, 8.1), 8.1);
  assert.equal(nextBusySeconds(8.1, 7.8), 8.1);
  assert.equal(nextBusySeconds(8.1, 8.4), 8.4);
  assert.equal(nextBusySeconds(8.1, Number.NaN), 8.1);
  assert.equal(formatChord('alt+up'), 'Alt+Up');
  assert.equal(formatChord('ctrl+shift+p'), 'Ctrl+Shift+P');
  assert.equal(DESKTOP_SEARCH_CHORD, 'ctrl+k');
  assert.equal(formatChord(DESKTOP_SEARCH_CHORD), 'Ctrl+K');
  const key = (
    name: string,
    mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
  ) =>
    isDesktopSearch({
      key: name,
      ctrlKey: Boolean(mods.ctrl),
      altKey: false,
      shiftKey: Boolean(mods.shift),
      metaKey: Boolean(mods.meta),
    });
  assert.equal(key('k', { ctrl: true }), true);
  assert.equal(key('k', { meta: true }), true);
  assert.equal(key('p', { ctrl: true, shift: true }), false);
  assert.equal(DESKTOP_SETTINGS_CHORD, 'ctrl+,');
  assert.equal(formatChord(DESKTOP_SETTINGS_CHORD), 'Ctrl+,');
  const comma = (
    name: string,
    mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
  ) =>
    isDesktopSettings({
      key: name,
      ctrlKey: Boolean(mods.ctrl),
      altKey: false,
      shiftKey: Boolean(mods.shift),
      metaKey: Boolean(mods.meta),
    });
  assert.equal(comma(',', { ctrl: true }), true);
  assert.equal(comma(',', { meta: true }), true);
  assert.equal(comma(',', { ctrl: true, shift: true }), false);
  assert.equal(comma(','), false);
});

test('search opens with focus in the field, not on the close button', () => {
  let prevented = false;
  let focused = false;
  const marked = {
    querySelector: (selector: string) => {
      assert.equal(selector, '[data-initial-focus]');
      return {
        focus() {
          focused = true;
        },
      };
    },
  };
  assert.equal(
    focusMarkedField(marked, {
      preventDefault() {
        prevented = true;
      },
    }),
    true,
  );
  assert.equal(prevented, true);
  assert.equal(focused, true);
  prevented = false;
  assert.equal(
    focusMarkedField(
      { querySelector: () => null },
      {
        preventDefault() {
          prevented = true;
        },
      },
    ),
    false,
  );
  assert.equal(prevented, false);
  const app = readFileSync(
    fileURLToPath(new URL('../src/app/App.tsx', import.meta.url)),
    'utf8',
  );
  const search = app.slice(
    app.indexOf('open={searchOpen}'),
    app.indexOf('<DialogHost'),
  );
  assert.match(search, /<SearchInput\s+autoFocus/);
  const field = readFileSync(
    fileURLToPath(new URL('../src/components/common.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(field, /data-initial-focus=\{focus \? '' : undefined\}/);
  const modal = readFileSync(
    fileURLToPath(new URL('../src/components/ui.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(modal, /focusMarkedField\(event\.currentTarget, event\)/);
});

test('settings opens from the window, including a focused sidebar or composer', () => {
  const app = readFileSync(
    fileURLToPath(new URL('../src/app/App.tsx', import.meta.url)),
    'utf8',
  );
  const start = app.indexOf("addEventListener('keydown', handle, true)");
  assert.ok(start > 0);
  const effect = app.slice(app.lastIndexOf('useEffect', start), start);
  assert.match(effect, /isDesktopSettings\(event\)/);
  assert.match(effect, /navigate\('\/page\/settings'\)/);
  assert.doesNotMatch(effect, /tagName|INPUT|TEXTAREA|closest\(/);
  const sidebar = readFileSync(
    fileURLToPath(new URL('../src/components/Sidebar.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(sidebar, /session-menu-gap/);
  assert.match(sidebar, /event\.stopPropagation\(\)/);
  const menu = readFileSync(
    fileURLToPath(new URL('../../desktop/src/main.ts', import.meta.url)),
    'utf8',
  );
  const fileStart = menu.indexOf("label: text('file')");
  const editStart = menu.indexOf("label: text('edit')");
  const file = menu.slice(fileStart, editStart);
  assert.match(file, /process\.platform === 'darwin'[\s\S]*\? \[\]/);
  assert.match(file, /settingsItem\(\)/);
  const shortcuts = readFileSync(
    fileURLToPath(new URL('../src/features/Dialogs.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(shortcuts, /formatChord\(DESKTOP_SETTINGS_CHORD\)/);
});

test('a dialog shows over the tab that waits on it and names where it came from', () => {
  const dialog = (id: string, tab: string, origin: string) => ({
    id,
    tab,
    type: 'confirm' as const,
    message: 'Delete?',
    defaultPrompt: '',
    origin,
  });
  const state = {
    sessionId: 'browser:conversation1',
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    tab: 't2',
    dialogs: [
      dialog('d1', 't1', 'https://other.test'),
      dialog('d2', 't2', 'https://172.16.6.215:8888'),
    ],
  };
  assert.equal(shownDialog(state)?.id, 'd2');
  assert.equal(shownDialog({ ...state, tab: 't3' }), undefined);
  // A tab waiting on a dialog counts as opened even before its address is known
  assert.equal(browserOpened(state), true);
  assert.equal(dialogSource(state.dialogs[1]!), '172.16.6.215:8888');
  assert.equal(dialogSource(dialog('d3', 't1', '')), '');
  assert.equal(
    browserOpened({
      ...state,
      dialogs: [],
      warning: { host: 'nas.lan', error: 'net::ERR_CERT_AUTHORITY_INVALID' },
    }),
    true,
  );
});

test('browser events stay with their conversation', () => {
  const state = {
    sessionId: 'browser:conversation1',
    url: 'https://localhost/',
    title: 'local test',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    operating: true,
  };
  assert.equal(isSessionBrowser(state, 'conversation1'), true);
  assert.equal(isSessionBrowser(state, 'conversation2'), false);
  assert.equal(isSessionBrowser(state, 'browser:conversation1'), false);
  assert.equal(browserOpened(state), true);
  assert.equal(browserOpened({ ...state, url: '' }), false);
  assert.equal(browserOpened({ ...state, url: 'about:blank' }), false);
  assert.equal(browserOpened(null), false);
  assert.equal(
    browserOpened({
      ...state,
      url: '',
      failure: { url: 'http://localhost/', error: 'ERR_CONNECTION_REFUSED' },
    }),
    true,
  );
});

test('tool arguments omit empty containers and preserve browser approval values', () => {
  assert.equal(hasToolInput({}), false);
  assert.equal(hasToolInput([]), false);
  assert.equal(hasToolInput(undefined), false);
  assert.equal(hasToolInput({ text: '' }), true);
  assert.deepEqual(
    browserApprovalInput({
      url: 'https://localhost/login',
      ref: 'e3',
      element: 'username',
      text: 'admin\nsecond line',
      submit: false,
    }),
    [
      { key: 'url', value: 'https://localhost/login' },
      { key: 'ref', value: 'e3' },
      { key: 'element', value: 'username' },
      { key: 'text', value: 'admin\nsecond line' },
      { key: 'submit', value: 'false' },
    ],
  );
  assert.deepEqual(browserApprovalInput({}), []);
});

test('late blank browser events preserve the address being entered and back can clear it', () => {
  const state = {
    sessionId: 'browser:conversation1',
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const typedAddress = 'https://localhost/login';
  assert.equal(
    browserEventAddress(state, true, true) ?? typedAddress,
    typedAddress,
  );
  assert.equal(
    browserEventAddress(state, false, false) ?? typedAddress,
    typedAddress,
  );
  assert.equal(
    browserEventAddress({ ...state, url: '' }, false, false) ?? typedAddress,
    typedAddress,
  );
  assert.equal(
    browserEventAddress(
      { ...state, url: 'https://localhost/new' },
      true,
      true,
    ) ?? typedAddress,
    typedAddress,
  );
  assert.equal(
    browserEventAddress({ ...state, url: typedAddress }, false, false),
    typedAddress,
  );
  assert.equal(browserEventAddress(state, false, true), '');
});

test('changing browser tabs replaces a failed draft, including a new empty tab', () => {
  const blank = {
    sessionId: 'browser:conversation1',
    tab: 't2',
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  assert.equal(browserEventAddress(blank, true, false, true), '');
  assert.equal(
    browserEventAddress(
      { ...blank, url: 'https://localhost/other' },
      true,
      true,
      true,
    ),
    'https://localhost/other',
  );
  assert.equal(
    browserEventAddress(
      { ...blank, tab: undefined, url: '' },
      true,
      false,
      true,
    ),
    '',
  );
  assert.equal(
    browserEventAddress(
      { ...blank, url: 'https://localhost/loading' },
      true,
      true,
      false,
    ),
    undefined,
  );
});

test('the first blank browser tab arriving after address input preserves the draft', () => {
  const state = {
    sessionId: 'browser:conversation1',
    tab: 't1',
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const draft = 'http://127.0.0.1:8765/fixture';
  let previous: string | undefined;
  let editing = true;
  let address = draft;
  for (const next of [state, { ...state, loading: true }]) {
    const changed = browserTabChanged(previous, next.tab);
    if (changed) editing = false;
    previous = next.tab;
    address = browserEventAddress(next, editing, false, changed) ?? address;
    assert.equal(address, draft);
    assert.equal(editing, true);
  }
  const nextTab = { ...state, tab: 't2' };
  const changed = browserTabChanged(previous, nextTab.tab);
  assert.equal(changed, true);
  assert.equal(browserEventAddress(nextTab, editing, false, changed), '');
  assert.equal(browserTabChanged('t2', undefined), true);
});
