// What one runtime publication costs at each stage, against stored history. The real
// RuntimeController and LiveRuntime on a scripted model and a scratch home; never real
// Circle data. Run it as:
//   node --import tsx apps/desktop/scripts/benchmark-publish.ts --sessions 40 --messages 1000
// Native IPC, contextBridge and paint are measured by benchmark-publish-native.mjs.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { deserialize, serialize } from 'node:v8';
import { RuntimeController } from '../src/runtime-controller.ts';
import { HistoryCompactor } from '../src/runtime-history-wire.ts';
import { publishBenchmarkMessages } from './publish-benchmark-fixture.mjs';
import { RuntimeTokenBuffer } from '../src/runtime-token-stream.ts';
import { LiveRuntime } from '../../workbench/src/model/live.ts';
import type { RuntimeUpdate } from '../src/runtime-protocol.ts';
import type { DesktopBridge } from '../src/contracts.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { ScriptedModel } from '../../../src/testing.ts';

const option = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
};
const sessions = option('sessions', 10);
const messages = option('messages', 300);
const publishes = option('publishes', 20);
const toolCalls = option('tool-calls', 10);

const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * q))
  ] ?? 0;
const summary = (values: number[]) => ({
  p50: Number(quantile(values, 0.5).toFixed(2)),
  p95: Number(quantile(values, 0.95).toFixed(2)),
});
const timed = <T>(run: () => T): [T, number] => {
  const start = performance.now();
  const value = run();
  return [value, performance.now() - start];
};

const root = await mkdtemp(join(tmpdir(), 'circle-benchmark-publish-'));
const home = join(root, 'home');
const workspace = join(root, 'workspace');
await mkdir(home);
await mkdir(join(workspace, '.git'), { recursive: true });
await writeFile(join(workspace, 'note.txt'), 'benchmark file\n');
saveSettings(trustFolder(defaultSettings(), workspace), home);

const selected = 'benchmark-session-0';
const store = new CheckpointStore(home);
for (let index = sessions - 1; index >= 0; index--) {
  const id = `benchmark-session-${index}`;
  store.create(workspace, 'fixture', `session ${index}`, id);
  store.append(id, publishBenchmarkMessages(id, messages));
}
store.close();
await writeFile(
  join(home, 'desktop-session.json'),
  JSON.stringify({ workspace, sessionId: selected }),
);

const replies = [
  ...Array.from({ length: toolCalls }, (_, index) => ({
    message: {
      id: `benchmark-turn-${index}`,
      role: 'assistant' as const,
      content: '',
      tool_calls: [
        {
          id: `benchmark-call-${index}`,
          name: 'read_file',
          args: { file_path: 'note.txt' },
        },
      ],
    },
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
  })),
  {
    message: {
      id: 'benchmark-turn-end',
      role: 'assistant' as const,
      content: 'done',
    },
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
  },
];

const updates: RuntimeUpdate[] = [];
let forward: (update: RuntimeUpdate) => void = () => {};
const controller = new RuntimeController({
  home,
  workspace,
  userHome: home,
  // Wide enough that the stored history never makes this turn compact.
  model: Object.assign(new ScriptedModel(replies), {
    contextWindow: 1_000_000_000,
  }),
  emit: (update) => {
    updates.push(update);
    forward(update);
  },
});

// What the worker sends for each publication, and what the main process holds of it.
const history = new HistoryCompactor();
const main = new RuntimeTokenBuffer();
main.accept(history.compact(controller.publish()!));

// A window as the desktop has one: the real LiveRuntime, started from the main process's
// state as a window is, receives every update.
const listeners = new Set<(update: RuntimeUpdate) => void>();
const host = {
  onRuntime: (listener: (update: RuntimeUpdate) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  onRuntimeDelta: () => () => {},
  onRuntimeWait: () => () => {},
  runtimeState: async () => main.materialize(),
} as unknown as DesktopBridge;
const live = new LiveRuntime(host, main.materialize());
const liveReceive = (update: RuntimeUpdate) => {
  for (const listener of listeners) listener(update);
};

const measure = (complete: RuntimeUpdate) => {
  const [update, compactMs] = timed(() => history.compact(complete));
  // Two hops in the application: worker to main, main to renderer.
  const [bytes, serializeMs] = timed(() => serialize(update));
  const [copy, deserializeMs] = timed(() => deserialize(bytes));
  const [accepted, mainMs] = timed(() => main.accept(copy as RuntimeUpdate));
  if (accepted !== 'accepted') throw Error(`main process: ${accepted}`);
  const [, receiveMs] = timed(() => liveReceive(deserialize(bytes)));
  return {
    bytes: bytes.length,
    compactMs,
    serializeMs,
    deserializeMs,
    receiveMs: receiveMs + mainMs,
  };
};

const rows = {
  publish: [] as number[],
  bytes: [] as number[],
  serialize: [] as number[],
  deserialize: [] as number[],
  receive: [] as number[],
};
for (let index = 0; index < publishes; index++) {
  const [update, publishMs] = timed(() => controller.publish()!);
  const stage = measure(update);
  rows.publish.push(publishMs + stage.compactMs);
  rows.bytes.push(stage.bytes);
  rows.serialize.push(stage.serializeMs);
  rows.deserialize.push(stage.deserializeMs);
  rows.receive.push(stage.receiveMs);
}

// A turn with tool calls, as the desktop runs one: every update goes through the stages.
const turn = {
  updates: 0,
  bytes: 0,
  publishMs: 0,
  ipcMs: 0,
  receiveMs: 0,
  kinds: {} as Record<string, number>,
};
let stagesMs = 0;
const realPublish = controller.publish.bind(controller);
controller.publish = (event) => {
  const start = performance.now();
  const before = stagesMs;
  const update = realPublish(event);
  // What the update costs after it leaves the runtime is counted in its own stage.
  turn.publishMs += performance.now() - start - (stagesMs - before);
  return update;
};
let ended = false;
forward = (update) => {
  const start = performance.now();
  const stage = measure(update);
  stagesMs += performance.now() - start;
  turn.updates++;
  turn.bytes += stage.bytes;
  turn.publishMs += stage.compactMs;
  turn.ipcMs += 2 * (stage.serializeMs + stage.deserializeMs);
  turn.receiveMs += stage.receiveMs;
  const kind = update.event?.kind ?? 'none';
  turn.kinds[kind] = (turn.kinds[kind] ?? 0) + 1;
  if (kind === 'run_end' || kind === 'run_error') ended = true;
};
const turnStart = performance.now();
const reply = await controller.dispatch({
  id: 'benchmark-prompt',
  name: 'prompt',
  sessionId: selected,
  payload: { text: 'read the note' },
});
if (!reply.ok) throw Error(reply.error);
const end = Date.now() + 120_000;
while (!ended) {
  if (Date.now() > end) throw Error('benchmark turn did not end');
  await new Promise((done) => setTimeout(done, 5));
}
const turnMs = performance.now() - turnStart;
forward = () => {};

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const perStage = {
  publishMs: summary(rows.publish),
  // Serialized and read back twice: worker to main, main to renderer.
  ipcMs: summary(
    rows.serialize.map((ms, i) => 2 * (ms + rows.deserialize[i]!)),
  ),
  liveRuntimeReceiveMs: summary(rows.receive),
};
console.log(
  JSON.stringify(
    {
      benchmark: 'desktop runtime publication, Node stages',
      sessions,
      messagesPerSession: messages,
      idlePublish: {
        publishes,
        bytes: Math.round(sum(rows.bytes) / publishes),
        ...perStage,
      },
      toolTurn: {
        toolCalls,
        updates: turn.updates,
        kinds: turn.kinds,
        megabytesPerTurn: Number((turn.bytes / 1024 / 1024).toFixed(2)),
        wallMs: Math.round(turnMs),
        // Time inside the runtime, without the stages the benchmark itself adds to the wall.
        publishMs: Math.round(turn.publishMs),
        ipcMs: Math.round(turn.ipcMs),
        liveRuntimeReceiveMs: Math.round(turn.receiveMs),
      },
      excluded: [
        'Electron IPC itself, contextBridge copy and React render: see benchmark-publish-native.mjs',
      ],
    },
    null,
    2,
  ),
);
live.dispose();
await controller.close();
await rm(root, { recursive: true, force: true });
