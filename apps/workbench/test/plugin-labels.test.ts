import test from 'node:test';
import assert from 'node:assert/strict';
import { shellPageTitle } from '../src/plugins/labels.ts';

test('shellPageTitle ignores Object.prototype keys like constructor', () => {
  assert.equal(shellPageTitle('remote-bot'), 'my bot');
  assert.equal(shellPageTitle('constructor'), 'constructor');
  assert.equal(shellPageTitle('toString'), 'toString');
  assert.equal(shellPageTitle('hasOwnProperty'), 'hasOwnProperty');
  assert.equal(shellPageTitle('unknown-page'), 'unknown-page');
});
