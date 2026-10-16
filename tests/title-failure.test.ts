import assert from 'node:assert/strict';
import { test } from 'node:test';
import { friendlyTitleFailure } from '../src/session_title.js';

test('a title transport failure is one short reason', () => {
  assert.equal(
    friendlyTitleFailure(
      'TLS failure on open.bigmodel.cn: Connection error.; fetch failed; ERR_SSL_WRONG_VERSION_NUMBER',
    ),
    'could not reach the endpoint',
  );
  assert.equal(friendlyTitleFailure('title exploded'), 'title exploded');
});
