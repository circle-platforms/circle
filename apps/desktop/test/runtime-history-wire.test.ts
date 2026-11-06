// What a publication costs against stored history, through a real controller and a real
// window: the worker's compactor, a structured-clone copy for each IPC hop as the
// application makes them, the main process's buffer and a LiveRuntime.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { deserialize, serialize } from 'node:v8';
import { RuntimeController } from '../src/runtime-controller.ts';
import {
  HistoryCompactor,
  restoreHistory,
} from '../src/runtime-history-wire.ts';
import { RuntimeTokenBuffer } from '../src/runtime-token-stream.ts';
import type {
  RuntimeCommandName,
  RuntimeUpdate,
} from '../src/runtime-protocol.ts';
import type { DesktopBridge } from '../src/contracts.ts';
import { LiveRuntime } from '../../workbench/src/model/live.ts';
import type { WorkbenchSnapshot } from '../../workbench/src/model/types.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import type { Message } from '../../../src/types.ts';
import { patience } from './helpers/patience.mjs';

const ipc = <T>(value: T): T => deserialize(serialize(value)) as T;
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 };
const toolTurn = (id: string, name: string, args: Record<string, unknown>) => ({
  message: {
    id,
    role: 'assistant' as const,
    content: '',
    tool_calls: [{ id: `${id}-call`, name, args }],
  },
  usage,
});
const answer = (id: string, content: string) => ({
  message: { id, role: 'assistant' as const, content },
  usage,
});
function storedMessages(session: string, count: number): Message[] {
  const rows: Message[] = [];
  for (let index = 0; rows.length < count; index++) {
    const call = `${session}-call-${index}`;
    rows.push(
      {
        id: `${session}-prompt-${index}`,
        role: 'user',
        content: `prompt ${index} ${'stored words '.repeat(40)}`,
      },
      {
        id: `${session}-reply-${index}`,
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: call, name: 'read_file', args: { file_path: 'a.txt' } },
        ],
      },
      {
        id: `${session}-result-${index}`,
        role: 'tool',
        tool_call_id: call,
        content: `result ${index} ${'stored output '.repeat(40)}`,
      },
    );
  }
  return rows;
}
const sessionIds = ['open', 'other-1', 'other-2'];

async function setup(
  t: TestContext,
  replies: ConstructorParameters<typeof ScriptedModel>[0],
  stored = 300,
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-history-wire-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(join(workspace, '.git'), { recursive: true });
  await writeFile(join(workspace, 'a.txt'), 'first\n');
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const seed = new CheckpointStore(home);
  for (const id of sessionIds.toReversed()) {
    seed.create(workspace, 'fixture', id, id);
    seed.append(id, storedMessages(id, stored));
  }
  seed.close();
  await writeFile(
    join(home, 'desktop-session.json'),
    JSON.stringify({ workspace, sessionId: 'open' }),
  );
  const compactor = new HistoryCompactor();
  const main = new RuntimeTokenBuffer();
  const runtimeListeners = new Set<(update: RuntimeUpdate) => void>();
  const sent: RuntimeUpdate[] = [];
  const complete: RuntimeUpdate[] = [];
  let observe: (update: RuntimeUpdate) => void = () => {};
  // An assertion thrown inside a publication would only end the turn, unexplained.
  const errors: unknown[] = [];
  const checked =
    (check: (update: RuntimeUpdate) => void) => (update: RuntimeUpdate) => {
      try {
        check(update);
      } catch (error) {
        errors.push(error);
      }
    };
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    // Wide enough that the stored history never makes a turn compact.
    model: Object.assign(new ScriptedModel(replies), {
      contextWindow: 1_000_000_000,
    }),
    emit: (update) => {
      complete.push(update);
      // Worker to main process, then main process to every window.
      const wire = ipc(compactor.compact(update));
      sent.push(wire);
      checked(() => assert.equal(main.accept(wire), 'accepted'))(update);
      checked(observe)(update);
      const toWindow = ipc(wire);
      for (const listener of runtimeListeners) checked(listener)(toWindow);
    },
  });
  const host = {
    onRuntime: (listener: (update: RuntimeUpdate) => void) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    onRuntimeDelta: () => () => {},
    onRuntimeWait: () => () => {},
    runtimeState: async () => ipc(main.materialize()),
  } as unknown as DesktopBridge;
  const call = (name: RuntimeCommandName, payload = {}, sessionId = 'open') =>
    controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const turnEnds = async (kind = 'run_end', from = sent.length) => {
    const end = Date.now() + patience(20_000);
    while (!sent.slice(from).some((update) => update.event?.kind === kind)) {
      if (errors.length) throw errors[0];
      const asked = main
        .materialize()
        .snapshot.interactions.find((item) => item.status === 'pending');
      if (asked) {
        const answered = await call('answer', {
          id: asked.id,
          revision: asked.revision,
          answer: 'approve',
        });
        assert.equal(answered.ok, true, answered.error);
      }
      if (Date.now() > end) throw Error(`no ${kind}: ${String(errors[0])}`);
      await delay(5);
    }
    const { active } = controller as unknown as { active: { busy: boolean } };
    while (active.busy) {
      if (Date.now() > end) throw Error('the runtime stayed busy');
      await delay(5);
    }
    if (errors.length) throw errors[0];
  };
  return {
    home,
    workspace,
    controller,
    call,
    host,
    main,
    sent,
    complete,
    errors,
    turnEnds,
    setObserver: (next: typeof observe) => (observe = next),
    runtimeListeners,
    compactor,
  };
}
// Everything a window reads about stored history, by session and agent.
const history = (snapshot: WorkbenchSnapshot) => ({
  sessions: snapshot.sessions.map((session) => ({
    id: session.id,
    messages: session.messages,
    branchIds: session.branchIds,
  })),
  agents: snapshot.agents.map((agent) => ({
    id: agent.id,
    messages: agent.messages,
  })),
});
async function until(check: () => boolean, description: string) {
  const end = Date.now() + patience(10_000);
  while (!check()) {
    if (Date.now() > end) throw Error(`timed out: ${description}`);
    await delay(5);
  }
}

test('a publication with nothing changed sends no stored history, whatever is stored', async (t) => {
  const small = await setup(t, [], 30);
  const large = await setup(t, [], 600);
  const bytes = (f: typeof small) => {
    f.controller.publish();
    const wire = f.sent.at(-1)!;
    assert.deepEqual(wire.history?.deltas, []);
    for (const session of wire.snapshot.sessions)
      assert.deepEqual(session.messages, []);
    return serialize(wire).length;
  };
  small.controller.publish();
  large.controller.publish();
  const fewer = bytes(small);
  const more = bytes(large);
  // Temporary paths and timestamps differ a little. History, twenty times longer, does not count.
  assert.ok(
    Math.abs(more - fewer) < 2048,
    `${fewer} and ${more} bytes for 30 and 600 stored messages`,
  );
  const whole = serialize(large.complete.at(-1)).length;
  assert.ok(more * 10 < whole, `${more} bytes of ${whole}`);
  // Both ends have all of it, from the first publication.
  assert.deepEqual(
    history(large.main.materialize().snapshot),
    history(large.complete.at(-1)!.snapshot),
  );
});

test('a whole turn sends what it adds, and a window ends with what the runtime has', async (t) => {
  const f = await setup(t, [
    toolTurn('read', 'read_file', { file_path: 'a.txt' }),
    toolTurn('write', 'write_file', {
      file_path: 'a.txt',
      content: 'second\n',
    }),
    answer('done', 'the turn is done'),
  ]);
  f.controller.publish();
  const initial = ipc(f.main.materialize());
  const live = new LiveRuntime(f.host, initial);
  t.after(() => live.dispose());
  const mark = f.sent.length;
  let compared = 0;
  // Every publication, not only the last: main and window read the same as a whole snapshot.
  f.setObserver((update) => {
    assert.deepEqual(
      history(f.main.materialize().snapshot),
      history(ipc(update.snapshot)),
    );
    compared++;
  });
  f.runtimeListeners.add(() => {
    assert.deepEqual(
      history(live.getSnapshot()),
      history(ipc(f.complete.at(-1)!.snapshot)),
    );
  });
  const reply = await f.call('prompt', { text: 'go on' });
  assert.equal(reply.ok, true, reply.error);
  await f.turnEnds('run_end', mark);
  assert.ok(compared > 10, `${compared} publications compared`);
  const turn = f.sent.slice(mark);
  // No publication sent the other sessions, or the 300 stored rows of this one.
  for (const update of turn)
    for (const delta of update.history?.deltas ?? []) {
      assert.equal(delta.key, 'session:open');
      assert.ok(delta.messages.length < 8, `${delta.messages.length} rows`);
    }
  const session = live.getSnapshot().sessions.find((row) => row.id === 'open')!;
  assert.equal(session.messages.at(-1)?.text, 'the turn is done');
  assert.ok(
    session.messages.some((row) => row.tool?.output?.includes('first')),
    'the read shows its result',
  );
  assert.ok(session.messages.some((row) => row.tool?.diff));
});

test('rows keep their objects while they do not change, and a fresh projection reads the same', async (t) => {
  const f = await setup(t, [
    toolTurn('write', 'write_file', {
      file_path: 'a.txt',
      content: 'second\n',
    }),
    answer('later', 'one answer'),
    async () => {
      throw Error('the model failed');
    },
  ]);
  const internals = f.controller as unknown as {
    histories: Map<string, unknown>;
  };
  // The memo must never show what a projection from nothing would not: at every
  // publication of this script, whatever it just changed.
  f.setObserver((update) => {
    const kept = internals.histories;
    internals.histories = new Map();
    const fresh = f.controller.snapshot();
    internals.histories = kept;
    assert.deepEqual(history(update.snapshot), history(fresh));
  });
  const first = f.controller.snapshot();
  const open = first.sessions.find((row) => row.id === 'open')!;
  const other = first.sessions.find((row) => row.id === 'other-1')!;
  const again = f.controller.snapshot();
  assert.equal(
    again.sessions.find((row) => row.id === 'other-1')!.messages,
    other.messages,
    'a session with nothing live is not projected again',
  );
  const openAgain = again.sessions.find((row) => row.id === 'open')!;
  assert.equal(openAgain.messages.length, open.messages.length);
  assert.ok(
    openAgain.messages.every((row, index) => row === open.messages[index]),
    'the open session walks its history and keeps every row',
  );

  await f.call('prompt', { text: 'go on' });
  await f.turnEnds();
  const after = f.controller
    .snapshot()
    .sessions.find((row) => row.id === 'open')!;
  assert.ok(
    open.messages.every((row, index) => row === after.messages[index]),
    'a turn leaves the rows before it alone',
  );

  // A label on an older row, a failed turn, a branch: each is seen, and costs its own rows.
  const labelled = open.messages.find((row) => row.role === 'user')!;
  const marked = await f.call('label-branch', {
    messageId: labelled.id,
    label: 'a mark',
  });
  assert.equal(marked.ok, true, marked.error);
  const shown = f.controller
    .snapshot()
    .sessions.find((row) => row.id === 'open')!;
  assert.equal(
    shown.messages.find((row) => row.id === labelled.id)?.label,
    'a mark',
  );
  assert.ok(
    shown.messages.every(
      (row, index) => row === after.messages[index] || row.id === labelled.id,
    ),
    'only the labelled row is new',
  );
  await f.call('prompt', { text: 'this one fails' });
  await f.turnEnds('run_error');
  assert.ok(
    f.controller
      .snapshot()
      .sessions.find((row) => row.id === 'open')!
      .messages.some((row) => row.text.includes('the model failed')),
  );
  const before = f.main
    .materialize()
    .snapshot.sessions.find((row) => row.id === 'open')!;
  const moved = await f.call('select-branch', { messageId: labelled.id });
  assert.equal(moved.ok, true, moved.error);
  const branch = f.main
    .materialize()
    .snapshot.sessions.find((row) => row.id === 'open')!;
  assert.ok(branch.branchIds?.includes(labelled.id));
  assert.ok(
    (branch.branchIds?.length ?? 0) < (before.branchIds?.length ?? 0),
    'the later rows left the branch',
  );
  assert.equal(
    branch.messages.length,
    before.messages.length,
    'the tree keeps them',
  );
  assert.deepEqual(f.errors, []);
});

test('a subagent, with no runtime of its own, shows what its events did at every publication', async (t) => {
  const f = await setup(t, [
    toolTurn('delegate', 'task', {
      description: 'look it up',
      subagent_type: 'general-purpose',
    }),
    toolTurn('child-read', 'read_file', { file_path: 'a.txt' }),
    answer('child-done', 'the child is done'),
    answer('parent-done', 'the parent heard it'),
  ]);
  f.controller.publish();
  const internals = f.controller as unknown as {
    histories: Map<string, unknown>;
  };
  let agentsSeen = 0;
  f.setObserver((update) => {
    const kept = internals.histories;
    internals.histories = new Map();
    const fresh = f.controller.snapshot();
    internals.histories = kept;
    assert.deepEqual(history(update.snapshot), history(fresh));
    assert.deepEqual(
      history(f.main.materialize().snapshot),
      history(ipc(update.snapshot)),
    );
    if (update.snapshot.agents.length) agentsSeen++;
  });
  const mark = f.sent.length;
  const reply = await f.call('prompt', { text: 'delegate this' });
  assert.equal(reply.ok, true, reply.error);
  await f.turnEnds('run_end', mark);
  assert.ok(agentsSeen > 3, `${agentsSeen} publications with the agent`);
  const agent = f.main.materialize().snapshot.agents[0]!;
  assert.equal(agent.messages.at(-1)?.text, 'the child is done');
  const read = agent.messages.find((row) => row.tool?.name === 'read_file');
  assert.match(read?.tool?.output ?? '', /first/);
  assert.equal(read?.tool?.status, 'success');
  assert.ok(
    f.sent
      .slice(mark)
      .some((update) =>
        update.history?.deltas?.some((delta) => delta.key.startsWith('agent:')),
      ),
    'the agent sent its rows as they came',
  );
});

test('a label or a rename in another session changes only that session, and deleting one drops it', async (t) => {
  const f = await setup(t, []);
  f.controller.publish();
  const stored = new CheckpointStore(f.home);
  const node = stored
    .tree('other-1')
    .find((row) => row.message.role === 'user')!;
  // Another process, as the terminal is: this store's connection writes nothing.
  stored.setLabel('other-1', node.message.id, 'from the terminal');
  stored.append('other-2', [
    { id: 'from-terminal', role: 'user', content: 'typed in the terminal' },
  ]);
  stored.close();
  f.controller.publish();
  const wire = f.sent.at(-1)!;
  assert.deepEqual(wire.history?.deltas?.map((row) => row.key).sort(), [
    'session:other-1',
    'session:other-2',
  ]);
  const added = wire.history!.deltas!.find(
    (row) => row.key === 'session:other-2',
  )!;
  assert.deepEqual(
    added.messages.map((row) => row.text),
    ['typed in the terminal'],
  );
  const held = f.main.materialize().snapshot;
  assert.equal(
    held.sessions
      .find((row) => row.id === 'other-1')!
      .messages.find((row) => row.id === node.id)?.label,
    'from the terminal',
  );
  assert.equal(
    held.sessions.find((row) => row.id === 'other-2')!.messages.at(-1)?.text,
    'typed in the terminal',
  );
  const removed = await f.call(
    'delete-session',
    { id: 'other-2', confirmed: true },
    'open',
  );
  assert.equal(removed.ok, true, removed.error);
  assert.equal(
    f.main.materialize().snapshot.sessions.some((row) => row.id === 'other-2'),
    false,
  );
});

test('a window that missed a publication asks for the state and goes on from there', async (t) => {
  const f = await setup(t, []);
  f.controller.publish();
  const initial = ipc(f.main.materialize());
  const live = new LiveRuntime(f.host, initial);
  t.after(() => live.dispose());
  let asked = 0;
  const state = f.host.runtimeState;
  f.host.runtimeState = () => {
    asked++;
    return state();
  };
  // Not delivered to this window: what it holds for other-1 is now behind.
  const delivered = [...f.runtimeListeners];
  f.runtimeListeners.clear();
  const stored = new CheckpointStore(f.home);
  stored.append('other-1', [
    { id: 'missed', role: 'user', content: 'a message the window missed' },
  ]);
  f.controller.publish();
  stored.append('other-1', [
    { id: 'after', role: 'user', content: 'a message after it' },
  ]);
  stored.close();
  for (const listener of delivered) f.runtimeListeners.add(listener);
  f.controller.publish();
  await until(() => asked === 1, 'the window asks for the state');
  await until(
    () =>
      live.getSnapshot().sessions.find((row) => row.id === 'other-1')!.messages
        .length ===
      f.main
        .materialize()
        .snapshot.sessions.find((row) => row.id === 'other-1')!.messages.length,
    'the window catches up',
  );
  assert.equal(
    live
      .getSnapshot()
      .sessions.find((row) => row.id === 'other-1')!
      .messages.at(-1)?.text,
    'a message after it',
  );
  // And the next publication applies on what the state gave it.
  f.controller.publish();
  assert.equal(asked, 1);
  assert.deepEqual(
    history(live.getSnapshot()),
    history(ipc(f.complete.at(-1)!.snapshot)),
  );
});

test('rows are checked against the revision held, and another worker starts whole', () => {
  const row = (id: string, text: string) => ({
    id,
    parentId: null,
    role: 'user' as const,
    text,
    at: 'fixture',
  });
  const snapshot = (messages: ReturnType<typeof row>[]) =>
    ({
      sessions: [{ id: 'a', messages, branchIds: messages.map((m) => m.id) }],
      agents: [],
    }) as unknown as WorkbenchSnapshot;
  const update = (
    seq: number,
    messages: ReturnType<typeof row>[],
    epoch = 'one',
  ): RuntimeUpdate => ({
    seq,
    connected: true,
    snapshot: snapshot(messages),
    tokenStream: { epoch, seq: 0 },
  });
  const one = row('1', 'first');
  const two = row('2', 'second');
  const compactor = new HistoryCompactor();
  const buffer = new RuntimeTokenBuffer();
  const wire = compactor.compact(update(1, [one]));
  assert.equal(wire.snapshot.sessions[0]!.messages.length, 0);
  assert.equal(wire.history!.deltas![0]!.base, undefined);
  assert.equal(buffer.accept(wire), 'accepted');
  assert.deepEqual(buffer.materialize().snapshot.sessions[0]!.messages, [one]);
  assert.equal(
    buffer.accept(compactor.compact(update(2, [one, two]))),
    'accepted',
  );
  assert.deepEqual(buffer.materialize().snapshot.sessions[0]!.messages, [
    one,
    two,
  ]);

  // The baseline is what is compared, so an equal row built again is not a change.
  const next = compactor.compact(update(3, [{ ...one }, { ...two }]));
  assert.deepEqual(next.history!.deltas, []);
  assert.equal(buffer.accept(next), 'accepted');
  assert.deepEqual(buffer.materialize().snapshot.sessions[0]!.branchIds, [
    '1',
    '2',
  ]);

  // A branch switch: the first row stays, and the one that follows is replaced.
  const other = row('3', 'another branch');
  const switched = compactor.compact(update(4, [one, other]));
  assert.deepEqual(
    switched.history!.deltas!.map((delta) => [delta.keep, delta.messages]),
    [[1, [other]]],
  );
  assert.equal(buffer.accept(switched), 'accepted');
  assert.deepEqual(buffer.materialize().snapshot.sessions[0]!.messages, [
    one,
    other,
  ]);

  // A publication this buffer never saw leaves it behind: it does not guess.
  compactor.compact(update(5, [one, other, two]));
  const behind = compactor.compact(update(6, [one, other, two, row('4', 'x')]));
  assert.equal(buffer.accept(behind), 'history-gap');
  assert.deepEqual(buffer.materialize().snapshot.sessions[0]!.messages, [
    one,
    other,
  ]);
  // The token stream's cursor and baseline did not move with the refused publication.
  assert.equal(buffer.materialize().seq, 4);
  compactor.reset();
  const whole = compactor.compact(update(7, [one, other, two]));
  assert.equal(buffer.accept(whole), 'accepted');
  assert.equal(
    buffer.materialize().snapshot.sessions[0]!.messages.length,
    3,
    'after a reset the next publication is whole, for anyone who lost their place',
  );

  // A new worker's numbers mean nothing here, even when they happen to agree.
  const worker = new HistoryCompactor();
  worker.compact(update(1, [one], 'two'));
  const stranger = worker.compact(update(2, [one, two], 'two'));
  assert.equal(buffer.accept(stranger), 'history-gap');
  const fresh = new HistoryCompactor().compact(update(1, [two], 'two'));
  assert.equal(buffer.accept(fresh), 'accepted');
  assert.deepEqual(buffer.materialize().snapshot.sessions[0]!.messages, [two]);

  // A publication with no history field, as a window's state reply is, is taken whole.
  assert.deepEqual(
    restoreHistory(update(1, [one]), undefined, new Map())?.update,
    update(1, [one]),
  );
});
