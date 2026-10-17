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

test('failure diagnostics preserve exact overflow bounds without reading text or input values', async () => {
  const { measurePanelControlGeometry } =
    await import('./helpers/native-panel-acceptance.mjs');
  const rect = {
    left: 10,
    right: 210,
    top: 20,
    bottom: 50,
    width: 200,
    height: 30,
  };
  const parent = {
    tagName: 'DIV',
    id: 'inspector',
    className: 'inspector-resource',
    parentElement: null,
    getClientRects: () => [{}],
    clientLeft: 2,
    clientTop: 3,
    clientWidth: 175,
    clientHeight: 80,
    getBoundingClientRect: () => ({
      left: 5,
      right: 190,
      top: 10,
      bottom: 100,
      width: 185,
      height: 90,
    }),
  };
  const node = {
    tagName: 'INPUT',
    id: 'program',
    parentElement: parent,
    getAttribute: (name) => ({ type: 'text', name: 'program' })[name] ?? null,
    getBoundingClientRect: () => rect,
    contains: () => false,
  };
  for (const key of ['textContent', 'innerText', 'value']) {
    Object.defineProperty(node, key, {
      get() {
        throw Error('sensitive content must not be read');
      },
    });
    Object.defineProperty(parent, key, {
      get() {
        throw Error('ancestor text must not be read');
      },
    });
  }
  const keys = ['document', 'getComputedStyle', 'innerWidth', 'innerHeight'];
  const before = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  try {
    let display = 'flex';
    Object.assign(globalThis, {
      document: { activeElement: node, elementFromPoint: () => node },
      getComputedStyle: () => ({
        display,
        position: 'relative',
        overflowX: 'hidden',
        overflowY: 'auto',
        transform: 'none',
        zoom: '1',
      }),
      innerWidth: 760,
      innerHeight: 720,
    });
    const measured = measurePanelControlGeometry(node);
    assert.equal(measured.clipContains, false);
    assert.deepEqual(measured.identity, {
      tag: 'INPUT',
      id: 'program',
      type: 'text',
      name: 'program',
    });
    assert.deepEqual(measured.clippingAncestors[0].clientRect, {
      left: 7,
      right: 182,
      top: 13,
      bottom: 93,
    });
    assert.equal(measured.clippingAncestors[0].borderContainsX, false);
    assert.equal(measured.clippingAncestors[0].borderContainsY, true);
    assert.throws(
      () =>
        assertPanelControlGeometry(
          { ...measured, tabMoved: true, tabVisible: true },
          'real-overflow',
        ),
      /clipped by an ancestor/,
    );
    parent.getBoundingClientRect = () => ({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      width: 0,
      height: 0,
    });
    assert.equal(
      measurePanelControlGeometry(node).clippingAncestors[0].rect.width,
      0,
      'zero geometry remains visible evidence rather than silently waived',
    );
    display = 'contents';
    parent.getClientRects = () => [];
    const noBox = measurePanelControlGeometry(node);
    assert.equal(noBox.clipContains, true);
    assert.equal(noBox.clippingAncestors[0].clientRectCount, 0);
    assert.match(
      noBox.clippingAncestors[0].ignoredReason,
      /no CSS clipping box/,
    );
    display = 'block';
    const actualZeroBox = measurePanelControlGeometry(node);
    assert.equal(
      actualZeroBox.clipContains,
      false,
      'real zero-height overflow boxes still clip',
    );
    assert.equal(actualZeroBox.clippingAncestors[0].ignoredReason, null);
    display = 'contents';
    parent.getClientRects = () => [{}];
    assert.equal(
      measurePanelControlGeometry(node).clipContains,
      false,
      'contents with a layout box is not automatically waived',
    );
  } finally {
    for (const [key, descriptor] of before) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
