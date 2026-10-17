import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserContextMenu,
  browserShortcut,
  nextZoom,
  zoomPercent,
  type BrowserContextParams,
} from '../src/browser-controls.ts';
import { nativeText } from '../src/native-text.ts';

const press = (
  key: string,
  modifiers: Partial<
    Record<'control' | 'meta' | 'alt' | 'shift', boolean>
  > = {},
) => ({
  key,
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...modifiers,
});

test("the browser's shortcuts are Chrome's, with ⌘ on macOS and Ctrl elsewhere", () => {
  const cases: [string, ReturnType<typeof press>, string | undefined][] = [
    ['l', press('l', { meta: true }), 'address'],
    ['t', press('t', { meta: true }), 'new-tab'],
    ['w', press('w', { meta: true }), 'close-tab'],
    ['r', press('r', { meta: true }), 'reload'],
    ['[', press('[', { meta: true }), 'back'],
    [']', press(']', { meta: true }), 'forward'],
    ['f', press('f', { meta: true }), 'find'],
    ['=', press('=', { meta: true }), 'zoom-in'],
    ['+', press('+', { meta: true, shift: true }), 'zoom-in'],
    ['-', press('-', { meta: true }), 'zoom-out'],
    ['0', press('0', { meta: true }), 'zoom-reset'],
    ['F', press('F', { meta: true }), 'find'],
  ];
  for (const [name, input, action] of cases) {
    assert.equal(browserShortcut(input, 'darwin'), action, 'mac ' + name);
    // The same key with Ctrl is not the browser's on macOS
    assert.equal(
      browserShortcut({ ...input, meta: false, control: true }, 'darwin'),
      undefined,
      'mac ctrl ' + name,
    );
    for (const platform of ['win32', 'linux'])
      assert.equal(
        browserShortcut({ ...input, meta: false, control: true }, platform),
        action,
        platform + ' ' + name,
      );
  }
  // Tabs are Ctrl+Tab everywhere, as in Chrome
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(
      browserShortcut(press('Tab', { control: true }), platform),
      'next-tab',
    );
    assert.equal(
      browserShortcut(press('Tab', { control: true, shift: true }), platform),
      'previous-tab',
    );
    assert.equal(browserShortcut(press('Escape'), platform), 'stop');
    assert.equal(browserShortcut(press('F5'), platform), 'reload');
  }
  // Developer tools: F12, ⌥⌘I on macOS (⌥ changes the character, not the key) and
  // Ctrl+Shift+I elsewhere
  for (const platform of ['darwin', 'win32', 'linux'])
    assert.equal(browserShortcut(press('F12'), platform), 'devtools');
  assert.equal(
    browserShortcut(
      { ...press('ˆ', { meta: true, alt: true }), code: 'KeyI' },
      'darwin',
    ),
    'devtools',
  );
  assert.equal(
    browserShortcut(press('I', { control: true, shift: true }), 'win32'),
    'devtools',
  );
  assert.equal(
    browserShortcut(press('I', { control: true, shift: true }), 'darwin'),
    undefined,
  );
  assert.equal(
    browserShortcut(press('i', { meta: true, alt: true }), 'linux'),
    undefined,
  );
  // alt+arrows go back and forward outside macOS, where they move by word
  assert.equal(
    browserShortcut(press('ArrowLeft', { alt: true }), 'win32'),
    'back',
  );
  assert.equal(
    browserShortcut(press('ArrowRight', { alt: true }), 'linux'),
    'forward',
  );
  assert.equal(
    browserShortcut(press('ArrowLeft', { alt: true }), 'darwin'),
    undefined,
  );
  // Keys that are not the browser's stay with the page or the app
  for (const input of [
    press('a', { meta: true }),
    press('c', { meta: true }),
    press('v', { meta: true }),
    press('l'),
    press('r', { meta: true, shift: true }),
    press('Escape', { shift: true }),
    press('t', { meta: true, alt: true }),
    press('k', { meta: true }),
  ])
    assert.equal(browserShortcut(input, 'darwin'), undefined, input.key);
});

test("zoom steps through Chrome's levels and stops at the ends", () => {
  assert.equal(nextZoom(100, 'in'), 110);
  assert.equal(nextZoom(110, 'in'), 125);
  assert.equal(nextZoom(100, 'out'), 90);
  assert.equal(nextZoom(90, 'out'), 80);
  assert.equal(nextZoom(33, 'out'), 25);
  assert.equal(nextZoom(25, 'out'), 25);
  assert.equal(nextZoom(500, 'in'), 500);
  // A level between steps goes to the next step, not past it
  assert.equal(nextZoom(105, 'in'), 110);
  assert.equal(nextZoom(105, 'out'), 100);
  assert.equal(zoomPercent(1.1), 110);
  assert.equal(zoomPercent(0.333), 33);
});

const params = (
  values: Partial<BrowserContextParams> = {},
): BrowserContextParams => ({
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  selectionText: '',
  isEditable: false,
  editFlags: {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: true,
    canSelectAll: true,
  },
  ...values,
});
const page = { canGoBack: true, canGoForward: false, canInspect: true };
const web = (url: string) => /^https?:/.test(url);
const labels = (items: ReturnType<typeof browserContextMenu>) =>
  items.map((item) =>
    item === 'separator'
      ? '-'
      : `${item.label}${item.enabled ? '' : ' (disabled)'}`,
  );

test("a right-click on the page shows Chrome's menu for what is under it", () => {
  assert.deepEqual(labels(browserContextMenu(params(), page, web)), [
    'Back',
    'Forward (disabled)',
    'Reload',
    '-',
    'Inspect',
  ]);
  assert.deepEqual(
    labels(
      browserContextMenu(
        params({ linkURL: 'https://example.test/a' }),
        page,
        web,
      ),
    ),
    ['Open link in new tab', 'Copy link address', '-', 'Inspect'],
  );
  // A link that is not a web page cannot open in a tab; its address still copies
  assert.deepEqual(
    labels(
      browserContextMenu(params({ linkURL: 'mailto:a@b.test' }), page, web),
    ),
    ['Open link in new tab (disabled)', 'Copy link address', '-', 'Inspect'],
  );
  assert.deepEqual(
    labels(
      browserContextMenu(
        params({
          mediaType: 'image',
          srcURL: 'https://example.test/a.png',
          linkURL: 'https://example.test/b',
        }),
        page,
        web,
      ),
    ),
    [
      'Open link in new tab',
      'Copy link address',
      '-',
      'Open image in new tab',
      'Copy image',
      'Copy image address',
      '-',
      'Inspect',
    ],
  );
  assert.deepEqual(
    labels(browserContextMenu(params({ selectionText: 'words' }), page, web)),
    ['Copy', '-', 'Inspect'],
  );
  assert.deepEqual(
    labels(
      browserContextMenu(
        params({
          isEditable: true,
          editFlags: {
            canUndo: true,
            canRedo: false,
            canCut: true,
            canCopy: true,
            canPaste: true,
            canSelectAll: true,
          },
        }),
        { ...page, canInspect: false },
        web,
      ),
    ),
    [
      'Undo',
      'Redo (disabled)',
      '-',
      'Cut',
      'Copy',
      'Paste',
      'Select all',
      '-',
      'Inspect (disabled)',
    ],
  );
});

test('every context menu word has its Chinese, as the window does', () => {
  const zh = nativeText('zh-CN');
  const all = new Set<string>();
  for (const value of [
    params(),
    params({
      linkURL: 'https://a.test',
      mediaType: 'image',
      srcURL: 'https://a.test/i.png',
    }),
    params({ selectionText: 'x' }),
    params({ isEditable: true }),
  ])
    for (const item of browserContextMenu(value, page, web))
      if (item !== 'separator') all.add(item.label);
  for (const label of all)
    assert.notEqual(zh(label), label, label + ' has no Chinese');
});
