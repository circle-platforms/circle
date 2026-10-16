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

test('parenthesized plain plan file and line references retain surrounding prose', () => {
  const text =
    '失败 (tests/task-model.test.mjs:7)，下一处 (tests/task-model.test.mjs:8)。';
  const tree: {
    type: string;
    children: {
      type: string;
      value?: string;
      url?: string;
      children?: { type: string; value: string }[];
    }[];
  } = { type: 'root', children: [{ type: 'text', value: text }] };
  remarkSourceLinks()(tree);
  const links = tree.children.filter((node) => node.type === 'link');
  assert.deepEqual(
    links.map((node) => node.url),
    ['tests/task-model.test.mjs:7', 'tests/task-model.test.mjs:8'],
  );
  assert.equal(
    tree.children
      .map(
        (node) =>
          node.value ?? node.children?.map((child) => child.value).join(''),
      )
      .join(''),
    text,
  );
  const external = {
    type: 'root',
    children: [{ type: 'text', value: 'https://example.com/tests/model.ts:7' }],
  };
  remarkSourceLinks()(external);
  assert.equal(external.children[0]!.type, 'text');
});
