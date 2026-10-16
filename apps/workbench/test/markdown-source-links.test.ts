import test from 'node:test';
import assert from 'node:assert/strict';
import { remarkSourceLinks } from '../src/model/markdown-source-links.ts';
test('real inline plan references become source links while fences commands and existing links stay intact', () => {
  const code = (value: string) => ({ type: 'inlineCode', value });
  const existing = {
    type: 'link',
    url: 'public/a.ts#L3',
    children: [code('public/a.ts')],
  };
  const fence = { type: 'code', value: 'public/a.ts:2–5\n' };
  const tree = {
    type: 'root',
    children: [
      code('public/task-model.mjs:2–5'),
      code('(test/task-model.test.mjs:7)'),
      code('npm test'),
      existing,
      fence,
    ],
  };
  remarkSourceLinks()(tree);
  assert.equal(tree.children[0]!.type, 'link');
  assert.equal(tree.children[1]!.type, 'link');
  assert.equal(tree.children[2]!.type, 'inlineCode');
  assert.equal(tree.children[3], existing);
  assert.equal(existing.children[0]!.type, 'inlineCode');
  assert.equal(tree.children[4], fence);
});
