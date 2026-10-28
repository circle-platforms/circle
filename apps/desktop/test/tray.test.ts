import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  shouldHideOnClose,
  trayEnabled,
  trayHint,
  trayMenuTemplate,
} from '../src/tray.ts';
import { nativeText } from '../src/native-text.ts';

test('closing hides to the tray on Windows and Linux, not on macOS', () => {
  assert.equal(
    shouldHideOnClose('win32', { quitting: false, tray: true }),
    true,
  );
  assert.equal(
    shouldHideOnClose('linux', { quitting: false, tray: true }),
    true,
  );
  assert.equal(
    shouldHideOnClose('darwin', { quitting: false, tray: true }),
    false,
  );
  assert.equal(
    shouldHideOnClose('win32', { quitting: true, tray: true }),
    false,
  );
  assert.equal(
    shouldHideOnClose('win32', { quitting: false, tray: false }),
    false,
  );
});

test('the harness and the environment decide whether there is a tray at all', () => {
  assert.equal(trayEnabled('win32', {}), true);
  assert.equal(trayEnabled('linux', { env: {} }), true);
  assert.equal(trayEnabled('darwin', {}), false);
  assert.equal(trayEnabled('win32', { fixture: true }), false);
  assert.equal(
    trayEnabled('win32', { env: { CIRCLE_DESKTOP_TRAY: 'off' } }),
    false,
  );
  assert.equal(
    trayEnabled('win32', { env: { CIRCLE_DESKTOP_TRAY: '0' } }),
    false,
  );
  assert.equal(
    trayEnabled('win32', { env: { CIRCLE_DESKTOP_TRAY: 'on' } }),
    true,
  );
});

test('the tray menu shows the window and quits, in the language the window shows', () => {
  const calls: string[] = [];
  const zh = trayMenuTemplate(nativeText('zh-CN'), {
    show: () => calls.push('show'),
    quit: () => calls.push('quit'),
  });
  assert.equal(zh.length, 3);
  assert.equal(zh[0]!.label, '打开 Circle');
  assert.equal(zh[1]!.type, 'separator');
  assert.equal(zh[2]!.label, '退出 Circle');
  zh[0]!.click?.();
  zh[2]!.click?.();
  assert.deepEqual(calls, ['show', 'quit']);
  const en = trayMenuTemplate(nativeText('en'), {
    show: () => {},
    quit: () => {},
  });
  assert.equal(en[0]!.label, 'Open Circle');
  assert.equal(en[2]!.label, 'Quit Circle');
});

test('the first hide says where Circle went', () => {
  assert.deepEqual(trayHint(nativeText('en')), {
    title: 'Circle is still running',
    content: 'right-click the tray icon to quit',
  });
  const hint = trayHint(nativeText('zh-CN'));
  assert.equal(hint.title, 'Circle 仍在运行');
  assert.equal(hint.content, '右键点击托盘图标可退出');
});
