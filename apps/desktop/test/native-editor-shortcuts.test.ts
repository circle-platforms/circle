import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise the driver used by native acceptance without launching a desktop.
test('native format driver uses Monaco platform keyboard bindings', async () => {
  const helper = './helpers/native-editor-semantics.mjs';
  const { nativeEditorFormatShortcut } = await import(helper);
  assert.equal(nativeEditorFormatShortcut('linux'), 'Control+Shift+i');
  assert.equal(nativeEditorFormatShortcut('darwin'), 'Alt+Shift+f');
  assert.equal(nativeEditorFormatShortcut('win32'), 'Alt+Shift+f');
  assert.equal(
    nativeEditorFormatShortcut(),
    process.platform === 'linux' ? 'Control+Shift+i' : 'Alt+Shift+f',
  );
});
