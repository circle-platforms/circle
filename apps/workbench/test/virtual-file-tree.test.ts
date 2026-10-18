import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFileTreeRows, treeWindow } from '../src/model/virtual-file-tree';
test('50k file paths flatten predictably while row windows stay bounded', () => {
  const files = Array.from(
    { length: 50000 },
    (_, n) =>
      `group${String(Math.floor(n / 500)).padStart(3, '0')}/file${String(n % 500).padStart(3, '0')}.ts`,
  );
  assert.equal(buildFileTreeRows(files, new Set()).rows.length, 100);
  const tree = buildFileTreeRows(files, () => true);
  assert.equal(tree.rows.length, 50100);
  assert.equal(tree.matchedCount, 50000);
  const window = treeWindow(tree.rows.length, 1200000, 600);
  assert.ok(window.end - window.start <= 32);
  assert.equal(tree.rows[1].parentPath, 'group000');
  assert.equal(tree.rows[1].setSize, 500);
  assert.equal(tree.rows[500].posInSet, 500);
});
test('filter reveals ancestors without changing expansion and keeps folders first', () => {
  const expanded = new Set(['other']);
  const tree = buildFileTreeRows(
    ['src/feature/deep.ts', 'src/abc.ts', 'root.ts', 'other/note.md'],
    expanded,
    'deep.ts',
  );
  assert.deepEqual(
    tree.rows.map((row) => [row.path, row.expanded]),
    [
      ['src', true],
      ['src/feature', true],
      ['src/feature/deep.ts', false],
    ],
  );
  assert.deepEqual([...expanded], ['other']);
  assert.equal(tree.matchedCount, 1);
  assert.deepEqual(
    buildFileTreeRows(
      ['file10.ts', 'file2.ts', 'src/a.ts'],
      () => true,
    ).rows.map((row) => row.path),
    ['src', 'src/a.ts', 'file2.ts', 'file10.ts'],
  );
});
