import assert from 'node:assert/strict';
import test from 'node:test';
import { setLanguage } from '../src/i18n/index.ts';
import {
  asksForOwnTerminal,
  executeTerminalRedirect,
  redirectRefusal,
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
  // The card names the tab; the main process types the card's own command there.
  assert.deepEqual(moved, { ordinal: 1, session: 'local:shell-1' });
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

test('why nothing was typed is said in the interface language', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  } as Storage;
  setLanguage('zh-CN', storage);
  assert.equal(
    redirectRefusal(
      'there is text at the prompt: clear it and try again; nothing was typed in terminal 2',
      { ordinal: 2 },
    ),
    '终端 2 的提示符后已有文字：请先清空再试',
  );
  assert.equal(
    redirectRefusal(
      'a command is still running there; nothing was typed in terminal 1',
      { ordinal: 1 },
    ),
    '终端 1 里还有命令在运行',
  );
  assert.equal(
    redirectRefusal('stale interaction', { ordinal: 1 }),
    'stale interaction',
  );
  setLanguage('en', storage);
  assert.equal(
    redirectRefusal(
      'the tab is not at its prompt; nothing was typed in terminal 3',
      { ordinal: 3 },
    ),
    'terminal 3 is not at its prompt',
  );
});

test('a tab the person named is called by its name on the card and in why nothing was typed', () => {
  const moved = executeTerminalRedirect({
    tool: 'execute',
    command: 'npm run build',
    userText: 'run the build in my terminal tab',
    tabs: [{ ...tab, name: 'build' }],
  });
  assert.deepEqual(moved, {
    ordinal: 1,
    name: 'build',
    session: 'local:shell-1',
  });
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  } as Storage;
  setLanguage('zh-CN', storage);
  assert.equal(
    redirectRefusal(
      'there is text at the prompt: clear it and try again; nothing was typed in build',
      moved!,
    ),
    '“build”的提示符后已有文字：请先清空再试',
  );
  assert.equal(
    redirectRefusal(
      'Circle is using the tab; nothing was typed in build',
      moved!,
    ),
    'Circle 正在使用“build”',
  );
  setLanguage('en', storage);
  assert.equal(
    redirectRefusal(
      'a command is still running there; nothing was typed in build',
      moved!,
    ),
    'a command is still running in “build”',
  );
  assert.equal(
    redirectRefusal(
      'the tab is not at its prompt; nothing was typed in build',
      moved!,
    ),
    '“build” is not at its prompt',
  );
});
