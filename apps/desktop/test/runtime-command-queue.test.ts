import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
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
 * An extension's secret prompt holds its command in the queue. Return the
 * pending reply in an object so the helper does not await it before its caller.
 */
async function secretCommandWaiting(
  f: Awaited<ReturnType<typeof setup>>,
): Promise<{ held: Promise<RuntimeReply> }> {
  const folder = join(f.home, 'extensions', 'lab');
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, 'extension.mjs'),
    `export function register(api){api.registerCommand('lab','Sign in to the lab',async(args,ctx)=>{const password=await api.askSecret('password for '+(args||'the lab'));ctx.append(password===null?'not signed in':'signed in')})}`,
  );
  assert.equal((await f.call('reload')).ok, true);
  const held = f.call('custom-command', {
    name: 'lab',
    args: 'tester',
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
  'a command the runtime holds keeps its place in front of the next one',
  { timeout: patience(30000) },
  async (t) => {
    const f = await setup(t, []);
    const { held } = await secretCommandWaiting(f);
    let answered = false;
    const next = f.call('prompt', { text: 'hello' }).then(() => {
      answered = true;
    });
    await delay(patience(200));
    assert.equal(answered, false, 'the next command waits behind the held one');
    await cancelPasswordCard(f);
    await held;
    await next;
  },
);
