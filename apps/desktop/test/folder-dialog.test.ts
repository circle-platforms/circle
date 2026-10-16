import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedFolder } from '../src/folder-dialog.ts';

test('a confirmed folder dialog returns the path, and an empty confirm is an error', () => {
  assert.equal(
    selectedFolder({
      canceled: false,
      filePaths: ['/workspace/circle-platforms/circle-packs'],
    }),
    '/workspace/circle-platforms/circle-packs',
  );
  assert.equal(selectedFolder({ canceled: true, filePaths: [] }), null);
  assert.throws(
    () => selectedFolder({ canceled: false, filePaths: ['', '  '] }),
    /folder could not be opened/,
  );
});
