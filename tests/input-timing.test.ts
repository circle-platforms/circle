import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { InteractionQueue } from '../src/tui/interaction_queue.js';

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  return (target: number) => {
    while (Date.now() < target)
      t.mock.timers.tick(Math.min(50, target - Date.now()));
  };
}

test('a draft card is absent at 999ms and becomes eligible at exactly 1000ms', async (t) => {
  const advance = clock(t);
  const queue = new InteractionQueue(
    () => true,
    () => true,
  );
  t.after(() => queue.close());
  const shown: number[] = [];
  queue.typed();
  const card = queue.run(async () => {
    shown.push(Date.now());
  }, new AbortController().signal);
  advance(999);
  assert.equal(queue.typing, true);
  assert.deepEqual(shown, []);
  advance(1000);
  assert.equal(queue.typing, false);
  assert.deepEqual(shown, [1000]);
  await card;
});

test('a later draft key resets the complete 1000ms pause before a waiting card', async (t) => {
  const advance = clock(t);
  const queue = new InteractionQueue(
    () => true,
    () => true,
  );
  t.after(() => queue.close());
  const shown: number[] = [];
  queue.typed();
  const card = queue.run(async () => {
    shown.push(Date.now());
  }, new AbortController().signal);
  advance(500);
  queue.typed();
  advance(1000);
  assert.equal(queue.typing, true);
  assert.deepEqual(
    shown,
    [],
    'the original key deadline cannot present the card',
  );
  advance(1499);
  assert.equal(queue.typing, true);
  assert.deepEqual(shown, []);
  advance(1500);
  assert.equal(queue.typing, false);
  assert.deepEqual(shown, [1500]);
  await card;
});
