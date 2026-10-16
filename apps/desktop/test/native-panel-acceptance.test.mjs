import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPanelControlGeometry } from './helpers/native-panel-acceptance.mjs';
const valid = {
  width: 200,
  height: 30,
  left: 4,
  right: 204,
  top: 10,
  bottom: 40,
  viewportWidth: 760,
  viewportHeight: 720,
  clipContains: true,
  hit: true,
  focused: true,
  tabMoved: true,
  tabVisible: true,
};
test('native panel oracle rejects viewport clipping, scroll clipping, overlays and lost keyboard focus', () => {
  assertPanelControlGeometry(valid, 'valid');
  for (const change of [
    { width: 0 },
    { left: -8 },
    { right: 900 },
    { bottom: 900 },
    { clipContains: false },
    { hit: false },
    { focused: false },
    { tabMoved: false },
    { tabVisible: false },
  ])
    assert.throws(
      () => assertPanelControlGeometry({ ...valid, ...change }, 'negative'),
      /negative:/,
    );
});
