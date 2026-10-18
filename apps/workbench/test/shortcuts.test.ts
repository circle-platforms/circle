import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chordFromEvent,
  effectiveBindings,
  formatChord,
  isDesktopNewSession,
  isDesktopSearch,
  isDesktopSettings,
  matchingAction,
  normalizeChord,
  validateKeybindings,
} from '../src/model/shortcuts.ts';

type Mods = { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };
const press = (key: string, mods: Mods = {}) => ({
  key,
  ctrlKey: Boolean(mods.ctrl),
  altKey: Boolean(mods.alt),
  shiftKey: Boolean(mods.shift),
  metaKey: Boolean(mods.meta),
});
const action = (key: string, mods: Mods, mac: boolean) =>
  matchingAction(press(key, mods), effectiveBindings(), mac);

test('on macOS the system editing keys with ⌘ are no Circle action', () => {
  for (const [key, mods] of [
    ['c', { meta: true }],
    ['v', { meta: true }],
    ['x', { meta: true }],
    ['a', { meta: true }],
    ['z', { meta: true }],
    ['z', { meta: true, shift: true }],
    ['ArrowLeft', { meta: true }],
    ['ArrowRight', { meta: true }],
    ['ArrowUp', { meta: true }],
    ['ArrowLeft', { alt: true }],
    ['ArrowRight', { alt: true }],
    ['Backspace', { meta: true }],
    ['Backspace', { alt: true }],
    // ⌘ chords the terminal's Control keys used to take through folding
    ['d', { meta: true }],
    ['t', { meta: true }],
    ['r', { meta: true }],
    ['o', { meta: true }],
    ['g', { meta: true }],
    ['q', { meta: true }],
    ['j', { meta: true }],
  ] as [string, Mods][])
    assert.equal(action(key, mods, true), undefined, `${key} ${mods}`);
});

test('on macOS the terminal keys are the Control key and the window keys are ⌘', () => {
  assert.equal(action('c', { ctrl: true }, true), 'clear');
  assert.equal(action('d', { ctrl: true }, true), 'exit');
  assert.equal(action('z', { ctrl: true }, true), 'suspend');
  assert.equal(action('t', { ctrl: true }, true), 'thinking.toggle');
  assert.equal(action('o', { ctrl: true }, true), 'tools.expand');
  assert.equal(action('r', { ctrl: true }, true), 'history.search');
  assert.equal(action('q', { ctrl: true }, true), 'message.followup');
  assert.equal(action('s', { ctrl: true, alt: true }, true), 'secret.enter');
  assert.equal(action('Escape', {}, true), 'interrupt');
  assert.equal(action('Tab', { shift: true }, true), 'mode.cycle');
  // The window's own commands take ⌘, and their Control chords stay the field's
  // (⌃B, ⌃F move the cursor in a macOS text field).
  assert.equal(action('b', { meta: true }, true), 'sidebar.toggle');
  assert.equal(action('f', { meta: true }, true), 'find');
  assert.equal(action('m', { meta: true, shift: true }, true), 'model.select');
  assert.equal(action('b', { ctrl: true }, true), undefined);
  assert.equal(action('f', { ctrl: true }, true), undefined);
  assert.equal(isDesktopSearch(press('k', { meta: true }), true), true);
  assert.equal(isDesktopSearch(press('k', { ctrl: true }), true), false);
  assert.equal(isDesktopSettings(press(',', { meta: true }), true), true);
  assert.equal(isDesktopSettings(press(',', { ctrl: true }), true), false);
  assert.equal(isDesktopNewSession(press('n', { meta: true }), true), true);
  assert.equal(isDesktopNewSession(press('n', { ctrl: true }), true), false);
  assert.equal(
    chordFromEvent(press('c', { meta: true, ctrl: true }), true),
    'ctrl+meta+c',
  );
});

test('on Windows and Linux Ctrl stays the one modifier for both tables', () => {
  assert.equal(action('c', { ctrl: true }, false), 'clear');
  assert.equal(action('b', { ctrl: true }, false), 'sidebar.toggle');
  assert.equal(action('f', { ctrl: true }, false), 'find');
  assert.equal(action('m', { ctrl: true, shift: true }, false), 'model.select');
  assert.equal(action('t', { ctrl: true }, false), 'thinking.toggle');
  assert.equal(isDesktopSearch(press('k', { ctrl: true }), false), true);
  assert.equal(chordFromEvent(press('k', { meta: true }), false), 'ctrl+k');
});

test('a saved key is the same chord in any modifier order, and mod follows the system', () => {
  assert.equal(normalizeChord('shift+ctrl+m', true), 'ctrl+shift+m');
  assert.equal(normalizeChord('mod+shift+m', true), 'shift+meta+m');
  assert.equal(normalizeChord('mod+shift+m', false), 'ctrl+shift+m');
  assert.equal(normalizeChord('meta+k', false), 'ctrl+k');
  assert.equal(normalizeChord('F2', true), 'F2');
  assert.equal(normalizeChord('ctrl++', true), 'ctrl++');
  const custom = validateKeybindings({ find: 'mod+g', clear: 'meta+k' });
  assert.equal(
    matchingAction(press('g', { meta: true }), custom, true),
    'find',
  );
  assert.equal(
    matchingAction(press('g', { ctrl: true }), custom, false),
    'find',
  );
  assert.equal(
    matchingAction(press('k', { meta: true }), custom, true),
    'clear',
  );
  assert.equal(
    matchingAction(press('k', { ctrl: true }), custom, true),
    undefined,
  );
  assert.equal(
    matchingAction(
      press('m', { shift: true, ctrl: true }),
      { 'model.select': 'shift+ctrl+m' },
      true,
    ),
    'model.select',
  );
});

test('keys are written ⌃ for Control and ⌘ for the command key on macOS', () => {
  assert.equal(formatChord('ctrl+c', true), '⌃+C');
  assert.equal(formatChord('mod+k', true), '⌘+K');
  assert.equal(formatChord('meta+k', true), '⌘+K');
  assert.equal(formatChord('alt+mod+i', true), '⌥+⌘+I');
  assert.equal(formatChord('mod+shift+m', true), '⇧+⌘+M');
  assert.equal(formatChord('mod+k', false), 'Ctrl+K');
  assert.equal(formatChord('ctrl+c', false), 'Ctrl+C');
  assert.equal(formatChord('F2', true), 'F2');
});
