import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import type {
  RuntimeCommand,
  RuntimeReply,
  RuntimeUpdate,
  RuntimeTokenDelta,
} from '../src/runtime-protocol.ts';
import type { DesktopBridge } from '../src/contracts.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { LiveRuntime } from '../../workbench/src/model/live.ts';

type Delivery =
  | 'normal'
  | 'drop'
  | 'unrelated-before'
  | 'newer-after'
  | 'legacy'
  | 'tokens-only';
async function fixture(t: TestContext, count = 64) {
  const temp = await mkdtemp(join(tmpdir(), 'circle-runtime-ack-'));
  const home = join(temp, 'home'),
    workspace = join(temp, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const seed = new CheckpointStore(home);
  seed.create(workspace, 'scripted', 'history', 'history');
  const original = Array.from({ length: count }, (_, n) => ({
    id: 'message-' + n,
    role: n % 2 ? ('assistant' as const) : ('user' as const),
    content: 'stored history ' + n,
  }));
  seed.append('history', original);
  seed.create(workspace, 'scripted', 'alternate', 'alternate');
  seed.append('alternate', [
    { id: 'alternate-user', role: 'user', content: 'actual alternate history' },
  ]);
  seed.close();
  await writeFile(
    join(home, 'desktop-session.json'),
    JSON.stringify({ workspace, sessionId: 'history' }),
  );
  const model = new ScriptedModel();
  let delivery: Delivery = 'normal',
    pulls = 0;
  let latest!: RuntimeUpdate;
  let receive: ((update: RuntimeUpdate) => void) | undefined;
  let delta: ((update: RuntimeTokenDelta) => void) | undefined;
  const withheld: RuntimeUpdate[] = [];
  const replies: RuntimeReply[] = [];
  const controllers: RuntimeController[] = [];
  const create = () => {
    const value = new RuntimeController({
      home,
      workspace,
      userHome: home,
      model,
      emit(update) {
        latest = update;
        if (
          delivery === 'normal' ||
          delivery === 'legacy' ||
          delivery === 'newer-after'
        )
          receive?.(structuredClone(update));
        else withheld.push(update);
      },
    });
    controllers.push(value);
    return value;
  };
  let controller = create();
  controller.publish();
  const initial = structuredClone(latest);
  const host = {
    onRuntime(listener: (update: RuntimeUpdate) => void) {
      receive = listener;
      return () => {
        receive = undefined;
      };
    },
    onRuntimeDelta(listener: (update: RuntimeTokenDelta) => void) {
      delta = listener;
      return () => {
        delta = undefined;
      };
    },
    async runtimeState() {
      pulls++;
      return structuredClone(latest);
    },
    async runtimeCommand(command: RuntimeCommand) {
      if (delivery === 'unrelated-before') {
        controller.publish();
        receive?.(structuredClone(latest));
      }
      if (delivery === 'tokens-only')
        delta?.({
          epoch: initial.tokenStream!.epoch,
          seq: 1,
          baseSeq: initial.seq,
          sessionId: 'history',
          streamId: 'transport-only-stream',
          parentId: null,
          text: 'unacknowledged transport chunk',
          at: 'streaming',
        });
      const reply = await controller.dispatch(command);
      replies.push(reply);
      if (delivery === 'newer-after') controller.publish();
      return structuredClone(
        delivery === 'legacy' ? { ...reply, appliedState: undefined } : reply,
      );
    },
  } as unknown as DesktopBridge;
  let live = new LiveRuntime(host, initial);
  t.after(async () => {
    live.dispose();
    for (const value of controllers) await value.close();
    await rm(temp, { recursive: true, force: true });
  });
  return {
    get live() {
      return live;
    },
    model,
    original,
    initial,
    replies,
    withheld,
    get controller() {
      return controller;
    },
    get latest() {
      return latest;
    },
    get pulls() {
      return pulls;
    },
    setDelivery(mode: Delivery) {
      delivery = mode;
    },
    deliverWithheld() {
      for (const update of withheld) receive?.(structuredClone(update));
    },
    reloadRenderer() {
      live.dispose();
      live = new LiveRuntime(host, structuredClone(latest));
    },
    async restart() {
      await controller.close();
      controller = create();
      controller.publish();
    },
    assertHistory() {
      const projected = live
        .getSnapshot()
        .sessions.find((s) => s.id === 'history')!;
      assert.deepEqual(
        projected.messages.map((m) => m.text),
        original.map((m) => m.content),
      );
      const store = (controller as unknown as { store: CheckpointStore }).store;
      assert.deepEqual(store.messages('history'), original);
      assert.equal(
        model.requests.length,
        0,
        'navigation must not execute or replay a model request',
      );
    },
  };
}

test('a ten thousand row full publication acknowledges actual navigation and skips only its duplicate state pull', async (t) => {
  const value = await fixture(t, 10000);
  await value.live.selectSession('alternate');
  assert.equal(value.live.getSnapshot().activeSessionId, 'alternate');
  assert.equal(value.pulls, 0);
  assert.deepEqual(value.replies[0]!.appliedState, {
    epoch: value.latest.tokenStream!.epoch,
    seq: value.latest.seq,
  });
  value.assertHistory();
});

test('missing and late full publications fall back to authoritative state and do not erase messages', async (t) => {
  const value = await fixture(t);
  value.setDelivery('drop');
  await value.live.selectSession('alternate');
  assert.equal(value.pulls, 1);
  assert.equal(value.live.getSnapshot().activeSessionId, 'alternate');
  value.deliverWithheld();
  assert.equal(value.live.getSnapshot().activeSessionId, 'alternate');
  value.assertHistory();
});

test('an unrelated sequence increase before the command publication cannot acknowledge its effects', async (t) => {
  const value = await fixture(t);
  value.setDelivery('unrelated-before');
  await value.live.selectSession('alternate');
  assert.equal(value.pulls, 1);
  assert.equal(value.replies[0]!.appliedState!.seq, value.initial.seq + 2);
  assert.equal(value.live.getSnapshot().activeSessionId, 'alternate');
  value.assertHistory();
});

test('a newer authoritative full publication in the same epoch covers the earlier command acknowledgement', async (t) => {
  const value = await fixture(t);
  value.setDelivery('newer-after');
  await value.live.selectSession('alternate');
  assert.equal(value.pulls, 0);
  assert(value.latest.seq > value.replies[0]!.appliedState!.seq);
  assert.equal(value.live.getSnapshot().activeSessionId, 'alternate');
  value.assertHistory();
});

test('a restarted runtime with a lower sequence and a new epoch always requires the missing full state', async (t) => {
  const value = await fixture(t);
  await value.live.selectSession('alternate');
  await value.live.selectSession('history');
  const before = value.latest;
  value.setDelivery('drop');
  await value.restart();
  await value.live.selectSession('alternate');
  const marker = value.replies.at(-1)!.appliedState!;
  assert(marker.seq < before.seq);
  assert.notEqual(marker.epoch, before.tokenStream!.epoch);
  assert.equal(value.pulls, 1);
  assert.equal(value.live.getSnapshot().activeSessionId, 'alternate');
  value.assertHistory();
});

test('old replies without acknowledgements and failed commands retain conservative full-state fallback', async (t) => {
  const value = await fixture(t);
  value.setDelivery('legacy');
  await value.live.selectSession('alternate');
  assert.equal(value.pulls, 1);
  value.setDelivery('normal');
  await assert.rejects(
    value.live.selectSession('missing-session'),
    /session not found/,
  );
  assert.equal(value.pulls, 2);
  assert.equal(value.replies.at(-1)!.appliedState, undefined);
  assert.equal(value.live.getSnapshot().activeSessionId, 'alternate');
  value.assertHistory();
});

test('a token cursor cannot substitute for the missing full publication', async (t) => {
  const value = await fixture(t);
  value.setDelivery('tokens-only');
  await value.live.selectSession('alternate');
  assert.equal(value.pulls, 1);
  assert.equal(value.live.getSnapshot().activeSessionId, 'alternate');
  value.assertHistory();
});

test('a repeated operation retains its original publication identity without replaying navigation', async (t) => {
  const value = await fixture(t);
  const command: RuntimeCommand = {
    id: randomUUID(),
    name: 'select-session',
    sessionId: 'history',
    payload: { id: 'alternate' },
  };
  const first = await value.controller.dispatch(command);
  assert(first.appliedState);
  await value.controller.dispatch({
    id: randomUUID(),
    name: 'select-session',
    sessionId: 'alternate',
    payload: { id: 'history' },
  });
  const latest = value.latest;
  const duplicate = await value.controller.dispatch(command);
  assert.deepEqual(duplicate.appliedState, first.appliedState);
  assert.equal(value.latest.seq, latest.seq);
  assert.equal(value.latest.snapshot.activeSessionId, 'history');
  value.assertHistory();
});

test('renderer reload cannot reuse a disposed instance receipt for a later dropped publication', async (t) => {
  const value = await fixture(t);
  await value.live.selectSession('alternate');
  assert.equal(value.pulls, 0);
  value.reloadRenderer();
  value.setDelivery('drop');
  await value.live.selectSession('history');
  assert.equal(value.pulls, 1);
  assert.equal(value.live.getSnapshot().activeSessionId, 'history');
  value.assertHistory();
});
