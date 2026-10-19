import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserRing, currentTurnTools } from '../src/model/browser.ts';

const browser = (status: string, name = 'browser_click') => ({ name, status });

test('the ring stays lit between browser tools and through an approval', () => {
  const tools = [
    browser('success', 'browser_navigate'),
    browser('waiting', 'browser_click'),
  ];
  assert.equal(
    browserRing({ control: 'shared', sessionState: 'waiting', tools }),
    'awaiting',
  );
  assert.equal(
    browserRing({
      control: 'shared',
      operating: false,
      sessionState: 'waiting',
      tools: [browser('success', 'browser_navigate')],
    }),
    'driving',
  );
  assert.equal(
    browserRing({
      control: 'agent',
      operating: true,
      sessionState: 'waiting',
      tools,
    }),
    'driving',
  );
});

test('the ring goes out when the turn ends, the person takes over, or the session stops', () => {
  const tools = [browser('success', 'browser_snapshot')];
  assert.equal(
    browserRing({ control: 'shared', sessionState: 'idle', tools }),
    'idle',
  );
  assert.equal(
    browserRing({ control: 'shared', sessionState: 'paused', tools }),
    'idle',
  );
  assert.equal(
    browserRing({ control: 'user', sessionState: 'waiting', tools }),
    'user',
  );
  assert.equal(
    browserRing({
      control: 'user_pending',
      operating: true,
      sessionState: 'waiting',
      tools,
    }),
    'pending',
  );
  assert.equal(
    browserRing({
      control: 'shared',
      sessionState: 'waiting',
      tools: [{ name: 'read_file', status: 'waiting' }],
    }),
    'idle',
  );
});

test('only the current turn counts toward the ring', () => {
  const tools = currentTurnTools([
    { role: 'user' },
    { role: 'tool', tool: browser('success', 'browser_navigate') },
    { role: 'assistant' },
    { role: 'user' },
    { role: 'tool', tool: { name: 'read_file', status: 'running' } },
  ]);
  assert.deepEqual(tools, [{ name: 'read_file', status: 'running' }]);
  assert.equal(
    browserRing({ control: 'shared', sessionState: 'waiting', tools }),
    'idle',
  );
});

test('a busy session whose turn has not begun does not light the ring with the last turn', () => {
  // The desktop says the session is busy before it saves the new prompt, so the
  // newest tools are still the last turn's.
  const tools = currentTurnTools([
    { role: 'user' },
    { role: 'tool', tool: browser('success', 'browser_handoff') },
    { role: 'assistant' },
  ]);
  assert.equal(
    browserRing({
      control: 'shared',
      sessionState: 'waiting',
      turnStarted: false,
      tools,
    }),
    'idle',
  );
  assert.equal(
    browserRing({
      control: 'shared',
      sessionState: 'waiting',
      turnStarted: true,
      tools,
    }),
    'driving',
  );
  assert.equal(
    browserRing({
      control: 'shared',
      operating: true,
      sessionState: 'waiting',
      turnStarted: false,
      tools,
    }),
    'driving',
  );
});
