import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowedRange } from '../src/components/WindowedList.tsx';

test('ten thousand rows mount only the viewport and overscan window', () => {
  const offsets = Array.from({ length: 10001 }, (_, n) => n * 180);
  const range = windowedRange(offsets, 900000, 800);
  assert.ok(range.start <= 5000);
  assert.ok(range.end >= 5005);
  assert.ok(range.end - range.start < 20);
});
test('empty, start, end and variable heights produce valid exclusive bounds', () => {
  assert.deepEqual(windowedRange([0], 0, 800), { start: 0, end: 0 });
  const offsets = [0, 10, 1000, 1001, 2000];
  assert.deepEqual(windowedRange(offsets, 0, 5, 0), { start: 0, end: 1 });
  assert.deepEqual(windowedRange(offsets, 1000, 1, 0), { start: 2, end: 4 });
  assert.deepEqual(windowedRange(offsets, 2000, 500, 0), { start: 4, end: 4 });
});
