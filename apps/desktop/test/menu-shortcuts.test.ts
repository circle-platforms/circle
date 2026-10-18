import assert from 'node:assert/strict';
import test from 'node:test';
import {
  devToolsMenuShortcut,
  selectAllMenuItem,
  selectFocusedEditableScript,
} from '../src/menu-shortcuts.ts';

test('Linux DevTools menu leaves Monaco document-format binding available', () => {
  assert.deepEqual(devToolsMenuShortcut('linux'), {
    accelerator: 'Control+Alt+Shift+I',
  });
  assert.notEqual(devToolsMenuShortcut('linux').accelerator, 'Control+Shift+I');
  assert.deepEqual(devToolsMenuShortcut('darwin'), {});
  assert.deepEqual(devToolsMenuShortcut('win32'), {});
});

test('Select All does not register the Ctrl or Command chord', () => {
  const item = selectAllMenuItem('Select All');
  assert.equal(item.label, 'Select All');
  assert.equal('accelerator' in item, false);
  assert.match(selectFocusedEditableScript(), /node\.select\(\)/);
  assert.match(selectFocusedEditableScript(), /execCommand\('selectAll'\)/);
});
