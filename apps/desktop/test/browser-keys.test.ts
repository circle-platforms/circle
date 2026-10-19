import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PanelKeys, windowShortcut } from '../src/browser-keys.ts';

// The windows of the application, and which of them shows each conversation's pages: the
// main window, and a window the browser of `a` was popped out into.
function fixture() {
  const main = { name: 'main' };
  const popout = { name: 'browser · a' };
  const terminal = { name: 'terminal · a' };
  const hosts = new Map<string, object>([
    ['a', main],
    ['b', main],
  ]);
  const keys = new PanelKeys<object>((id) => hosts.get(id));
  return { main, popout, terminal, hosts, keys };
}
const key = (
  key: string,
  modifiers: Partial<Record<string, boolean>> = {},
) => ({
  type: 'keyDown',
  key,
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...modifiers,
});

test('a browser shortcut is the panel’s only in the window whose panel has the keyboard', () => {
  const { main, popout, terminal, keys } = fixture();
  assert.equal(keys.holder(main), undefined, 'nothing until a panel says so');
  assert.equal(keys.report(main, 'a', true), true);
  assert.equal(keys.holder(main), 'a');
  // Keys typed in any other window are that window's.
  assert.equal(keys.holder(popout), undefined);
  assert.equal(keys.holder(terminal), undefined);
  // The panel lets go when focus leaves it.
  keys.report(main, 'a', false);
  assert.equal(keys.holder(main), undefined);
});

test('once the pages are in a window of their own, keys typed in the main window are its own', () => {
  const { main, popout, hosts, keys } = fixture();
  keys.report(main, 'a', true);
  // The browser pops out: the main window's panel had the keyboard and never says it let
  // go (its report is for pages it no longer shows).
  hosts.set('a', popout);
  assert.equal(keys.holder(main), undefined, '⌘W in the message box');
  keys.forgetConversation('a');
  // The window that shows the pages takes them when its panel has the keyboard.
  assert.equal(keys.report(popout, 'a', true), true);
  assert.equal(keys.holder(popout), 'a');
  assert.equal(keys.holder(main), undefined);
  // The main window's drawer cannot take keys for pages it does not show,
  assert.equal(keys.report(main, 'a', true), false);
  assert.equal(keys.holder(main), undefined);
  // but its letting go is always heard, and costs the other window nothing.
  keys.report(main, 'a', false);
  assert.equal(keys.holder(popout), 'a');
});

test('a window that closes or loads again, or a conversation that goes, holds no keys', () => {
  const { main, popout, hosts, keys } = fixture();
  hosts.set('a', popout);
  keys.report(popout, 'a', true);
  // The window is put back in the drawer: its pages return to the main window, whose
  // panel has not taken the keyboard.
  hosts.set('a', main);
  keys.forgetConversation('a');
  keys.forgetWindow(popout);
  assert.equal(keys.holder(main), undefined);
  assert.equal(keys.holder(popout), undefined);
  // The main window's page loads again while its panel had the keyboard.
  keys.report(main, 'b', true);
  keys.forgetWindow(main);
  assert.equal(keys.holder(main), undefined);
  // A conversation that is gone has no window: its panel's report takes nothing.
  hosts.delete('b');
  assert.equal(keys.report(main, 'b', true), false);
  assert.equal(keys.holder(main), undefined);
});

test('after a conversation switch the panel of the conversation left takes no keys', () => {
  const { main, keys } = fixture();
  keys.report(main, 'a', true);
  // The drawer shows b now: a's panel said it let go, b's has not taken the keyboard.
  keys.report(main, 'a', false);
  assert.equal(keys.holder(main), undefined);
  // A late report for the conversation left does not let go of the one shown.
  keys.report(main, 'b', true);
  keys.report(main, 'a', false);
  assert.equal(keys.holder(main), 'b');
  // The pages of a are deleted with their conversation.
  keys.report(main, 'a', true);
  keys.forgetConversation('a');
  assert.equal(keys.holder(main), undefined);
});

test('only key presses that are browser shortcuts are taken, and Escape stays the field’s', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const command = platform === 'darwin' ? { meta: true } : { control: true };
    for (const [letter, action] of [
      ['w', 'close-tab'],
      ['r', 'reload'],
      ['l', 'address'],
      ['t', 'new-tab'],
      ['f', 'find'],
    ] as const)
      assert.equal(windowShortcut(key(letter, command), platform), action);
    assert.equal(windowShortcut(key('F5'), platform), 'reload');
    assert.equal(windowShortcut(key('F12'), platform), 'devtools');
    assert.equal(windowShortcut(key('Escape'), platform), undefined);
    assert.equal(windowShortcut(key('a'), platform), undefined);
    assert.equal(
      windowShortcut({ ...key('w', command), type: 'keyUp' }, platform),
      undefined,
    );
  }
});
