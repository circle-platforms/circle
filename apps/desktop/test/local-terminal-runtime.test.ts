// The person's own terminal tabs end to end: a real shell in a real PTY, opened the way the
// window opens one, and the model's terminal tools driven by a scripted model through the
// runtime controller. What is checked is what happened: files the shell wrote, what the
// PTY was given, the cards the conversation shows and what the window is told.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import type { RuntimeCommandName } from '../src/runtime-protocol.ts';
import type { LocalTerminalRow } from '../src/contracts.ts';
import { LocalTerminals } from '../src/local-terminals.ts';
import {
  TerminalManager,
  type ManagedTerminalCommandHandle,
  type TerminalReplay,
  type TerminalSnapshot,
} from '../src/workspace/terminal.ts';
import type { TerminalPort } from '../../../src/terminal/tools.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { emptyUsage, type Message } from '../../../src/types.ts';
import { patience } from './helpers/patience.mjs';

// The real PTY checks run where the other real-shell checks run: not on Windows, whose
// ConPTY shells are covered by the fake terminal service in local-terminals.test.ts
const unix = process.platform !== 'win32';
const PROMPT = 'CIRCLE_TEST> ';

async function until(
  check: () => boolean | Promise<boolean>,
  description: string,
) {
  const end = Date.now() + patience(20000);
  while (!(await check())) {
    if (Date.now() > end) throw Error(`timed out: ${description}`);
    await delay(20);
  }
}

/** What a file holds, or '' while it is not there. */
const written = (path: string) => readFile(path, 'utf8').catch(() => '');

/** A gate a scripted step waits behind, so the test acts between two steps. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const step =
  (name: string, args: () => Record<string, unknown>, wait?: Promise<void>) =>
  async () => {
    await wait;
    return {
      message: {
        id: randomUUID(),
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: randomUUID(), name, args: args() }],
      },
      usage: emptyUsage(),
    };
  };
const done = async () => ({
  message: { id: randomUUID(), role: 'assistant' as const, content: 'done' },
  usage: emptyUsage(),
});

async function setup(
  t: TestContext,
  steps: ConstructorParameters<typeof ScriptedModel>[0],
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'circle-local-terminal-')),
  );
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const shellHome = join(root, 'shell-home');
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(shellHome)]);
  // The shell the window opens inherits this process's environment: keep it off the
  // real home folder, its history and its startup files
  process.env.HOME = shellHome;
  process.env.HISTFILE = '/dev/null';
  process.env.PS1 = PROMPT;
  process.env.ENV = '/dev/null';
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const model = new ScriptedModel(steps);
  const told: { conversation: string; rows: LocalTerminalRow[] }[] = [];
  const devices: TerminalPort = {
    async request(_conversation, action) {
      return action === 'sessions'
        ? { text: '### Terminals\n- none\n### Profiles\n- none' }
        : { text: 'no devices here' };
    },
  };
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    terminal: devices,
    emitTerminalTabs: (conversation, rows) =>
      told.push({ conversation, rows: structuredClone(rows) }),
    emit: () => {},
  });
  const call = async (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
  ) => {
    const reply = await controller.dispatch({
      id: randomUUID(),
      name,
      payload,
      sessionId: controller.snapshot().activeSessionId,
    });
    assert.equal(reply.ok, true, reply.error);
    return reply.data;
  };
  const terminal = <T>(method: string, params: Record<string, unknown> = {}) =>
    call('workspace-service', {
      service: 'terminal',
      method,
      params,
    }) as Promise<T>;
  const screen = async (id: string) =>
    (
      await terminal<TerminalReplay>('replay', {
        id,
        afterSequence: 0,
        limit: 2000,
      })
    ).events
      .map((event) => event.data ?? '')
      .join('');
  // The cards still open; answered ones stay in the snapshot as recorded
  const cards = () =>
    controller
      .snapshot()
      .interactions.filter((interaction) => interaction.status === 'pending');
  const answer = async (answer: string) => {
    const card = cards()[0]!;
    await call('answer', { id: card.id, revision: card.revision, answer });
  };
  const rows = () =>
    told
      .filter(
        (update) =>
          update.conversation === controller.snapshot().activeSessionId,
      )
      .at(-1)?.rows ?? [];
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    workspace,
    model,
    controller,
    call,
    terminal,
    screen,
    cards,
    answer,
    rows,
  };
}

const toolResults = (model: ScriptedModel): Message[] =>
  model.requests.at(-1)!.messages.filter((message) => message.role === 'tool');

test(
  'a real shell tab: the first command asks, a denial types nothing, an allowed one runs, and manual mode asks for the next',
  { skip: !unix, timeout: patience(120_000) },
  async (t) => {
    const tab = { id: '', session: '' };
    const opened = gate();
    const send = (text: string) =>
      step('terminal_send', () => ({
        session: tab.session,
        text,
        enter: true,
      }));
    const f = await setup(t, [
      step('terminal_sessions', () => ({}), opened.opened),
      send('printf CIRCLE_RAN > ran.txt'),
      send('printf CIRCLE_RAN > ran.txt'),
      send('printf AGAIN > again.txt'),
      done,
    ]);
    await f.call('prompt', { text: 'run it in my terminal' });
    const shell = await f.terminal<TerminalSnapshot>('create', {
      shell: '/bin/sh',
    });
    tab.id = shell.id;
    tab.session = `local:${shell.id}`;
    await until(
      async () => (await f.screen(shell.id)).includes(PROMPT),
      'the shell prompt',
    );
    opened.open();
    // The model sees the tab beside the devices, named like the tab, before it asks
    await until(() => f.model.requests.length === 2, 'the listing');
    assert.match(
      toolResults(f.model)[0]!.content,
      new RegExp(`- local:${shell.id} · terminal 1 · local sh in `),
    );
    await until(() => f.cards().length === 1, 'the first-use card');
    const first = f.cards()[0]!;
    assert.equal(first.kind, 'approval');
    assert.equal(first.tool, 'terminal_send');
    assert.equal(first.command, 'printf CIRCLE_RAN > ran.txt');
    // The first time Circle would type, the card says so. A later line is judged
    // as the command it is.
    assert.equal(first.reason, 'types this command into your terminal');
    assert.equal(first.input?.terminal, tab.session);
    assert.equal(first.input?.ordinal, 1);
    assert.equal(first.input?.first_use, true);
    assert.deepEqual(first.choices, ['approve', 'always', 'reject']);
    // the window is told the tab waits for the person
    await until(
      () => f.rows().find((row) => row.id === tab.session)?.state === 'waiting',
      'the waiting tab',
    );
    await f.answer('reject');
    await until(
      () => f.cards().length === 1 && f.cards()[0]!.id !== first.id,
      'the card asked again',
    );
    // the denial typed nothing: no file, and the PTY never saw the line
    assert.equal(existsSync(join(f.workspace, 'ran.txt')), false);
    assert.equal((await f.screen(shell.id)).includes('CIRCLE_RAN'), false);
    assert.match(
      toolResults(f.model).at(-1)!.content,
      /The user rejected this tool call/,
    );
    // still the first use: the denial did not let Circle in
    assert.equal(f.cards()[0]!.input?.first_use, true);
    await f.answer('approve');
    await until(
      async () =>
        (await written(join(f.workspace, 'ran.txt'))) === 'CIRCLE_RAN',
      'the allowed command ran in the shell',
    );
    // the next command is a command like execute's: manual mode asks for it
    await until(
      () =>
        f.cards().length === 1 &&
        f.cards()[0]!.command === 'printf AGAIN > again.txt',
      'the next card',
    );
    assert.equal(f.cards()[0]!.input?.first_use, false);
    assert.equal(f.cards()[0]!.reason, 'runs a shell command');
    await f.answer('approve');
    await until(
      async () => (await written(join(f.workspace, 'again.txt'))) === 'AGAIN',
      'the second command ran',
    );
    await until(() => f.model.requests.length === 5, 'the end of the turn');
    const row = f.rows().find((one) => one.id === tab.session)!;
    assert.equal(row.allowed, true);
    assert.equal(row.ordinal, 1);
    assert.equal(row.state, 'idle');
  },
);

test(
  'a real shell tab: plan mode types nothing, typing during a wait takes the tab over, and closing it ends the wait',
  { skip: !unix, timeout: patience(120_000) },
  async (t) => {
    const tab = { id: '', session: '' };
    const opened = gate();
    const returned = gate();
    const wait = (afterwards?: Promise<void>) =>
      step(
        'terminal_wait',
        () => ({
          session: tab.session,
          pattern: 'NEVER_PRINTED',
          idle_ms: 30000,
          timeout_ms: 300000,
        }),
        afterwards,
      );
    const f = await setup(t, [
      step(
        'terminal_send',
        () => ({
          session: tab.session,
          text: 'printf PLAN > plan.txt',
          enter: true,
        }),
        opened.opened,
      ),
      wait(),
      wait(returned.opened),
      step('terminal_sessions', () => ({})),
      done,
      // The give-back comes as a message of its own once that turn is done
      done,
    ]);
    await f.call('set-mode', { mode: 'plan' });
    await f.call('prompt', { text: 'watch my terminal' });
    const shell = await f.terminal<TerminalSnapshot>('create', {
      shell: '/bin/sh',
    });
    tab.id = shell.id;
    tab.session = `local:${shell.id}`;
    await until(
      async () => (await f.screen(shell.id)).includes(PROMPT),
      'the shell prompt',
    );
    opened.open();
    // plan mode: refused before the PTY, and no card
    await until(() => f.model.requests.length === 2, 'the refused send');
    assert.match(
      toolResults(f.model)[0]!.content,
      /read-only mode: this tool cannot run/,
    );
    assert.equal(f.cards().length, 0);
    assert.equal((await f.screen(shell.id)).includes('PLAN'), false);
    // the wait is under way: what the person types takes the tab over and ends it
    await until(
      () =>
        f.rows().find((row) => row.id === tab.session)?.state === 'operating',
      'Circle waits on the tab',
    );
    await f.terminal('write', { id: shell.id, data: 'x' });
    await until(() => f.model.requests.length === 3, 'the wait ended');
    assert.match(
      toolResults(f.model).at(-1)!.content,
      /The user has terminal 1 now, until they hand it back; your wait ended there/,
    );
    const held = f.rows().find((row) => row.id === tab.session)!;
    assert.equal(held.state, 'held');
    assert.equal(held.held, 'attach');
    // the person hands it back from the window: it is Circle's again, to go on with
    // the wait they cut short
    let back: LocalTerminalRow[];
    try {
      back = await f.controller.terminalTabControl(
        f.controller.snapshot().activeSessionId,
        tab.session,
        'return',
      );
    } finally {
      returned.open();
    }
    assert.equal(
      back.find((row) => row.id === tab.session)?.state,
      'operating',
    );
    // the next wait runs until the person closes the tab under it. The tab already
    // reads as Circle's, so the wait is seen in the conversation.
    await until(
      () =>
        f.controller
          .snapshot()
          .sessions.find(
            (row) => row.id === f.controller.snapshot().activeSessionId,
          )!
          .messages.filter((message) => message.tool?.name === 'terminal_wait')
          .at(-1)?.tool?.status === 'running' && f.model.requests.length === 3,
      'Circle waits again',
    );
    // closing returns once the shell has exited; the turn may have gone on by then
    await f.terminal('close', { id: shell.id });
    await until(
      () => f.model.requests.length === 6,
      'the end of the turn and the give-back message',
    );
    const [, , closed, listed] = toolResults(f.model);
    assert.equal(closed!.status, 'error');
    assert.match(
      closed!.content,
      /terminal 1 was closed while you waited; it is gone from terminal_sessions/,
    );
    // An exited shell stays listed until its tab is closed in the row
    assert.match(
      listed!.content,
      new RegExp(`- terminal 1 · local:${shell.id} · exited\\.`),
    );
    const told = f.model.requests.at(-1)!.messages.at(-1)!;
    assert.equal(told.role, 'user');
    assert.match(
      told.content,
      /The user gave terminal 1 back\. It is yours again\. You were waiting on it: call terminal_wait on terminal 1 now/,
    );
    assert.deepEqual(f.rows(), []);
  },
);

test(
  'a background command terminal is never one of the tabs, and a tab’s screen is drawn from what its shell printed',
  { skip: !unix, timeout: patience(60_000) },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'circle-local-command-')),
    );
    const workspace = join(root, 'workspace');
    const shellHome = join(root, 'home');
    await Promise.all([mkdir(workspace), mkdir(shellHome)]);
    const manager = new TerminalManager(
      {
        workspaceRoot: workspace,
        logRoot: join(root, 'logs'),
        shellAllowlist: ['/bin/sh'],
        env: {
          HOME: shellHome,
          PS1: PROMPT,
          HISTFILE: '/dev/null',
          ENV: '/dev/null',
        },
        stopGraceMs: 150,
      },
      () => {},
    );
    const local = new LocalTerminals({
      host: () => manager,
      changed: () => {},
      mode: () => 'manual',
      waiting: () => new Set(),
    });
    t.after(async () => {
      local.close();
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const owner = 'conversation-a';
    let command: ManagedTerminalCommandHandle | undefined;
    command = await manager.createManagedCommand({
      owner,
      sessionId: owner,
      executionId: randomUUID(),
      toolCallId: 'background-call',
      completion: {
        kind: 'pty-group',
        descendantCoverage: {
          state: 'unknown',
          reason: 'coverage-unavailable',
          observedAt: Date.now(),
        },
      },
      launch: {
        file: process.execPath,
        args: [
          '-e',
          "console.log('BACKGROUND_READY');setInterval(()=>{},1000)",
        ],
      },
      cwd: workspace,
      env: { PATH: process.env.PATH ?? '' },
      outputPath: join(root, 'command.log'),
      signal: new AbortController().signal,
      stop: async () => command?.stopTransport(),
    });
    const shell = await manager.create({ owner, sessionId: owner });
    const signal = new AbortController().signal;
    const port = local.port();
    await until(async () => {
      const screen = (await manager.replay(owner, shell.id)).events
        .map((event) => event.data ?? '')
        .join('');
      return screen.includes(PROMPT);
    }, 'the shell prompt');
    const listed = await port.request(owner, 'sessions', {}, signal);
    assert.match(
      listed.text,
      new RegExp(`- local:${shell.id} · terminal 1 · local sh in `),
    );
    assert.equal(listed.text.includes(command.snapshot.id), false);
    assert.deepEqual(
      local.rows(owner).map((row) => [row.terminal, row.ordinal]),
      [[shell.id, 1]],
    );
    assert.throws(
      () =>
        local.facts(
          owner,
          'send',
          { session: `local:${command!.snapshot.id}`, text: 'x' },
          { session: `local:${command!.snapshot.id}`, text: 'x' },
        ),
      /no terminal local:.* in this conversation/,
    );
    await assert.rejects(
      local.control(owner, `local:${command.snapshot.id}`, 'take'),
      /no terminal local:/,
    );
    // reading asks nothing and shows the real shell's screen, prompt and all
    const read = await port.request(
      owner,
      'read',
      { session: `local:${shell.id}` },
      signal,
    );
    assert.match(read.text, /### Prompt\nCIRCLE_TEST>/);
  },
);

test(
  'a wait on a real shell ends when its prompt is back, also a prompt that ends in ❯ or ✗, and holds while sleep runs',
  { skip: !unix, timeout: patience(90_000) },
  async (t) => {
    for (const prompt of ['❯ ', '➜  proj git:(main) ✗ ']) {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'circle-local-prompt-')),
      );
      const workspace = join(root, 'workspace');
      const shellHome = join(root, 'home');
      await Promise.all([mkdir(workspace), mkdir(shellHome)]);
      const manager = new TerminalManager(
        {
          workspaceRoot: workspace,
          logRoot: join(root, 'logs'),
          shellAllowlist: ['/bin/sh'],
          env: {
            HOME: shellHome,
            PS1: prompt,
            HISTFILE: '/dev/null',
            ENV: '/dev/null',
          },
          stopGraceMs: 150,
        },
        () => {},
      );
      const local = new LocalTerminals({
        host: () => manager,
        changed: () => {},
        mode: () => 'manual',
        waiting: () => new Set(),
      });
      t.after(async () => {
        local.close();
        await manager.dispose();
        await rm(root, { recursive: true, force: true });
      });
      const owner = 'conversation-prompt';
      const shell = await manager.create({ owner, sessionId: owner });
      const screen = async () =>
        (await manager.replay(owner, shell.id)).events
          .map((event) => event.data ?? '')
          .join('');
      await until(
        async () => (await screen()).includes(prompt.trim()),
        'the shell prompt',
      );
      const port = local.port();
      const signal = new AbortController().signal;
      const wait = (timeout_ms: number) =>
        port.request(
          owner,
          'wait',
          { session: `local:${shell.id}`, idle_ms: 300, timeout_ms },
          signal,
        );
      // At the prompt
      assert.match((await wait(20_000)).text, /quiet for 0\.3s/, prompt);
      // A command that prints nothing: the screen is quiet, the shell is not back
      await manager.write(owner, shell.id, 'sleep 30\r');
      await until(
        async () => (await screen()).includes('sleep 30'),
        'the command on the screen',
      );
      assert.match((await wait(2000)).text, /still going after 2s/, prompt);
      // Interrupted, the shell takes its terminal back and prompts again
      await manager.write(owner, shell.id, '\x03');
      assert.match((await wait(20_000)).text, /quiet for 0\.3s/, prompt);
    }
  },
);
