// A subagent's steps are published together (#577): the controller's real event path on a
// scripted model, with the publication timer in the test's hands.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import { HistoryCompactor } from '../src/runtime-history-wire.ts';
import { RuntimeTokenBuffer } from '../src/runtime-token-stream.ts';
import type {
  RuntimeCommandName,
  RuntimeTokenDelta,
  RuntimeUpdate,
} from '../src/runtime-protocol.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import type { ModelRequest, ModelResponse } from '../../../src/types.ts';
import { patience } from './helpers/patience.mjs';

const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 };
const reply = (
  content: string,
  call?: { id: string; name: string; args: Record<string, unknown> },
) => ({
  message: {
    id: randomUUID(),
    role: 'assistant' as const,
    content,
    ...(call ? { tool_calls: [call] } : {}),
  },
  usage,
});

// A held reply that a closing controller still stops, so that a failed check ends the test.
async function hold(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  await Promise.race([
    gate,
    new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    ),
  ]);
  signal.throwIfAborted();
}

async function setup(
  t: TestContext,
  replies: ConstructorParameters<typeof ScriptedModel>[0],
) {
  const root = realpathSync.native(
    await mkdtemp(join(tmpdir(), 'circle-publish-coalescing-')),
  );
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(join(workspace, '.git'), { recursive: true });
  await writeFile(join(workspace, 'a.txt'), 'first\n');
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const model = new ScriptedModel(replies);
  // What the windows were sent, in order, and what the main process's buffer made of it.
  const log: ({ update: RuntimeUpdate } | { delta: RuntimeTokenDelta })[] = [];
  const results: string[] = [];
  const compactor = new HistoryCompactor();
  const main = new RuntimeTokenBuffer();
  const scheduled: { run: () => void; cancelled: boolean; ran: boolean }[] = [];
  let overlapping = 0;
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: (update) => {
      log.push({ update });
      results.push(main.accept(structuredClone(compactor.compact(update))));
    },
    emitTokenDelta: (delta) => {
      log.push({ delta });
      results.push(main.apply(structuredClone(delta)));
    },
    schedulePublish: (run) => {
      if (scheduled.some((entry) => !entry.cancelled && !entry.ran))
        overlapping++;
      const entry = {
        run: () => {
          entry.ran = true;
          run();
        },
        cancelled: false,
        ran: false,
      };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = (name: RuntimeCommandName, payload = {}) =>
    controller.dispatch({
      id: randomUUID(),
      name,
      payload,
      sessionId: controller.snapshot().activeSessionId,
    });
  const updates = () =>
    log.flatMap((entry) => ('update' in entry ? [entry.update] : []));
  const until = async (check: () => boolean, description: string) => {
    const end = Date.now() + patience(10_000);
    while (!check()) {
      if (Date.now() > end) throw Error(`timed out: ${description}`);
      await delay(5);
    }
  };
  return {
    workspace,
    model,
    controller,
    call,
    log,
    results,
    main,
    scheduled,
    waiting: () => scheduled.filter((entry) => !entry.cancelled && !entry.ran),
    get overlapping() {
      return overlapping;
    },
    updates,
    until,
  };
}

test("a subagent's steps publish together; its start, end and a file change publish at once", async (t) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const f = await setup(t, [
    reply('', {
      id: 'delegate',
      name: 'task',
      args: { description: 'write the note', subagent_type: 'general-purpose' },
    }),
    // Each reply with words streams them: the subagent's streams follow each other.
    reply('first a look', {
      id: 'child-read-1',
      name: 'read_file',
      args: { file_path: 'a.txt' },
    }),
    reply('a second look', {
      id: 'child-read-2',
      name: 'read_file',
      args: { file_path: 'a.txt' },
    }),
    async (request) => {
      await hold(released, request.signal);
      request.token('then the note');
      return reply('then the note', {
        id: 'child-write',
        name: 'write_file',
        args: { file_path: 'b.txt', content: 'written by the subagent\n' },
      });
    },
    reply('the child is done'),
    reply('the parent heard it'),
  ]);
  const session = f.controller.snapshot().activeSessionId;
  // Its write needs no card: an approval publishes at once on its own.
  assert.equal((await f.call('set-mode', { mode: 'auto' })).ok, true);
  assert.equal((await f.call('prompt', { text: 'delegate this' })).ok, true);
  await f.until(() => f.model.requests.length === 4, 'the third step asks');
  const child = f.controller
    .snapshot()
    .agents.find((agent) => agent.sessionId === session)!.id;
  const reads = () =>
    f.main
      .materialize()
      .snapshot.agents.find((agent) => agent.id === child)!
      .messages.filter(
        (row) =>
          row.tool?.name === 'read_file' && row.tool.status === 'success',
      );

  // The second look's steps wait for one publication; when it comes, it shows them.
  assert.equal(reads().length, 1);
  const pending = f.waiting();
  assert.equal(pending.length, 1);
  const before = f.updates().length;
  pending[0]!.run();
  assert.equal(f.updates().length, before + 1);
  assert.equal(f.updates().at(-1)!.event, undefined);
  assert.equal(reads().length, 2);
  assert.match(reads()[1]!.tool?.output ?? '', /first/);

  release();
  await f.until(
    () =>
      f
        .updates()
        .some(
          (update) =>
            update.event?.kind === 'run_end' &&
            update.event.sessionId === session,
        ),
    'the parent turn ends',
  );
  assert.equal(f.model.requests.length, 6);
  assert.equal(
    await readFile(join(f.workspace, 'b.txt'), 'utf8'),
    'written by the subagent\n',
  );
  // Of the subagent's events only these were published, each at once and with its event.
  assert.deepEqual(
    f
      .updates()
      .filter((update) => update.event?.sessionId === child)
      .map((update) => [update.event!.kind, update.event!.payload.name]),
    [
      ['run_start', undefined],
      ['tool_result', 'write_file'],
      ['run_end', undefined],
    ],
  );
  assert.equal(f.overlapping, 0, 'one publication waits at a time');
  assert.deepEqual(f.waiting(), [], 'a later publication replaced the rest');

  // Its tokens went as deltas, and the main process applied every one. The second stream
  // followed steps still waiting: a publication without an event ended the first.
  const firsts: number[] = [];
  f.log.forEach((entry, index) => {
    if (!('delta' in entry) || entry.delta.sessionId !== child) return;
    const previous = firsts.at(-1);
    if (
      previous === undefined ||
      (f.log[previous] as { delta: RuntimeTokenDelta }).delta.streamId !==
        entry.delta.streamId
    )
      firsts.push(index);
  });
  assert.equal(firsts.length, 4);
  const flush = f.log[firsts[1]! - 1]!;
  assert.ok('update' in flush && flush.update.event === undefined);
  assert.deepEqual(
    f.results.filter((result) => result !== 'applied' && result !== 'accepted'),
    [],
  );
  const agent = f.main
    .materialize()
    .snapshot.agents.find((item) => item.id === child)!;
  assert.equal(agent.messages.at(-1)?.text, 'the child is done');
  assert.equal(agent.status, 'completed');
});

test("a publication that carried a subagent's stream is ended before its next stream starts", async (t) => {
  let f!: Awaited<ReturnType<typeof setup>>;
  let streaming: (string | undefined)[] = [];
  f = await setup(t, [
    reply('', {
      id: 'delegate',
      name: 'task',
      args: { description: 'look twice', subagent_type: 'general-purpose' },
    }),
    // Another publication lands after the first stream's last token and before its end,
    // which is a step that waits: that publication carries the stream as still open.
    // (Its reply's own text is empty: the scripted model would stream that after it.)
    async (request) => {
      request.token('first look');
      f.controller.publish();
      return reply('', {
        id: 'child-read',
        name: 'read_file',
        args: { file_path: 'a.txt' },
      });
    },
    async (request) => {
      request.token('second look');
      // What the windows show of the subagent while its second stream starts.
      const agent = f.main
        .materialize()
        .snapshot.agents.find((item) => item.status === 'running');
      streaming = (agent?.messages ?? [])
        .filter((row) => row.at === 'streaming')
        .map((row) => row.text);
      return reply('second look');
    },
    reply('the parent heard it'),
  ]);
  const session = f.controller.snapshot().activeSessionId;
  assert.equal((await f.call('prompt', { text: 'delegate this' })).ok, true);
  await f.until(
    () =>
      f
        .updates()
        .some(
          (update) =>
            update.event?.kind === 'run_end' &&
            update.event.sessionId === session,
        ),
    'the parent turn ends',
  );
  const child = f.controller
    .snapshot()
    .agents.find((agent) => agent.sessionId === session)!.id;
  // Every delta reached a buffer that held its stream, so none asked for the state.
  assert.deepEqual(
    f.results.filter((result) => result !== 'applied' && result !== 'accepted'),
    [],
  );
  const second = f.log.findIndex(
    (entry) =>
      'delta' in entry &&
      entry.delta.sessionId === child &&
      entry.delta.text === 'second look',
  );
  assert.ok(second > 0);
  assert.ok('update' in f.log[second - 1]!, 'a publication came first');
  assert.deepEqual(streaming, ['second look'], 'the first stream is not left');
  const agent = f.main
    .materialize()
    .snapshot.agents.find((item) => item.id === child)!;
  assert.equal(agent.messages.at(-1)?.text, 'second look');
});

test('a background subagent publishes its job progress later, and nothing is published after close', async (t) => {
  let parentDone!: () => void;
  const parentEnded = new Promise<void>((resolve) => (parentDone = resolve));
  let holding = false;
  // Requests of the parent and of its background subagent come in either order.
  const route = async (request: ModelRequest): Promise<ModelResponse> => {
    const users = request.messages.filter(
      (message) => message.role === 'user' && !message.internal,
    );
    if (users[0]!.content === 'background look') {
      // Its step comes after the parent's turn, so that nothing else publishes meanwhile.
      if (!request.messages.some((message) => message.role === 'tool')) {
        await hold(parentEnded, request.signal);
        return reply('', {
          id: 'child-read',
          name: 'read_file',
          args: { file_path: 'a.txt' },
        });
      }
      // Held until the controller closes, which stops it.
      holding = true;
      await hold(new Promise<void>(() => {}), request.signal);
      throw Error('unreachable');
    }
    return request.messages.some((message) => message.role === 'tool')
      ? reply('started it')
      : reply('', {
          id: 'delegate',
          name: 'task',
          args: {
            description: 'background look',
            subagent_type: 'general-purpose',
            background: true,
          },
        });
  };
  const f = await setup(
    t,
    Array.from({ length: 6 }, () => route),
  );
  assert.equal(
    (await f.call('prompt', { text: 'look in the background' })).ok,
    true,
  );
  await f.until(
    () => f.controller.snapshot().sessions[0]!.state === 'idle',
    'the parent turn ends',
  );
  parentDone();
  await f.until(() => holding, 'the subagent waits on its second step');
  const job = f.controller
    .snapshot()
    .jobs.find((item) => item.kind === 'agent')!;
  assert.equal(job.state, 'running');
  assert.ok(
    f.updates().some((update) => update.event?.kind === 'job_started'),
    'a job starting is published at once',
  );
  // The job's log moved with the step; that waits for the next publication.
  assert.ok(
    f.updates().every((update) => update.event?.kind !== 'job_updated'),
  );
  const pending = f.waiting();
  assert.equal(pending.length, 1, 'one publication waits');

  const published = f.updates().length;
  await f.controller.close();
  assert.equal(pending[0]!.cancelled, true, 'closing cancels it');
  // A timer that fired anyway would publish nothing either.
  pending[0]!.run();
  assert.equal(f.updates().length, published);
});
