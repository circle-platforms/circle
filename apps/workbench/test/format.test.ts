import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextPercent,
  formatBusyElapsed,
  formatTokens,
  formatWindow,
} from '../src/model/format.ts';

// tests/desktop-format.test.ts in the root suite holds these equal to the terminal's.
test('the footer and busy word write numbers as the terminal does', () => {
  assert.deepEqual([0, 840, 1000, 12_345, 7_824_000].map(formatTokens), [
    '0',
    '840',
    '1.0k',
    '12.3k',
    '7.8M',
  ]);
  assert.equal(formatWindow(1_000_000), '1.0M');
  assert.equal(formatWindow(128_000), '128.0k');
  assert.deepEqual([12.44, 185, 3725].map(formatBusyElapsed), [
    '12.4s',
    '3m 5s',
    '1h 2m',
  ]);
  assert.equal(contextPercent(12_500, 1_000_000), 1.25);
  assert.equal(contextPercent(null, 1_000_000), null);
  assert.equal(contextPercent(10, null), null);
  assert.equal(contextPercent(5_000_000, 1000), 999);
});
