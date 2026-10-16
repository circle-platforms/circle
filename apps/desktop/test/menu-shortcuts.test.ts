import assert from 'node:assert/strict';
import test from 'node:test';
import { devToolsMenuShortcut } from '../src/menu-shortcuts.ts';

test('Linux DevTools menu leaves Monaco document-format binding available', () => {
  assert.deepEqual(devToolsMenuShortcut('linux'), {
    accelerator: 'Control+Alt+Shift+I',
  });
  assert.notEqual(devToolsMenuShortcut('linux').accelerator, 'Control+Shift+I');
  assert.deepEqual(devToolsMenuShortcut('darwin'), {});
  assert.deepEqual(devToolsMenuShortcut('win32'), {});
});
