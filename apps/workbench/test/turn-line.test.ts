import test from 'node:test';
import assert from 'node:assert/strict';
import { showTurnClock } from '../src/model/turn-line.ts';
import type { Message } from '../src/model/types.ts';

function message(
  role: Message['role'],
  text: string,
  at = '2026-10-15T00:00:00.000Z',
): Message {
  return { id: role + text, parentId: null, role, text, at };
}

test('the busy line hides once this turn has an answer', () => {
  const turn = { verb: 'cogitating' };
  const earlier = [
    message('user', 'first'),
    message('assistant', 'done already'),
  ];
  assert.equal(showTurnClock(earlier, 0, undefined), false);
  assert.equal(
    showTurnClock([...earlier, message('user', 'next')], 1, turn),
    false,
  );
  assert.equal(
    showTurnClock([...earlier, message('user', 'next')], 0, turn),
    true,
  );
  assert.equal(
    showTurnClock(
      [
        ...earlier,
        message('user', 'next'),
        message('assistant', '', 'streaming'),
      ],
      0,
      turn,
    ),
    true,
  );
  assert.equal(
    showTurnClock(
      [
        ...earlier,
        message('user', 'next'),
        message('assistant', 'partial', 'streaming'),
      ],
      0,
      turn,
    ),
    false,
  );
  assert.equal(
    showTurnClock(
      [...earlier, message('user', 'next'), message('assistant', 'all of it')],
      0,
      turn,
    ),
    false,
  );
  const running: Message = {
    ...message('tool', ''),
    tool: {
      id: 'call',
      name: 'grep',
      input: {},
      output: '',
      status: 'running',
    },
  };
  assert.equal(
    showTurnClock(
      [
        ...earlier,
        message('user', 'next'),
        message('assistant', 'all of it'),
        running,
      ],
      0,
      turn,
    ),
    true,
  );
});
