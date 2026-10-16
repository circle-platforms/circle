import test from 'node:test';
import assert from 'node:assert/strict';
import { highlight } from '../src/components/highlight.ts';

test('fenced code keeps comments, strings, numbers and keywords', () => {
  const tokens = highlight(
    'const n = 2;\n// note\nconst name = "circle";',
    'ts',
  );
  const kinds = (kind: string) =>
    tokens.filter((token) => token.kind === kind).map((token) => token.text);
  assert.deepEqual(kinds('keyword'), ['const', 'const']);
  assert.deepEqual(kinds('number'), ['2']);
  assert.deepEqual(kinds('string'), ['"circle"']);
  assert.deepEqual(kinds('comment'), ['// note']);
  const python = highlight('# hi\nx = 1', 'python');
  assert.equal(python[0]!.kind, 'comment');
  assert.equal(python[0]!.text, '# hi');
  const calls = highlight('print(len(items))\ngreet(name)', 'python');
  assert.ok(
    calls.some((token) => token.kind === 'call' && token.text === 'print'),
  );
  assert.ok(
    calls.some((token) => token.kind === 'call' && token.text === 'len'),
  );
  assert.ok(
    calls.some((token) => token.kind === 'call' && token.text === 'greet'),
  );
});
