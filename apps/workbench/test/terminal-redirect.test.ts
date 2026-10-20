import assert from 'node:assert/strict';
import test from 'node:test';
import {
  asksForOwnTerminal,
  commandToTerminalData,
  executeTerminalRedirect,
} from '../src/model/terminal-redirect.ts';

const tab = { id: 'local:shell-1', terminal: 'shell-1', ordinal: 1 };

test('an execute card can move into the open terminal when the person asked for their tab', () => {
  assert.equal(asksForOwnTerminal('在我的终端标签里运行 sleep 115'), true);
  assert.equal(asksForOwnTerminal('run sleep in my terminal tab'), true);
  assert.equal(asksForOwnTerminal('run sleep'), false);
  const moved = executeTerminalRedirect({
    tool: 'execute',
    command: 'sleep 115',
    userText: '在我的终端标签里运行 sleep 115',
    tabs: [{ id: 'local:later', terminal: 'later', ordinal: 2 }, tab],
  });
  assert.deepEqual(moved, {
    ordinal: 1,
    terminal: 'shell-1',
    session: 'local:shell-1',
    command: 'sleep 115',
    rejection:
      'the user moved this command into terminal 1; it was typed there. Do not call execute. Use terminal_wait on local:shell-1 if you still need the result.',
  });
  assert.equal(commandToTerminalData('sleep 115'), 'sleep 115\r');
  assert.equal(commandToTerminalData('echo a\necho b\n'), 'echo a\recho b\r');
});

test('the redirect stays off unless the tool is execute, the message names their tab, and a tab is open', () => {
  const userText = '在我的终端标签里运行 sleep 115';
  assert.equal(
    executeTerminalRedirect({
      tool: 'terminal_send',
      command: 'sleep 115',
      userText,
      tabs: [tab],
    }),
    undefined,
  );
  assert.equal(
    executeTerminalRedirect({
      tool: 'execute',
      command: 'sleep 115',
      userText: 'please run sleep 115',
      tabs: [tab],
    }),
    undefined,
  );
  assert.equal(
    executeTerminalRedirect({
      tool: 'execute',
      command: 'sleep 115',
      userText,
      tabs: [],
    }),
    undefined,
  );
  assert.equal(
    executeTerminalRedirect({
      tool: 'execute',
      command: '   ',
      userText,
      tabs: [tab],
    }),
    undefined,
  );
});
