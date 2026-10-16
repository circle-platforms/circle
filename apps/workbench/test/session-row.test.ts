import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pointerOnSidebarChrome,
  runControlAction,
  selectRenameText,
  sessionCardVisible,
  shouldOpenSession,
} from '../src/model/session-row.ts';

const row = {
  left: 10,
  top: 20,
  right: 200,
  bottom: 50,
};

test('a session card closes when the page suppresses it', () => {
  const focused = {
    renaming: false,
    editing: false,
    menuOpen: false,
    keyboardOwns: false,
    suppressed: false,
    hovered: false,
    focused: true,
    pointerIdle: true,
  };
  assert.equal(sessionCardVisible(focused), true);
  assert.equal(sessionCardVisible({ ...focused, suppressed: true }), false);
  assert.equal(
    sessionCardVisible({ ...focused, hovered: true, suppressed: true }),
    false,
  );
  assert.equal(
    sessionCardVisible({
      ...focused,
      focused: false,
      hovered: true,
      pointerIdle: false,
    }),
    true,
  );
});

test('a control runs on the press and skips the click that follows it', () => {
  assert.equal(
    runControlAction({ kind: 'press', button: 0, actedOnPress: false }),
    true,
  );
  assert.equal(
    runControlAction({ kind: 'press', button: 2, actedOnPress: false }),
    false,
  );
  assert.equal(
    runControlAction({ kind: 'click', button: 0, actedOnPress: true }),
    false,
  );
  assert.equal(
    runControlAction({ kind: 'click', button: 0, actedOnPress: false }),
    true,
  );
  assert.equal(pointerOnSidebarChrome(null), false);
});

test('a press opens a session only when it lands on that row', () => {
  assert.equal(
    shouldOpenSession({
      button: 0,
      detail: 1,
      clientX: 40,
      clientY: 30,
      targetInside: true,
      rect: row,
    }),
    true,
  );
  // The pointer is on the new-session composer; the event was handed to the row.
  assert.equal(
    shouldOpenSession({
      button: 0,
      detail: 1,
      clientX: 640,
      clientY: 420,
      targetInside: true,
      rect: row,
    }),
    false,
  );
  assert.equal(
    shouldOpenSession({
      button: 0,
      detail: 1,
      clientX: 40,
      clientY: 30,
      targetInside: false,
      rect: row,
    }),
    false,
  );
  // Enter on a focused row has no pointer position.
  assert.equal(
    shouldOpenSession({
      button: 0,
      detail: 0,
      clientX: 0,
      clientY: 0,
      targetInside: true,
      rect: row,
    }),
    true,
  );
});

test('renaming selects the whole title after the field scrolls', () => {
  let start = 3;
  let end = 3;
  let scroll = 12;
  const input = {
    value: 'question one',
    focus() {},
    get scrollLeft() {
      return scroll;
    },
    set scrollLeft(value: number) {
      scroll = value;
      // Chromium drops the selection when the field scrolls.
      start = 0;
      end = 0;
    },
    get selectionStart() {
      return start;
    },
    get selectionEnd() {
      return end;
    },
    setSelectionRange(nextStart: number, nextEnd: number) {
      start = nextStart;
      end = nextEnd;
    },
  };
  selectRenameText(input);
  assert.equal(scroll, 0);
  assert.equal(start, 0);
  assert.equal(end, input.value.length);
});
