import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampDrawer,
  clusterWidth,
  drawerKey,
  drawerRoom,
  MIN_CONVERSATION,
  MIN_DRAWER,
  openingWidth,
  OVERVIEW_WIDTH,
  overviewFits,
  RESTORE_MARGIN,
  SIDEBAR_WIDTH,
  sidebarMustFold,
} from '../src/app/workspace-layout.ts';

test('navigation is 232 and every drawer opens at 380 with a 300 minimum', () => {
  assert.equal(SIDEBAR_WIDTH, 232);
  assert.equal(OVERVIEW_WIDTH, 380);
  assert.equal(MIN_DRAWER, 300);
  for (const mode of ['files', 'agents', 'changes', 'terminal', 'browser'])
    assert.equal(openingWidth(mode), 380);
});
test('opening a document can still widen it and preserves separate remembered widths', () => {
  assert.equal(drawerKey('files', false), 'files');
  assert.equal(drawerKey('files', true), 'files:open');
  assert.equal(drawerKey('agents', true), 'agents:open');
  assert.equal(drawerKey('terminal', true), 'terminal');
  assert.equal(openingWidth('files:open'), 760);
  assert.equal(openingWidth('agents:open'), 760);
});
test('overview and a mode share the third pane even on a wide screen', () => {
  assert.equal(
    overviewFits({ group: 2560, drawer: 380, showing: true }),
    false,
  );
  assert.equal(
    overviewFits({
      group: MIN_CONVERSATION + OVERVIEW_WIDTH,
      drawer: null,
      showing: true,
    }),
    true,
  );
  assert.equal(
    overviewFits({
      group: MIN_CONVERSATION + OVERVIEW_WIDTH - 1,
      drawer: null,
      showing: true,
    }),
    false,
  );
  assert.equal(clusterWidth({ overviewShown: true, drawer: 760 }), 760);
});
test('the overview retains its restore margin rather than flickering at the boundary', () => {
  const need = MIN_CONVERSATION + OVERVIEW_WIDTH;
  assert.equal(
    overviewFits({ group: need, drawer: null, showing: false }),
    false,
  );
  assert.equal(
    overviewFits({
      group: need + RESTORE_MARGIN,
      drawer: null,
      showing: false,
    }),
    true,
  );
});
test('a dragged drawer keeps the conversation minimum and the 300-pixel lower bound', () => {
  const group = 1680 - SIDEBAR_WIDTH;
  assert.equal(drawerRoom(group, false), group - MIN_CONVERSATION);
  assert.equal(clampDrawer(2000, group, false), group - MIN_CONVERSATION);
  assert.equal(clampDrawer(100, group, false), 300);
  assert.equal(clampDrawer(600, group, false), 600);
  assert.equal(clampDrawer(600, 500, false), 300);
  assert.equal(clusterWidth({ overviewShown: true, drawer: null }), 380);
  assert.equal(clusterWidth({ overviewShown: false, drawer: 380 }), 380);
});
test('a document folds the sidebar only when folding actually makes enough room', () => {
  assert.equal(
    sidebarMustFold({
      group: 1280 - SIDEBAR_WIDTH,
      drawer: 760,
      sidebarShown: true,
    }),
    true,
  );
  assert.equal(
    sidebarMustFold({ group: 1280, drawer: 760, sidebarShown: false }),
    false,
  );
  assert.equal(
    sidebarMustFold({ group: 1500, drawer: 760, sidebarShown: true }),
    false,
  );
  assert.equal(
    sidebarMustFold({
      group: 800 - SIDEBAR_WIDTH,
      drawer: 760,
      sidebarShown: true,
    }),
    false,
  );
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
});
