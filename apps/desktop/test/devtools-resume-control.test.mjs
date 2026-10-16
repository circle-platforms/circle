import test from 'node:test';
import assert from 'node:assert/strict';
import { clickReadyDevToolsResume } from './helpers/devtools-resume-control.mjs';
// Deterministic DOM-surface unit contract; real native frontend verification is separate.
test('DevTools control waits for the visible enabled resume action and never toggles pause', () => {
  let clicks = 0;
  const node = (label, visible, disabled = false) => ({
    shadowRoot: undefined,
    disabled,
    getAttribute: (name) => (name === 'aria-label' ? label : null),
    getBoundingClientRect: () => ({ width: visible ? 20 : 0, height: 20 }),
    click: () => clicks++,
  });
  const hidden = node('Resume script execution (F8)', false);
  const disabled = node('Resume script execution (F8)', true, true);
  const pause = node('Pause script execution (F8)', true);
  const resume = node('Resume script execution (F8)', true);
  const host = node('', true);
  const previousDocument = globalThis.document,
    previousStyle = globalThis.getComputedStyle;
  try {
    globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    globalThis.document = {
      readyState: 'complete',
      querySelectorAll: () => [hidden, disabled, pause, host],
    };
    assert.equal(clickReadyDevToolsResume().clicked, false);
    assert.equal(clicks, 0);
    host.shadowRoot = { querySelectorAll: () => [resume] };
    assert.equal(clickReadyDevToolsResume().clicked, true);
    assert.equal(clicks, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previousStyle;
  }
});
