import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diffCounts,
  diffViewFromPatch,
  gitChangeRows,
  sessionChangeRows,
} from '../src/model/changes.ts';

test('a diff summary says how many lines were added and removed, in any of the core words', () => {
  assert.deepEqual(diffCounts({ summary: '+3 -1', rows: [] }), {
    added: 3,
    removed: 1,
  });
  assert.deepEqual(diffCounts({ summary: 'new file, 4 lines', rows: [] }), {
    added: 4,
    removed: 0,
  });
  assert.deepEqual(diffCounts({ summary: 'new file, 1 line', rows: [] }), {
    added: 1,
    removed: 0,
  });
  assert.deepEqual(diffCounts({ summary: 'deleted, 2 lines', rows: [] }), {
    added: 0,
    removed: 2,
  });
  // Words it does not know: the rows are counted.
  assert.deepEqual(
    diffCounts({
      summary: 'changed',
      rows: [
        { text: '+a', tone: 'added' },
        { text: '+b', tone: 'added' },
        { text: '-c', tone: 'removed' },
        { text: ' d' },
      ],
    }),
    { added: 2, removed: 1 },
  );
});

test('the session rows are the files it changed, relative to the folder, with their own diffs', () => {
  const diff = {
    summary: '+12 -3',
    rows: [{ text: '+x', tone: 'added' as const }],
  };
  const rows = sessionChangeRows(
    [
      { path: '/w/src/client.ts', kind: 'modified', at: '', diff },
      {
        path: '/w/tests/new.test.ts',
        kind: 'added',
        at: '',
        diff: { summary: 'new file, 38 lines', rows: [] },
      },
      {
        path: '/w/old.ts',
        kind: 'deleted',
        at: '',
        diff: { summary: 'deleted, 41 lines', rows: [] },
      },
    ],
    '/w',
  );
  assert.deepEqual(
    rows.map((item) => [
      item.path,
      item.folder,
      item.letter,
      item.added,
      item.removed,
    ]),
    [
      ['src/client.ts', 'src', 'M', 12, 3],
      ['tests/new.test.ts', 'tests', 'A', 38, 0],
      ['old.ts', '', 'D', 0, 41],
    ],
  );
  assert.equal(rows[0]!.diff, diff);
  assert.deepEqual(sessionChangeRows(undefined), []);
});

test('Git rows take their letter from the status and keep null counts for a binary file, in path order', () => {
  const rows = gitChangeRows([
    { path: 'z.ts', status: 'M', added: 1, removed: 1 },
    { path: 'a/new.ts', status: 'A', added: 5, removed: 0 },
    { path: 'image.bin', status: 'A', added: null, removed: null },
    { path: 'gone.ts', status: 'D', added: 0, removed: 9 },
    { path: 'mode.sh', status: 'T' },
  ]);
  assert.deepEqual(
    rows.map((item) => [item.path, item.letter, item.added, item.removed]),
    [
      ['a/new.ts', 'A', 5, 0],
      ['gone.ts', 'D', 0, 9],
      ['image.bin', 'A', null, null],
      ['mode.sh', 'M', null, null],
      ['z.ts', 'M', 1, 1],
    ],
  );
});

test("a patch becomes rows with Git's header left out and a file's own dashes kept", () => {
  const patch = [
    'diff --git a/a.sql b/a.sql',
    'index 1111111..2222222 100644',
    '--- a/a.sql',
    '+++ b/a.sql',
    '@@ -1,3 +1,3 @@',
    ' select 1;',
    '--- a comment that was removed',
    '+-- a comment that was added',
    '+++ not a header either',
    ' end;',
    'diff --git a/image.png b/image.png',
    'new file mode 100644',
    'Binary files /dev/null and b/image.png differ',
    '',
  ].join('\n');
  const view = diffViewFromPatch(patch);
  assert.deepEqual(
    view.rows.map((item) => [item.text, item.tone ?? '']),
    [
      ['@@ -1,3 +1,3 @@', ''],
      [' select 1;', ''],
      ['--- a comment that was removed', 'removed'],
      ['+-- a comment that was added', 'added'],
      ['+++ not a header either', 'added'],
      [' end;', ''],
      ['Binary files /dev/null and b/image.png differ', ''],
    ],
  );
  assert.equal(view.summary, '+2 -1');
  assert.deepEqual(diffViewFromPatch(''), { summary: '+0 -0', rows: [] });
});
