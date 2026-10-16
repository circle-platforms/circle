import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_ACTIONS,
  KEY_ACTION_TEXT,
  chordFromEvent,
  formatChord,
  isChord,
  isBindableChord,
  matchingAction,
  validateKeybindings,
} from '../src/model/shortcuts.ts';
import { loadLanguage } from '../src/i18n/index.ts';

const press = (
  key: string,
  modifiers: Partial<
    Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>
  > = {},
) => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
});

test('a key press becomes the chord keybindings.json writes, and a modifier alone becomes none', () => {
  assert.equal(chordFromEvent(press('k', { ctrlKey: true })), 'ctrl+k');
  // Shift reaches the app as an uppercase letter: the chord keeps the plain one.
  assert.equal(chordFromEvent(press('K', { shiftKey: true })), 'shift+k');
  assert.equal(chordFromEvent(press('ArrowUp', { altKey: true })), 'alt+up');
  assert.equal(chordFromEvent(press('F2')), 'f2');
  assert.equal(chordFromEvent(press('Escape')), 'escape');
  assert.equal(chordFromEvent(press('Control', {})), null);
  assert.equal(chordFromEvent(press('Shift', { shiftKey: true })), null);
  // A key this app cannot bind is refused rather than saved as something odd.
  assert.equal(chordFromEvent(press('Minus')), null);
  assert.equal(chordFromEvent(press('Dead')), null);
});

test('a recorded chord is the chord the runtime matches, and a bare letter is not bindable', () => {
  for (const chord of ['ctrl+k', 'alt+up', 'shift+tab', 'f3', 'escape']) {
    assert.equal(isBindableChord(chord), true, chord);
    assert.deepEqual(validateKeybindings({ find: chord }), { find: chord });
  }
  for (const chord of ['ctrl+shift+alt+meta+enter', 'up', 'escape'])
    assert.equal(isChord(chord), true, chord);
  assert.equal(isBindableChord('k'), false);
  assert.equal(isBindableChord('ctrl+space'), false);
  assert.equal(isBindableChord(''), false);
});

test('a chord is shown the way it reads on the keyboard', () => {
  assert.equal(formatChord('ctrl+k'), 'Ctrl+K');
  assert.equal(formatChord('ctrl+k', true), '⌃K');
  assert.equal(formatChord('meta+enter', true), '⌘Enter');
  assert.equal(formatChord('shift+tab'), 'Shift+Tab');
  assert.equal(formatChord('alt+up'), 'Alt+↑');
  assert.equal(formatChord('f3'), 'F3');
  assert.equal(formatChord('pageup'), 'PageUp');
});

test('every action has a label, and a bound key still reaches its action', () => {
  loadLanguage(undefined, 'en');
  for (const action of Object.keys(KEY_ACTIONS)) {
    const label = KEY_ACTION_TEXT[action as keyof typeof KEY_ACTION_TEXT];
    assert.equal(typeof label, 'function', action);
    assert.ok(label().trim().length, action);
  }
  assert.deepEqual(
    Object.keys(KEY_ACTION_TEXT).sort(),
    Object.keys(KEY_ACTIONS).sort(),
  );
  assert.equal(
    matchingAction(press('k', { ctrlKey: true }), { 'model.select': 'ctrl+k' }),
    'model.select',
  );
  assert.equal(matchingAction(press('F4'), { find: ['ctrl+f', 'f4'] }), 'find');
});
