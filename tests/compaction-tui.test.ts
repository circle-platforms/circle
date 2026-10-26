import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { emptyUsage, type Message } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
import { compactionRow } from '../src/tui/status_rows.js';
import { CompactionProgress } from '../src/compaction.js';
import { stripAnsi, stringWidth } from '../src/ink/string_width.js';
import {
  setPalette,
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  palette,
} from '../src/ink/theme.js';

const history = (): Message[] =>
  Array.from({ length: 10 }, (_, n) => ({
    id: 'history-' + n,
    role: n % 2 ? 'assistant' : 'user',
    content: 'synthetic history ' + n,
  }));

test('manual TUI compaction has progress, operation-bound cancellation, one durable notice and keeps raw history', async (t) => {
  const home = scratch(t),
    workspace = scratch(t),
    settings = defaultSettings();
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const model = new ScriptedModel([
    async (request) => {
      request.token('visible summary progress');
      entered();
      await new Promise<void>((_r, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
      return {
        message: { id: 'late', role: 'assistant', content: 'must not commit' },
        usage: emptyUsage(),
      };
    },
  ]);
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  app.terminal = {
    platform: process.platform,
    write: () => {},
    input: () => {},
    kill: () => {},
  };
  await app.attach({ workspace, home, settings, model, headless: true });
  cleanup(t, () => app.close());
  const runtime = app.runtime!;
  runtime.store.append(runtime.session.id, history());
  const before = JSON.stringify(runtime.harness.messages);
  const running = app.command('compact', '');
  await ready;
  ui.repaint();
  const snapshot = runtime.compaction!;
  assert.equal(
    app.state.compaction?.snapshot?.operationId,
    snapshot.operationId,
  );
  assert.equal(app.state.busy, true);
  assert.equal(app.state.busyVerb, 'compacting');
  assert.ok(app.state.busyTokens! > 0);
  await app.command('new', '');
  const other = app.runtime!;
  assert.notEqual(other.session.id, runtime.session.id);
  ui.repaint();
  assert.equal(app.state.compaction, undefined);
  assert.equal(runtime.compaction!.status, 'running');
  await app.command('resume', runtime.session.id);
  ui.repaint();
  const restored = app.state.compaction as CompactionProgress | undefined;
  assert.equal(
    runtime.store.compactions.operations(runtime.session.id).at(-1)!.snapshot
      .status,
    'running',
  );
  assert.equal(restored?.snapshot?.operationId, snapshot.operationId);
  assert.equal(
    model.requests.length,
    1,
    'switching views never resends a summary',
  );
  await runtime.cancel({ compactionOperationId: 'stale' });
  assert.equal(runtime.compaction!.status, 'running');
  ui.handle({ type: 'key', key: 'escape' });
  await running;
  ui.repaint();
  assert.equal(app.state.compaction, undefined);
  assert.equal(runtime.compaction!.status, 'cancelled');
  assert.equal(
    runtime.store.contextState(runtime.session.id).summary,
    undefined,
  );
  assert.equal(JSON.stringify(runtime.harness.messages), before);
  for (let n = 0; n < 3; n++) ui.repaint();
  assert.equal(
    app.state.notices.filter((s) => s.includes('compaction interrupted'))
      .length,
    1,
  );
  assert.deepEqual(
    app.state.notices.filter((s) => s.startsWith('✖')),
    [],
  );
  assert.equal(model.requests.length, 1);
});

test('TUI escape cancels automatic compaction with its turn while preserving the draft and original history', async (t) => {
  const home = scratch(t),
    workspace = scratch(t),
    settings = defaultSettings();
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const model = Object.assign(
    new ScriptedModel([
      async (request) => {
        request.token('synthetic summary progress');
        entered();
        await new Promise<void>((_resolve, reject) =>
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          ),
        );
        return {
          message: {
            id: 'late',
            role: 'assistant',
            content: 'must not activate',
          },
          usage: emptyUsage(),
        };
      },
    ]),
    { contextWindow: 128000, outputLimit: 32000 },
  );
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  app.terminal = {
    platform: process.platform,
    write: () => {},
    input: () => {},
    kill: () => {},
  };
  await app.attach({ workspace, home, settings, model, headless: true });
  cleanup(t, () => app.close());
  const runtime = app.runtime!;
  const raw: Message[] = [
    { id: 'old', role: 'user', content: 'synthetic history '.repeat(40000) },
    {
      id: 'old-answer',
      role: 'assistant',
      content: 'The previous step completed.',
    },
  ];
  runtime.store.append(runtime.session.id, raw);
  const turn = app.submit('Continue this exact task.');
  await ready;
  ui.composer.paste('keep this draft');
  ui.repaint();
  assert.equal(runtime.compaction!.trigger, 'auto');
  assert.equal(app.state.compaction?.snapshot?.status, 'running');
  ui.handle({ type: 'key', key: 'escape' });
  await turn;
  ui.repaint();
  assert.equal(runtime.compaction!.status, 'cancelled');
  assert.equal(runtime.busy, false);
  assert.equal(app.state.compaction, undefined);
  assert.equal(app.state.draft, 'keep this draft');
  assert.equal(model.requests.length, 1);
  const stored = runtime.store.messages(runtime.session.id);
  assert.deepEqual(stored.slice(0, 2), raw);
  assert.equal(
    stored.filter((m) => m.content === 'Continue this exact task.').length,
    1,
  );
  assert.equal(
    runtime.store.contextState(runtime.session.id).summary,
    undefined,
  );
  assert.deepEqual(
    app.state.notices.filter((s) => s.startsWith('✖')),
    [],
  );
  assert.equal(
    app.state.notices.filter((s) => s.includes('compaction interrupted'))
      .length,
    1,
  );
});

test('compaction rows fit narrow and wide terminals in dark and light themes', async (t) => {
  const root = scratch(t);
  const { CheckpointStore } = await import('../src/checkpoint_store.js');
  const { ContextManager } = await import('../src/context_middleware.js');
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  store.append(session.id, history());
  const manager = new ContextManager(store, root);
  await manager.compact(
    session.id,
    new ScriptedModel([
      { message: { id: 'summary', role: 'assistant', content: 'summary' } },
    ]),
    new AbortController().signal,
  );
  const snapshot = manager.compactor.snapshot(session.id)!;
  const progress = new CompactionProgress('tool');
  progress.apply({
    sessionId: session.id,
    trigger: 'tool',
    phase: 'done',
    snapshot,
  });
  const saved = palette();
  cleanup(t, () => setPalette(saved));
  for (const theme of [DEFAULT_DARK, DEFAULT_LIGHT]) {
    setPalette(buildPalette(...theme));
    for (const width of [20, 40, 100])
      assert.ok(
        stringWidth(stripAnsi(compactionRow(progress, width))) <= width,
      );
  }
});
