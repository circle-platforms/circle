import assert from 'node:assert/strict';
import test from 'node:test';
import { diffRowParts } from '../src/components/DiffBlock';

test('a numbered difference keeps the sign and number apart from the text', () => {
  assert.deepEqual(
    diffRowParts([
      { text: '@@ -0,0 +1,12 @@' },
      { text: '+   1  # Title', tone: 'added' },
      { text: '+   2  ', tone: 'added' },
      { text: '-  10   indented', tone: 'removed' },
      { text: '   11  context' },
      { text: '… +40 more lines' },
    ]),
    [
      { text: '@@ -0,0 +1,12 @@' },
      { gutter: '+   1  ', text: '# Title' },
      { gutter: '+   2  ', text: '' },
      { gutter: '-  10  ', text: ' indented' },
      { gutter: '   11  ', text: 'context' },
      { text: '… +40 more lines' },
    ],
  );
});

test('a Git difference has no numbers: the sign alone is the gutter, the text keeps its indent', () => {
  assert.deepEqual(
    diffRowParts([
      { text: '@@ -1,2 +1,2 @@' },
      { text: '-  const pending = session.pending;', tone: 'removed' },
      { text: '+  const pending = [...session.pending];', tone: 'added' },
      { text: ' }' },
    ]),
    [
      { text: '@@ -1,2 +1,2 @@' },
      { gutter: '-', text: '  const pending = session.pending;' },
      { gutter: '+', text: '  const pending = [...session.pending];' },
      { gutter: ' ', text: '}' },
    ],
  );
  // One row without a number makes the whole block a Git one: a line of code that only
  // looks numbered stays its text
  assert.deepEqual(
    diffRowParts([
      { text: '+  12  items', tone: 'added' },
      { text: '+return', tone: 'added' },
    ]).map((part) => part.gutter),
    ['+', '+'],
  );
});
