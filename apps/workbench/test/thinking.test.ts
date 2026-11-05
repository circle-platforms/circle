import assert from 'node:assert/strict';
import test from 'node:test';
import {
  plainLine,
  thinkingHasBody,
  thinkingHeadline,
} from '../src/model/thinking.ts';

test('a reasoning summary shows its newest heading without markdown marks', () => {
  // As a ChatGPT plan sends it: headings alone.
  const plan = '**Inspecting J8 test logs**\n\n**Checking the sandbox**';
  assert.equal(thinkingHeadline(plan), 'Checking the sandbox');
  assert.equal(thinkingHasBody(plan), false);
  // As the API sends it: a heading and its prose.
  const api =
    '**Inspecting J8 test logs**\n\nThe J8 run timed out while waiting for the port.';
  assert.equal(thinkingHeadline(api), 'Inspecting J8 test logs');
  assert.equal(thinkingHasBody(api), true);
  // Without headings, the first line stands in, its marks taken off.
  assert.equal(
    thinkingHeadline('Look at **providers** first.\nThen patch.'),
    'Look at providers first.',
  );
  assert.equal(plainLine('## **Plan**'), 'Plan');
  assert.equal(thinkingHeadline(undefined), '');
  // A subscription stream can carry empty comments (earendil-works/pi#6434).
  const marked = '<!-- -->**Reading the guard**<!-- -->\n\n<!-- -->';
  assert.equal(thinkingHeadline(marked), 'Reading the guard');
  assert.equal(thinkingHasBody(marked), false);
});
