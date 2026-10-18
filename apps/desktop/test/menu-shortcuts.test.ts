import assert from 'node:assert/strict';
import test from 'node:test';
import {
  devToolsMenuShortcut,
  selectAllMenuItem,
  selectFocusedEditableScript,
  windowContextMenu,
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

test("the window's right-click menu: a field's editing commands, or Copy over a selection", () => {
  const flags = {
    canCut: false,
    canCopy: false,
    canPaste: true,
    canSelectAll: true,
  };
  assert.deepEqual(
    windowContextMenu({
      isEditable: true,
      selectionText: '',
      editFlags: flags,
    }),
    [
      { command: 'cut', label: 'Cut', enabled: false },
      { command: 'copy', label: 'Copy', enabled: false },
      { command: 'paste', label: 'Paste', enabled: true },
      'separator',
      { command: 'selectAll', label: 'Select All', enabled: true },
    ],
  );
  assert.deepEqual(
    windowContextMenu({
      isEditable: false,
      selectionText: 'some words',
      editFlags: { ...flags, canCopy: true },
    }),
    [{ command: 'copy', label: 'Copy', enabled: true }],
  );
  // Nothing selected and no field: no menu at all.
  assert.deepEqual(
    windowContextMenu({
      isEditable: false,
      selectionText: ' \n',
      editFlags: flags,
    }),
    [],
  );
});
