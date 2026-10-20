// The person's own terminal tabs as the model's terminal tools reach them, against a fake
// terminal service whose output the test writes by hand: what is listed, what asks and
// what is typed, and how the person takes a tab, gives it back or stops Circle on it.
// The tools, the approval policy, the harness and the session manager are the real ones.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '../../../src/runtime.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { defaultSettings, trustFolder } from '../../../src/settings.ts';
import {
  terminalTools,
  type TerminalPort,
} from '../../../src/terminal/tools.ts';
import type { ApprovalDecision } from '../../../src/harness.ts';
import { emptyUsage, type Message, type ToolCall } from '../../../src/types.ts';
import {
  LocalTerminals,
  type LocalTerminalHost,
} from '../src/local-terminals.ts';
import { terminalTabNumbers } from '../src/terminal-tabs.ts';
import { ApprovalPolicy, ApprovalStore } from '../../../src/approvals.ts';
import type {
  TerminalEvent,
  TerminalSnapshot,
} from '../src/workspace/terminal.ts';

async function until(check: () => boolean, description: string) {
  const end = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > end) throw Error(`timed out: ${description}`);
    await delay(10);
  }
}

/** A terminal service whose shells echo what is typed and answer Enter with a prompt. */
class FakeTerminals implements LocalTerminalHost {
  snapshots: TerminalSnapshot[] = [];
  writes: { id: string; data: string }[] = [];
  private listeners = new Set<(event: TerminalEvent) => void>();
  private output = new Map<string, { data: string; at: string }[]>();
  private clock = Date.parse('2026-10-19T08:00:00.000Z');
  private sequence = 0;
  open(
    owner: string,
    extra: Partial<TerminalSnapshot> = {},
    screen = '$ ',
  ): TerminalSnapshot {
    const snapshot: TerminalSnapshot = {
      id: randomUUID(),
      owner,
      sessionId: owner,
      epoch: randomUUID(),
      cwd: '/work/project',
      shell: '/bin/zsh',
      args: [],
      label: 'zsh',
      cols: 80,
      rows: 24,
      status: 'running',
      startedAt: new Date((this.clock += 1000)).toISOString(),
      lastSequence: 0,
      logPath: '/dev/null',
      kind: 'shell',
      ...extra,
    };
    this.snapshots.push(snapshot);
    this.emit(snapshot, 'created');
    if (screen) this.print(snapshot.id, screen);
    return snapshot;
  }
  print(id: string, data: string): void {
    const snapshot = this.get(id);
    const at = new Date().toISOString();
    this.output.set(id, [...(this.output.get(id) ?? []), { data, at }]);
    this.emit(snapshot, 'data', data);
  }
  close(id: string): void {
    const snapshot = this.get(id);
    snapshot.status = 'exited';
    snapshot.exitCode = 0;
    this.emit(snapshot, 'exit');
  }
  typed(id: string): string {
    return this.writes
      .filter((write) => write.id === id)
      .map((write) => write.data)
      .join('');
  }
  listNow(owner: string): TerminalSnapshot[] {
    return this.snapshots
      .filter((snapshot) => snapshot.owner === owner)
      .map((snapshot) => structuredClone(snapshot));
  }
  recentOutput(owner: string, id: string) {
    const snapshot = this.snapshots.find((one) => one.id === id);
    if (!snapshot || snapshot.owner !== owner) return undefined;
    const parts = this.output.get(id) ?? [];
    return {
      data: parts.map((part) => part.data).join(''),
      sequence: snapshot.lastSequence,
      at: parts.at(-1)?.at,
    };
  }
  observe(listener: (event: TerminalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async write(owner: string, id: string, data: string): Promise<unknown> {
    const snapshot = this.get(id);
    if (snapshot.owner !== owner || snapshot.status !== 'running')
      throw Error('terminal is not running');
    this.writes.push({ id, data });
    // A shell's echo: the typed text, and a fresh prompt after each Enter
    this.print(id, data.replace(/\r/g, '\r\n$ '));
    return snapshot;
  }
  get listening(): number {
    return this.listeners.size;
  }
  private get(id: string): TerminalSnapshot {
    const snapshot = this.snapshots.find((one) => one.id === id);
    if (!snapshot) throw Error('terminal not found');
    return snapshot;
  }
  private emit(
    snapshot: TerminalSnapshot,
    kind: TerminalEvent['kind'],
    data?: string,
  ): void {
    const event: TerminalEvent = {
      terminalId: snapshot.id,
      owner: snapshot.owner,
      sessionId: snapshot.sessionId,
      epoch: snapshot.epoch,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      kind,
      ...(data !== undefined ? { data } : {}),
      ...(kind !== 'data' ? { snapshot: structuredClone(snapshot) } : {}),
    };
    snapshot.lastSequence = event.sequence;
    for (const listener of this.listeners) listener(event);
  }
}

/** The device consoles' side, as the main process would answer: one console, t1. */
function devices() {
  const requests: { action: string; args: Record<string, unknown> }[] = [];
  const port: TerminalPort = {
    async request(_conversation, action, args) {
      requests.push({ action, args: structuredClone(args) });
      if (action === 'sessions')
        return {
          text: '### Terminals\n- t1 · lab · ssh sw1.lan:22 · quiet 3s\n### Profiles\n- lab (ssh sw1.lan:22)',
        };
      return { text: `t1 · ${action} done`, host: 'sw1.lan:22', session: 't1' };
    },
  };
  return { port, requests };
}

function tabs(
  host: FakeTerminals,
  mode: () => string = () => 'manual',
  handedBack?: (
    conversation: string,
    detail: { name: string; resume: boolean },
  ) => void,
) {
  const waiting = new Map<string, Set<string>>();
  const local = new LocalTerminals({
    host: () => host,
    changed: () => {},
    mode,
    waiting: (id) => waiting.get(id) ?? new Set(),
    handedBack,
  });
  return { local, waiting };
}

/** A tool call, made when the model is asked: the tab's id is known by then. */
const step =
  (name: string, args: () => Record<string, unknown>) => async () => ({
    message: {
      id: randomUUID(),
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id: randomUUID(), name, args: args() }],
    },
    usage: emptyUsage(),
  });
const done = async () => ({
  message: { id: randomUUID(), role: 'assistant' as const, content: 'done' },
  usage: emptyUsage(),
});

/** The tool results the model was given, in order, as of its newest request. */
const results = (model: ScriptedModel): Message[] =>
  model.requests.at(-1)!.messages.filter((message) => message.role === 'tool');

async function runtime(
  t: TestContext,
  steps: (() => ReturnType<typeof done>)[],
  host: FakeTerminals,
  approve: (call: ToolCall) => Promise<ApprovalDecision> = async () =>
    'approve',
  mode: () => string = () => 'manual',
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-local-terminals-'));
  const device = devices();
  const { local } = tabs(host, mode);
  const model = new ScriptedModel(steps);
  const asked: ToolCall[] = [];
  const agent = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: terminalTools(local.port(device.port), { tabs: local }),
    approve: async (call) => {
      asked.push(structuredClone(call));
      return approve(call);
    },
  });
  t.after(async () => {
    await agent.close();
    local.close();
    await rm(root, { recursive: true, force: true });
  });
  return { agent, model, asked, device, local, id: agent.session.id };
}

test('terminal tabs are numbered among the conversation terminals that are not background commands, oldest first', () => {
  const at = (second: number) =>
    new Date(Date.UTC(2026, 9, 19, 8, 0, second)).toISOString();
  const numbers = terminalTabNumbers([
    { id: 'late', startedAt: at(5) },
    { id: 'command', startedAt: at(1), managedCommand: {} },
    { id: 'first', startedAt: at(0) },
    { id: 'service', startedAt: at(2) },
    { id: 'same-ms-a', startedAt: at(3) },
    { id: 'same-ms-b', startedAt: at(3) },
  ]);
  assert.deepEqual(Object.fromEntries(numbers), {
    first: 1,
    service: 2,
    'same-ms-a': 3,
    'same-ms-b': 4,
    late: 5,
  });
});

test('terminal_sessions lists the running shells as local tabs beside the devices, never a background command, a service or a closed shell', async (t) => {
  const host = new FakeTerminals();
  const f = await runtime(
    t,
    [step('terminal_sessions', () => ({})), done],
    host,
  );
  const shell = host.open(f.id, {}, 'hello\r\n$ ');
  host.open(f.id, {
    label: 'command',
    managedCommand: {
      executionId: 'e1',
      ownership: 'pty-group',
      completion: {
        kind: 'pty-group',
        descendantCoverage: {
          state: 'unknown',
          reason: 'coverage-unavailable',
          observedAt: 0,
        },
      },
    },
  });
  host.open(f.id, {
    kind: 'service',
    label: 'npm run dev',
    command: { file: 'npm' },
  });
  const closed = host.open(f.id);
  host.close(closed.id);
  const later = host.open(f.id);
  host.open(randomUUID()); // another conversation's tab
  await f.agent.harness.run('which terminals are there');
  const text = results(f.model).at(-1)!.content;
  assert.match(text, /- t1 · lab · ssh sw1\.lan:22/);
  assert.match(
    text,
    new RegExp(
      `- local:${shell.id} · terminal 1 · local zsh in /work/project · `,
    ),
  );
  // the service holds place 2 and the closed shell place 3: the later shell is 4
  assert.match(text, new RegExp(`- local:${later.id} · terminal 4 · `));
  assert.equal((text.match(/local:/g) ?? []).length, 2);
  assert.match(text, /### Profiles\n- lab/);
  // listing asks nothing and types nothing
  assert.equal(f.asked.length, 0);
  assert.equal(host.writes.length, 0);
  assert.deepEqual(
    f.local.rows(f.id).map((row) => [row.terminal, row.ordinal, row.state]),
    [
      [shell.id, 1, 'idle'],
      [later.id, 4, 'idle'],
    ],
  );
});

test('the first command in a tab asks even in auto mode: a denial types nothing, allowing it types its bytes, and then auto mode asks no more', async (t) => {
  const host = new FakeTerminals();
  const tab = { session: '' };
  const answers: ApprovalDecision[] = [
    { decision: 'reject', message: 'not in that terminal' },
    'approve',
  ];
  const send = (text: string) =>
    step('terminal_send', () => ({ session: tab.session, text, enter: true }));
  const f = await runtime(
    t,
    [send('echo hi'), send('echo hi'), send('npm test'), done],
    host,
    async () => answers.shift() ?? 'reject',
  );
  const shell = host.open(f.id);
  tab.session = `local:${shell.id}`;
  f.agent.setMode('auto');
  await f.agent.harness.run('say hi in my terminal');
  // Two cards, though auto mode asks for no command: the first use, refused and asked again
  assert.equal(f.asked.length, 2);
  for (const call of f.asked) {
    assert.equal(call.name, 'terminal_send');
    assert.equal(call.args.terminal, tab.session);
    assert.equal(call.args.ordinal, 1);
    assert.equal(call.args.first_use, true);
    assert.equal(call.args.command, 'echo hi');
  }
  const [denied, allowed, later] = results(f.model);
  assert.equal(denied!.status, 'error');
  assert.match(
    denied!.content,
    /The user rejected this tool call\. The user said: not in that terminal/,
  );
  assert.equal(allowed!.status, 'success');
  assert.equal(later!.status, 'success');
  // the denial typed nothing; the allowed line and the auto-mode one reached the shell
  assert.equal(host.typed(shell.id), 'echo hi\rnpm test\r');
  assert.match(later!.content, /npm test/);
});

test('after the first command, lines follow the execute rules: manual mode asks per command, a session rule covers execute too, and typing without Enter asks nothing', async (t) => {
  const host = new FakeTerminals();
  const tab = { session: '' };
  const answers: ApprovalDecision[] = ['approve', 'always'];
  const send = (text: string, enter = true) =>
    step('terminal_send', () => ({ session: tab.session, text, enter }));
  const f = await runtime(
    t,
    [
      send('echo hi'),
      send('ls'),
      send('cat notes.txt'),
      send('git sta', false),
      step('terminal_press', () => ({ session: tab.session, key: 'Enter' })),
      done,
    ],
    host,
    async () => answers.shift() ?? 'approve',
  );
  const shell = host.open(f.id);
  tab.session = `local:${shell.id}`;
  await f.agent.harness.run('work in my terminal');
  // 1: the first use, allowed once. 2: `ls`, a new command in manual mode, asks and is
  // allowed for this session, which covers read-only commands. 3: `cat` is one, no card.
  // 4: typing without Enter asks nothing. 5: Enter runs `git sta`: asked as a command.
  assert.deepEqual(
    f.asked.map((call) => [call.name, call.args.command, call.args.first_use]),
    [
      ['terminal_send', 'echo hi', true],
      ['terminal_send', 'ls', false],
      ['terminal_press', 'git sta', false],
    ],
  );
  assert.equal(host.typed(shell.id), 'echo hi\rls\rcat notes.txt\rgit sta\r');
  // the same rules as execute: the read-only rule covers an execute call as well
  assert.equal(
    f.agent.policy.needsApproval('execute', { command: 'ls -la' }, f.id),
    false,
  );
  assert.equal(
    f.agent.policy.needsApproval('execute', { command: 'npm test' }, f.id),
    true,
  );
  const row = f.local.rows(f.id)[0]!;
  assert.equal(row.allowed, true);
  assert.equal(row.state, 'idle');
});

test('plan mode refuses a send before anything reaches the tab, and reading never asks', async (t) => {
  const host = new FakeTerminals();
  const tab = { session: '' };
  const f = await runtime(
    t,
    [
      step('terminal_send', () => ({
        session: tab.session,
        text: 'rm -rf build',
        enter: true,
      })),
      step('terminal_read', () => ({ session: tab.session, lines: 5 })),
      done,
    ],
    host,
  );
  const shell = host.open(f.id, {}, 'build finished\r\n$ ');
  tab.session = `local:${shell.id}`;
  f.agent.setMode('plan');
  await f.agent.harness.run('look at my terminal');
  const [send, read] = results(f.model);
  assert.match(send!.content, /read-only mode: this tool cannot run/);
  assert.equal(host.writes.length, 0);
  // the read shows the screen, drawn from what the tab had already printed
  assert.match(read!.content, /build finished/);
  assert.match(read!.content, /### Prompt\n\$/);
  assert.equal(f.asked.length, 0);
});

test('a refused command, control characters and closing a tab fail before any card, and devices go on as before', async (t) => {
  const host = new FakeTerminals();
  const tab = { session: '' };
  const send = (session: () => string, text: string) =>
    step('terminal_send', () => ({ session: session(), text, enter: true }));
  const f = await runtime(
    t,
    [
      send(() => tab.session, 'sudo rm -rf /'),
      send(() => tab.session, 'echo\ta'),
      step('terminal_disconnect', () => ({ session: tab.session })),
      send(() => 't1', 'show version'),
      send(() => 'local:no-such-tab', 'ls'),
      done,
    ],
    host,
  );
  const shell = host.open(f.id);
  tab.session = `local:${shell.id}`;
  f.agent.setMode('auto');
  await f.agent.harness.run('try things');
  const [sudo, tabbed, closing, device, missing] = results(f.model).map(
    (message) => message.content,
  );
  assert.match(sudo!, /'sudo' is not allowed/);
  assert.match(tabbed!, /no control characters or tabs/);
  assert.match(
    closing!,
    /terminal 1 is the user's own terminal tab; Circle does not close it/,
  );
  assert.match(device!, /t1 · send done/);
  assert.match(missing!, /no terminal local:no-such-tab in this conversation/);
  assert.equal(host.writes.length, 0);
  // the device's send went to the device port as it always did, without tab facts
  const sent = f.device.requests.find((request) => request.action === 'send');
  assert.equal(sent?.args.text, 'show version');
  assert.equal(sent?.args.terminal, undefined);
  assert.equal(f.asked.length, 0);
});

test('a line the user changed after Circle asked is not typed', async (t) => {
  const host = new FakeTerminals();
  const tab = { session: '', terminal: '' };
  let f: Awaited<ReturnType<typeof runtime>>;
  f = await runtime(
    t,
    [
      step('terminal_send', () => ({
        session: tab.session,
        text: 'make deploy',
        enter: true,
      })),
      done,
    ],
    host,
    async () => {
      // the person types into the tab while the card is open, then allows it
      f.local.typed(f.id, tab.terminal, 'git push');
      return 'approve';
    },
  );
  const shell = host.open(f.id);
  tab.session = `local:${shell.id}`;
  tab.terminal = shell.id;
  await f.agent.harness.run('deploy');
  assert.match(
    results(f.model).at(-1)!.content,
    /the line in terminal 1 changed after you asked, so nothing was typed/,
  );
  assert.equal(host.writes.length, 0);
});

/** A direct port on one tab whose first write the person allowed. */
async function allowedTab(
  t: TestContext,
  mode: () => string = () => 'manual',
  handedBack?: (
    conversation: string,
    detail: { name: string; resume: boolean },
  ) => void,
) {
  const host = new FakeTerminals();
  const fixture = tabs(host, mode, handedBack);
  const id = randomUUID();
  const shell = host.open(id);
  const session = `local:${shell.id}`;
  const port = fixture.local.port();
  const signal = new AbortController().signal;
  t.after(() => fixture.local.close());
  const send = async (text: string) => {
    // as the harness passes it: the facts merged in, once any approval was given
    const args = { session, text, enter: true };
    const facts = fixture.local.facts(id, 'send', args, args);
    return port.request(id, 'send', { ...args, ...facts }, signal);
  };
  await send('echo ready');
  return { host, ...fixture, id, shell, session, port, signal, send };
}

test('taking a tab over ends Circle’s wait at once, refuses its typing, and handing it back lets it go on', async (t) => {
  const f = await allowedTab(t);
  const before = f.host.writes.length;
  const waiting = f.port.request(
    f.id,
    'wait',
    {
      session: f.session,
      pattern: 'NEVER_PRINTED',
      idle_ms: 30000,
      timeout_ms: 300000,
    },
    f.signal,
  );
  await until(
    () => f.local.rows(f.id)[0]?.state === 'operating',
    'Circle operates the tab',
  );
  const rows = await f.local.control(f.id, f.session, 'take');
  assert.equal(rows[0]!.state, 'held');
  assert.equal(rows[0]!.held, 'attach');
  const result = await waiting;
  assert.match(result.text, /held by the user \(attach\)/);
  assert.match(
    result.text,
    /The user has terminal 1 now, until they hand it back; your wait ended there/,
  );
  await assert.rejects(
    f.send('ls'),
    /terminal 1 is the user's now: they took it over, and nothing was typed/,
  );
  // a read while they hold it says so and shows nothing
  const read = await f.port.request(
    f.id,
    'read',
    { session: f.session },
    f.signal,
  );
  assert.match(read.text, /nothing was read or typed/);
  assert.equal(read.text.includes('echo ready'), false);
  assert.equal(f.host.writes.length, before);
  const back = await f.local.control(f.id, f.session, 'return');
  assert.equal(back[0]!.state, 'operating');
  const sent = await f.send('ls');
  assert.match(sent.text, /terminal 1: the user gave the terminal back/);
  assert.equal(f.host.typed(f.shell.id), 'echo ready\rls\r');
});

test('giving a tab back after a cut-short wait puts Circle back to work and says so', async (t) => {
  const notes: { name: string; resume: boolean }[] = [];
  const f = await allowedTab(
    t,
    () => 'manual',
    (_conversation, detail) => {
      notes.push(detail);
    },
  );
  const waiting = f.port.request(
    f.id,
    'wait',
    {
      session: f.session,
      pattern: 'NEVER_PRINTED',
      idle_ms: 30000,
      timeout_ms: 300000,
    },
    f.signal,
  );
  await until(
    () => f.local.rows(f.id)[0]?.state === 'operating',
    'Circle operates the tab',
  );
  await f.local.control(f.id, f.session, 'take');
  const result = await waiting;
  assert.match(result.text, /your wait ended there/);
  const back = await f.local.control(f.id, f.session, 'return');
  assert.equal(back[0]!.state, 'operating');
  assert.deepEqual(notes, [{ name: 'terminal 1', resume: true }]);
  f.local.settleResuming(f.id);
  assert.equal(f.local.rows(f.id)[0]!.state, 'idle');
  notes.length = 0;
  const again = await f.local.control(f.id, f.session, 'return');
  assert.equal(again[0]!.state, 'operating');
  assert.deepEqual(notes, [{ name: 'terminal 1', resume: false }]);
  f.local.settleResuming(f.id);
  assert.equal(f.local.rows(f.id)[0]!.state, 'idle');
});

test('typing into a tab Circle is operating takes it over; typing while it is idle is told, never shown', async (t) => {
  const f = await allowedTab(t);
  const waiting = f.port.request(
    f.id,
    'wait',
    {
      session: f.session,
      pattern: 'NEVER_PRINTED',
      idle_ms: 30000,
      timeout_ms: 300000,
    },
    f.signal,
  );
  await until(
    () => f.local.rows(f.id)[0]?.state === 'operating',
    'Circle operates the tab',
  );
  // what xterm answers by itself is not the person typing
  f.local.typed(f.id, f.shell.id, '\x1b[12;5R');
  assert.equal(f.local.rows(f.id)[0]!.state, 'operating');
  f.local.typed(f.id, f.shell.id, 'x');
  const result = await waiting;
  assert.match(result.text, /your wait ended there/);
  assert.equal(f.local.rows(f.id)[0]!.held, 'attach');
  await f.local.control(f.id, f.session, 'return');
  // idle: only that they typed reaches the model, in its next result
  f.local.typed(f.id, f.shell.id, 'secret words');
  const read = await f.port.request(
    f.id,
    'read',
    { session: f.session },
    f.signal,
  );
  assert.match(read.text, /- terminal 1: the user typed/);
  assert.equal(read.text.includes('secret words'), false);
  assert.equal(f.local.rows(f.id)[0]!.state, 'idle');
});

test('stop ends Circle’s action on a tab without taking it, and the next action runs', async (t) => {
  const f = await allowedTab(t);
  const waiting = f.port.request(
    f.id,
    'wait',
    {
      session: f.session,
      pattern: 'NEVER_PRINTED',
      idle_ms: 30000,
      timeout_ms: 300000,
    },
    f.signal,
  );
  await until(
    () => f.local.rows(f.id)[0]?.state === 'operating',
    'Circle operates the tab',
  );
  const rows = await f.local.control(f.id, f.session, 'stop');
  await assert.rejects(waiting, /the user stopped your action on terminal 1/);
  assert.equal(rows[0]!.held, undefined);
  assert.equal(f.local.rows(f.id)[0]!.state, 'idle');
  const read = await f.port.request(
    f.id,
    'read',
    { session: f.session },
    f.signal,
  );
  assert.match(read.text, /echo ready/);
});

test('closing a tab while Circle waits on it fails the wait, drops it from the list and lets go of its screen', async (t) => {
  const f = await allowedTab(t);
  assert.equal(f.local.adopted, 1);
  const waiting = f.port.request(
    f.id,
    'wait',
    {
      session: f.session,
      pattern: 'NEVER_PRINTED',
      idle_ms: 30000,
      timeout_ms: 300000,
    },
    f.signal,
  );
  await until(
    () => f.local.rows(f.id)[0]?.state === 'operating',
    'Circle operates the tab',
  );
  f.host.close(f.shell.id);
  await assert.rejects(
    waiting,
    /terminal 1 was closed while you waited; it is gone from terminal_sessions/,
  );
  assert.equal(f.local.adopted, 0);
  assert.deepEqual(f.local.rows(f.id), []);
  const listed = await f.port.request(f.id, 'sessions', {}, f.signal);
  assert.equal(listed.text.includes('local:'), false);
  await assert.rejects(
    f.port.request(f.id, 'read', { session: f.session }, f.signal),
    /terminal 1 was closed; it is gone from terminal_sessions/,
  );
  // closing everything lets go of the service's events too
  f.local.close();
  assert.equal(f.host.listening, 0);
});

test('a handed-over tab waits for the person and comes back with its screen; plan mode does not hand it over', async (t) => {
  const notes: { name: string; resume: boolean }[] = [];
  let mode = 'manual';
  const f = await allowedTab(
    t,
    () => mode,
    (_conversation, detail) => {
      notes.push(detail);
    },
  );
  const handed = f.port.request(
    f.id,
    'handoff',
    { session: f.session, reason: 'type your sudo password' },
    f.signal,
  );
  await until(
    () => f.local.rows(f.id)[0]?.state === 'held',
    'the tab is handed over',
  );
  const held = f.local.rows(f.id)[0]!;
  assert.equal(held.state, 'held');
  assert.equal(held.held, 'handoff');
  assert.equal(held.reason, 'type your sudo password');
  f.host.print(f.shell.id, 'Password accepted\r\n$ ');
  await f.local.control(f.id, f.session, 'return');
  const result = await handed;
  assert.match(result.text, /Password accepted/);
  assert.equal(f.local.rows(f.id)[0]!.state, 'idle');
  assert.deepEqual(notes, []);
  mode = 'plan';
  await assert.rejects(
    f.port.request(
      f.id,
      'handoff',
      { session: f.session, reason: 'x' },
      f.signal,
    ),
    /plan mode does not hand a terminal over/,
  );
  assert.equal(f.local.rows(f.id)[0]!.state, 'idle');
});

test('a tab an approval waits on is waiting, and a write the person never allowed is refused, whoever asks', async (t) => {
  const host = new FakeTerminals();
  const fixture = tabs(host);
  t.after(() => fixture.local.close());
  const id = randomUUID();
  const shell = host.open(id);
  const session = `local:${shell.id}`;
  fixture.waiting.set(id, new Set([session]));
  assert.equal(fixture.local.rows(id)[0]!.state, 'waiting');
  await assert.rejects(
    fixture.local
      .port()
      .request(
        id,
        'send',
        { session, text: 'ls', enter: true },
        new AbortController().signal,
      ),
    /the user has not let Circle use terminal 1 yet; nothing was typed/,
  );
  assert.equal(host.writes.length, 0);
});

/** A tab with a prompt of its own, whose screen Circle has read, on a direct port. */
async function promptTab(t: TestContext, prompt: string, read = true) {
  const host = new FakeTerminals();
  const fixture = tabs(host);
  const id = randomUUID();
  const shell = host.open(id, {}, prompt);
  const session = `local:${shell.id}`;
  const port = fixture.local.port();
  const signal = new AbortController().signal;
  t.after(() => fixture.local.close());
  if (read) await port.request(id, 'read', { session }, signal);
  const enter = () =>
    fixture.local.facts(
      id,
      'press',
      { session, key: 'Enter' },
      { session, key: 'Enter' },
    );
  return { host, ...fixture, id, shell, session, port, signal, enter };
}

test('a line the person started is read from where they began, past the prompt, and judged as execute would judge it', async (t) => {
  const f = await promptTab(t, 'jiang@mac circle % ');
  // the person types on the fresh line and the shell echoes it
  f.local.typed(f.id, f.shell.id, 'rm -rf build');
  f.host.print(f.shell.id, 'rm -rf build');
  await until(
    () => f.enter().command === 'rm -rf build',
    'the line reads without its prompt',
  );
  const facts = f.enter();
  assert.equal(facts.uncertain, undefined);
  const root = await mkdtemp(join(tmpdir(), 'circle-tab-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = new ApprovalPolicy(
    new ApprovalStore(join(root, 'approvals')),
    root,
  );
  const args = { session: f.session, key: 'Enter', ...facts };
  // the deletion asks as it does for execute, and no prefix rule is made of the prompt
  assert.deepEqual(
    policy.review('terminal_press', args),
    policy.review('execute', { command: 'rm -rf build' }),
  );
});

test('a line the person typed before Circle read the tab may carry its prompt: it asks every time, in every mode', async (t) => {
  const f = await promptTab(t, 'jiang@mac circle % ', false);
  f.local.typed(f.id, f.shell.id, 'npm test');
  f.host.print(f.shell.id, 'npm test');
  await f.port.request(f.id, 'read', { session: f.session }, f.signal);
  const facts = f.enter();
  assert.equal(facts.uncertain, true);
  assert.match(String(facts.command), /npm test$/);
  const root = await mkdtemp(join(tmpdir(), 'circle-tab-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = new ApprovalPolicy(
    new ApprovalStore(join(root, 'approvals')),
    root,
  );
  policy.setMode('conversation', 'auto');
  const args = { session: f.session, key: 'Enter', ...facts };
  assert.equal(
    policy.needsApproval('terminal_press', args, 'conversation'),
    true,
  );
  assert.equal(policy.review('terminal_press', args).pattern, '');
});

test('a write’s facts are read from the values it types: the rules judge what runs, the card is shown names', async (t) => {
  const f = await promptTab(t, '$ ');
  const facts = f.local.facts(
    f.id,
    'send',
    { session: f.session, text: 'echo s3cr3t-value', enter: true },
    { session: f.session, text: 'echo %TOKEN%', enter: true },
  );
  assert.equal(facts.command, 'echo s3cr3t-value');
  assert.equal(facts.typed, 'echo s3cr3t-value');
});

test('stopping Circle on a tab says that what it typed may have run, and a long handoff reason stays within what the window carries', async (t) => {
  const f = await allowedTab(t);
  const waiting = f.port.request(
    f.id,
    'wait',
    {
      session: f.session,
      pattern: 'NEVER_PRINTED',
      idle_ms: 30000,
      timeout_ms: 300000,
    },
    f.signal,
  );
  await until(
    () => f.local.rows(f.id)[0]?.state === 'operating',
    'Circle operates the tab',
  );
  await f.local.control(f.id, f.session, 'stop');
  await assert.rejects(waiting, /may already have run, so read the tab/);
  const handing = f.port.request(
    f.id,
    'handoff',
    { session: f.session, reason: 'x'.repeat(10_000) },
    f.signal,
  );
  await until(
    () => f.local.rows(f.id)[0]?.held === 'handoff',
    'the tab is handed over',
  );
  assert.ok(f.local.rows(f.id)[0]!.reason!.length <= 2000);
  await f.local.control(f.id, f.session, 'return');
  await handing;
});

/** The screen shows `text`: the emulator paints what was printed before the read returns. */
async function screenHas(
  f: Awaited<ReturnType<typeof allowedTab>>,
  text: string,
) {
  for (let i = 0; i < 30; i++) {
    const read = await f.port.request(
      f.id,
      'read',
      { session: f.session },
      f.signal,
    );
    if (read.text.includes(text)) return;
    await delay(20);
  }
  throw Error(`the screen never showed ${text}`);
}

test('a local wait without a pattern holds while the cursor is off the prompt, and typing takes the tab', async (t) => {
  const f = await allowedTab(t);
  // Already at a prompt: quiet finishes the wait.
  const resting = await f.port.request(
    f.id,
    'wait',
    { session: f.session, idle_ms: 100, timeout_ms: 2000 },
    f.signal,
  );
  assert.match(resting.text, /quiet for/);
  // `sleep` prints a line and leaves the cursor off the prompt. Quiet is not done.
  f.host.print(f.shell.id, '\r\nsleep 45\r\n');
  await screenHas(f, 'sleep 45');
  let settled = false;
  const waiting = f.port
    .request(
      f.id,
      'wait',
      { session: f.session, idle_ms: 100, timeout_ms: 30000 },
      f.signal,
    )
    .then((result) => {
      settled = true;
      return result;
    });
  await delay(400);
  assert.equal(settled, false, 'quiet is not the prompt coming back');
  assert.equal(f.local.rows(f.id)[0]?.state, 'operating');
  f.local.typed(f.id, f.shell.id, 'x');
  const taken = await waiting;
  assert.match(taken.text, /your wait ended there/);
  assert.equal(f.local.rows(f.id)[0]?.held, 'attach');
});

test('a local wait off the prompt is bounded by its timeout, and the prompt ends it', async (t) => {
  const f = await allowedTab(t);
  f.host.print(f.shell.id, '\r\nsleep 45\r\n');
  await screenHas(f, 'sleep 45');
  const capped = await f.port.request(
    f.id,
    'wait',
    { session: f.session, idle_ms: 100, timeout_ms: 1200 },
    f.signal,
  );
  assert.match(capped.text, /still going after 1s/);
  f.host.print(f.shell.id, '\r\n$ ');
  const back = await f.port.request(
    f.id,
    'wait',
    { session: f.session, idle_ms: 100, timeout_ms: 5000 },
    f.signal,
  );
  assert.match(back.text, /quiet for/);
});
