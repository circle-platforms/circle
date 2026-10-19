import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalHeading, terminalTabNumber } from '../src/model/reasons.ts';

const card = (tool: string | undefined, input?: Record<string, unknown>) => ({
  title: `${tool ?? 'a request'} needs your permission`,
  tool,
  input,
});

test('a call for one of your terminal tabs is headed by the tab, any other by its tool', () => {
  const tab = { terminal: 'local:abc', ordinal: 2, session: 'local:abc' };
  assert.equal(approvalHeading(card('terminal_send', tab)), 'terminal 2');
  assert.equal(approvalHeading(card('terminal_press', tab)), 'terminal 2');
  assert.equal(terminalTabNumber(card('terminal_send', tab)), 2);
  // a device console, the browser and a tool with no input keep the tool's name
  assert.equal(
    approvalHeading(card('terminal_send', { session: 't1', host: '10.0.0.1' })),
    'terminal_send',
  );
  assert.equal(approvalHeading(card('browser_click', tab)), 'browser_click');
  assert.equal(approvalHeading(card('execute')), 'execute');
  // a tab call the runtime gave no number is not guessed at
  assert.equal(
    approvalHeading(card('terminal_send', { terminal: 'local:abc' })),
    'terminal_send',
  );
  assert.equal(
    approvalHeading(card(undefined)),
    'a request needs your permission',
  );
});
