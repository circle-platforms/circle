import test from 'node:test';
import assert from 'node:assert/strict';
import {
  afterSidebarChromeMove,
  afterSidebarPointerLeave,
  pointerOnSidebarChrome,
  runControlAction,
  selectRenameText,
  sessionCardVisible,
  sessionMenuTipOpen,
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

test('leaving the sidebar hides the session card and keeps a focused menu tip', () => {
  const left = afterSidebarPointerLeave(false);
  assert.equal(left.suppressCard, true);
  assert.equal(left.scrollClosed, false);
  const focused = {
    renaming: false,
    editing: false,
    menuOpen: false,
    keyboardOwns: false,
    suppressed: left.suppressCard,
    hovered: false,
    focused: true,
    pointerIdle: true,
  };
  assert.equal(sessionCardVisible(focused), false);
  assert.equal(
    sessionMenuTipOpen({
      keyboardOwns: true,
      menuFocused: true,
      editing: false,
      menuOpen: false,
      scrollClosed: left.scrollClosed,
      inView: true,
    }),
    true,
  );
  // A scroll still closes the tip. Leaving does not turn into one.
  const scrolled = afterSidebarPointerLeave(true);
  assert.equal(scrolled.scrollClosed, true);
  assert.equal(
    sessionMenuTipOpen({
      keyboardOwns: true,
      menuFocused: true,
      editing: false,
      menuOpen: false,
      scrollClosed: scrolled.scrollClosed,
      inView: true,
    }),
    false,
  );
});

test('moving onto sidebar chrome hides the session card and keeps a focused menu tip', () => {
  const moved = afterSidebarChromeMove(false);
  assert.equal(moved.suppressCard, true);
  assert.equal(moved.scrollClosed, false);
  assert.equal(moved.blurRow, false);
  assert.equal(
    sessionCardVisible({
      renaming: false,
      editing: false,
      menuOpen: false,
      keyboardOwns: false,
      suppressed: moved.suppressCard,
      hovered: false,
      focused: true,
      pointerIdle: true,
    }),
    false,
  );
  assert.equal(
    sessionMenuTipOpen({
      keyboardOwns: true,
      menuFocused: true,
      editing: false,
      menuOpen: false,
      scrollClosed: moved.scrollClosed,
      inView: true,
    }),
    true,
  );
  const scrolled = afterSidebarChromeMove(true);
  assert.equal(scrolled.scrollClosed, true);
  assert.equal(scrolled.blurRow, false);
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
