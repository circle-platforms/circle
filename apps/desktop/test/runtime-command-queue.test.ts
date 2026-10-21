import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  saveSettingsChange,
  trustFolder,
} from '../../../src/settings.ts';
import type {
  RuntimeCommandName,
  RuntimeReply,
  RuntimeUpdate,
} from '../src/runtime-protocol.ts';
import { patience } from './helpers/patience.mjs';

async function wait(check: () => boolean, description: string) {
  const end = Date.now() + patience(8000);
  while (!check()) {
    if (Date.now() > end) throw Error(`timed out: ${description}`);
    await delay(10);
  }
}

async function setup(
  t: TestContext,
  replies: ConstructorParameters<typeof ScriptedModel>[0],
  options: { queueStallMs?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-command-queue-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  await mkdir(join(workspace, '.git'));
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const model = new ScriptedModel(replies);
  const updates: RuntimeUpdate[] = [];
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: (update) => updates.push(update),
    ...options,
  });
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ): Promise<RuntimeReply> =>
    controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, workspace, model, controller, call, updates };
}

/**
 * A hub sign-in waits for the person's password, so its command stays in the
 * queue: the runtime holding one command is what the next one must survive.
 * It comes back in a box because an async function that returns a promise
 * would be waited for before its caller goes on.
 */
async function hubLoginWaiting(
  f: Awaited<ReturnType<typeof setup>>,
): Promise<{ held: Promise<RuntimeReply> }> {
  saveSettingsChange(f.home, (settings) => {
    settings.extensions.hub = { enabled: true };
  });
  assert.equal((await f.call('reload')).ok, true);
  const held = f.call('custom-command', {
    name: 'hub',
    args: 'login http://127.0.0.1:9 tester',
  });
  await wait(
    () =>
      f.controller
        .snapshot()
        .interactions.some(
          (row) => row.kind === 'secret' && row.status === 'pending',
        ),
    'the password card waits for the person',
  );
  return { held };
}

const cancelPasswordCard = async (
  f: Awaited<ReturnType<typeof setup>>,
): Promise<void> => {
  const card = f.controller
    .snapshot()
    .interactions.find(
      (row) => row.kind === 'secret' && row.status === 'pending',
    )!;
  assert.equal(
    (
      await f.call(
        'answer',
        { id: card.id, revision: card.revision, cancel: true },
        card.sessionId,
      )
    ).ok,
    true,
  );
};

test(
  'the next command runs when the runtime has been holding one past the stall',
  { timeout: patience(30000) },
  async (t) => {
    const f = await setup(
      t,
      [{ message: { id: 'a', role: 'assistant', content: 'done' } }],
      { queueStallMs: 100 },
    );
    const { held } = await hubLoginWaiting(f);
    await delay(150);
    const said: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      said.push(args.join(' '));
    });
    const next = await Promise.race([
      f.call('prompt', { text: 'hello' }),
      delay(patience(4000)).then(() => 'stuck' as const),
    ]);
    assert.notEqual(next, 'stuck', 'the command queued behind the held one');
    assert.equal((next as RuntimeReply).ok, true);
    assert.ok(
      said.some((line) =>
        /\[circle] runtime queue released: prompt .*held custom-command/.test(
          line,
        ),
      ),
      'the release is said where the log can keep it',
    );
    await cancelPasswordCard(f);
    assert.equal((await held).ok, true);
  },
);

test(
  'a command held for a moment still keeps its place in front of the next one',
  { timeout: patience(30000) },
  async (t) => {
    const f = await setup(t, [], { queueStallMs: patience(5000) });
    const { held } = await hubLoginWaiting(f);
    let answered = false;
    const next = f.call('prompt', { text: 'hello' }).then(() => {
      answered = true;
    });
    await delay(patience(200));
    assert.equal(answered, false, 'the queue holds while the stall is short');
    await cancelPasswordCard(f);
    await held;
    await next;
  },
);
