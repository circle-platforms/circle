import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampDrawer,
  clusterWidth,
  drawerKey,
  drawerRoom,
  makeRoomForOverview,
  MIN_CONVERSATION,
  MIN_DRAWER,
  openingWidth,
  OVERVIEW_WIDTH,
  overviewFits,
  RESTORE_MARGIN,
  SIDEBAR_WIDTH,
  sidebarMustFold,
} from '../src/app/workspace-layout.ts';

test('files and subagents open as a list and widen when one is opened', () => {
  assert.equal(drawerKey('files', false), 'files');
  assert.equal(drawerKey('files', true), 'files:open');
  assert.equal(drawerKey('agents', true), 'agents:open');
  // The others have no document of their own to open.
  assert.equal(drawerKey('terminal', true), 'terminal');
  assert.equal(drawerKey('browser', true), 'browser');
  assert.deepEqual(
    [
      'files',
      'files:open',
      'agents',
      'agents:open',
      'changes',
      'terminal',
      'browser',
    ].map(openingWidth),
    [300, 760, 300, 760, 536, 536, 536],
  );
});

test('the overview fits while the conversation keeps its room, and steps aside past that', () => {
  const drawer = 536;
  const exact = MIN_CONVERSATION + OVERVIEW_WIDTH + drawer;
  assert.equal(overviewFits({ group: exact, drawer, showing: true }), true);
  assert.equal(
    overviewFits({ group: exact - 1, drawer, showing: true }),
    false,
  );
  // Alone, it needs only the conversation's room.
  assert.equal(
    overviewFits({
      group: MIN_CONVERSATION + OVERVIEW_WIDTH,
      drawer: null,
      showing: true,
    }),
    true,
  );
});

test('an overview that stepped aside needs a margin before it comes back, so it does not flicker', () => {
  const drawer = 536;
  const exact = MIN_CONVERSATION + OVERVIEW_WIDTH + drawer;
  assert.equal(overviewFits({ group: exact, drawer, showing: false }), false);
  assert.equal(
    overviewFits({ group: exact + RESTORE_MARGIN - 1, drawer, showing: false }),
    false,
  );
  assert.equal(
    overviewFits({ group: exact + RESTORE_MARGIN, drawer, showing: false }),
    true,
  );
});

test('on a 1280 window the sidebar decides whether the overview and a mode fit together', () => {
  const withSidebar = 1280 - 252;
  assert.equal(
    overviewFits({ group: withSidebar, drawer: null, showing: true }),
    true,
    'the overview alone fits',
  );
  // Beside a mode there is not room for the conversation too: the mode wins.
  assert.equal(
    overviewFits({ group: withSidebar, drawer: 300, showing: true }),
    false,
  );
  assert.equal(
    overviewFits({ group: withSidebar, drawer: 536, showing: true }),
    false,
  );
  // With the sidebar folded away a list fits beside it, a wide mode still does not.
  assert.equal(overviewFits({ group: 1280, drawer: 300, showing: true }), true);
  assert.equal(
    overviewFits({ group: 1280, drawer: 536, showing: true }),
    false,
  );
  // A 1680 window holds the overview and a terminal.
  assert.equal(
    overviewFits({ group: 1680 - 252, drawer: 560, showing: true }),
    true,
  );
});

test('a dragged drawer never takes the conversation below its room', () => {
  const group = 1680 - 252;
  assert.equal(
    drawerRoom(group, true),
    group - MIN_CONVERSATION - OVERVIEW_WIDTH,
  );
  assert.equal(clampDrawer(2000, group, false), group - MIN_CONVERSATION);
  assert.equal(
    clampDrawer(2000, group, true),
    group - MIN_CONVERSATION - OVERVIEW_WIDTH,
  );
  assert.equal(clampDrawer(100, group, false), MIN_DRAWER);
  assert.equal(clampDrawer(600, group, false), 600);
  // Too small a window to give it any room: it keeps its least width.
  assert.equal(clampDrawer(600, 500, false), MIN_DRAWER);
});

test('asking for the overview shrinks the drawer to make room, or closes it', () => {
  const group = 1500;
  // Room for 380 + 420 + 700.
  assert.deepEqual(makeRoomForOverview({ group, drawer: 900 }), {
    drawer: 700,
  });
  assert.deepEqual(makeRoomForOverview({ group, drawer: 500 }), {
    drawer: 500,
  });
  // Only 380 + 420 + 289 fits: not enough for the least drawer.
  assert.deepEqual(
    makeRoomForOverview({
      group: OVERVIEW_WIDTH + MIN_CONVERSATION + MIN_DRAWER - 1,
      drawer: 536,
    }),
    { drawer: null },
  );
  assert.deepEqual(makeRoomForOverview({ group, drawer: null }), {
    drawer: null,
  });
});

test('the right-hand column is the overview and the drawer, as each is open', () => {
  assert.equal(clusterWidth({ overviewShown: true, drawer: 536 }), 380 + 536);
  assert.equal(clusterWidth({ overviewShown: true, drawer: null }), 380);
  assert.equal(clusterWidth({ overviewShown: false, drawer: 300 }), 300);
  assert.equal(clusterWidth({ overviewShown: false, drawer: null }), 0);
});

test('the sidebar folds for a document drawer only when that gives it the room', () => {
  const group = 1280 - SIDEBAR_WIDTH;
  // 420 + 760 does not fit in 1028, but does in 1280.
  assert.equal(
    sidebarMustFold({ group, drawer: 760, sidebarShown: true }),
    true,
  );
  // Already folded, nothing more to fold.
  assert.equal(
    sidebarMustFold({ group: 1280, drawer: 760, sidebarShown: false }),
    false,
  );
  // It fits as it is: the sidebar stays.
  assert.equal(
    sidebarMustFold({ group: 1500, drawer: 760, sidebarShown: true }),
    false,
  );
  // Folding would not be enough either: the window is too narrow, and the sidebar stays.
  assert.equal(
    sidebarMustFold({
      group: 800 - SIDEBAR_WIDTH,
      drawer: 760,
      sidebarShown: true,
    }),
    false,
  );
  // What folding gives is the sidebar as drawn. A 220-pixel sidebar beside a 950-pixel
  // workspace gives 1170 when folded, short of the 1180 a 760-pixel document needs beside
  // the conversation, so it stays; read as 252 pixels it would fold for nothing.
  assert.equal(
    sidebarMustFold({
      group: 950,
      drawer: 760,
      sidebarShown: true,
      sidebar: 220,
    }),
    false,
  );
  assert.equal(
    sidebarMustFold({
      group: 960,
      drawer: 760,
      sidebarShown: true,
      sidebar: 220,
    }),
    true,
  );
  assert.equal(
    sidebarMustFold({ group: 950, drawer: 760, sidebarShown: true }),
    true,
  );
});
