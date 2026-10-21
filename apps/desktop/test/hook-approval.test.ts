import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
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
import { canonicalPath } from '../../../src/paths.ts';
import type { RuntimeCommandName } from '../src/runtime-protocol.ts';
import { patience } from './helpers/patience.mjs';

async function wait(check: () => boolean, description: string) {
  const end = Date.now() + patience(8000);
  while (!check()) {
    if (Date.now() > end) throw Error(`timed out: ${description}`);
    await delay(10);
  }
}
const reply = (content: string) => ({
  message: { id: randomUUID(), role: 'assistant' as const, content },
});
/** A trusted workspace whose project hooks file has a session_start hook that speaks. */
async function setup(t: TestContext) {
  const root = realpathSync.native(
    await mkdtemp(join(tmpdir(), 'circle-desktop-hooks-')),
  );
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(join(workspace, '.circle'), { recursive: true });
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const file = join(workspace, '.circle', 'hooks.json');
  const write = async (text: string) => {
    const script = join(workspace, 'say.mjs');
    await writeFile(script, `process.stdout.write(${JSON.stringify(text)});\n`);
    await writeFile(
      file,
      JSON.stringify({
        hooks: {
          session_start: [
            {
              name: 'greet',
              command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(text)}`,
            },
          ],
        },
      }),
    );
  };
  await write('hook says hi');
  const model = new ScriptedModel([reply('one'), reply('two'), reply('three')]);
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: () => {},
  });
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ) => controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return { home, workspace, file, write, model, controller, call };
}
const waiting = (f: Awaited<ReturnType<typeof setup>>) =>
  f.controller
    .snapshot()
    .interactions.find(
      (row) => row.kind === 'hooks' && row.status === 'pending',
    );

test('the desktop asks about a project hooks file in the conversation; approving runs that version, skipping leaves it off and says so', async (t) => {
  const f = await setup(t);
  // Settings names the file that waits.
  assert.deepEqual(f.controller.snapshot().settings.projectHooksWaiting, [
    f.file,
  ]);
  assert.equal(
    (await f.call('prompt', { text: 'hello' })).ok,
    true,
    'prompt accepted',
  );
  await wait(() => Boolean(waiting(f)), 'hooks card');
  const card = waiting(f)!;
  assert.equal(card.target, f.file);
  assert.deepEqual(card.choices, ['approve', 'skip']);
  assert.deepEqual(
    card.hooks?.map((hook) => [hook.name, hook.event, hook.mark]),
    [['greet', 'session_start', 'new']],
  );
  // No request went out while the card waited.
  assert.equal(f.model.requests.length, 0);
  assert.equal(
    (
      await f.call('answer', {
        id: card.id,
        revision: card.revision,
        answer: 'always',
      })
    ).ok,
    false,
    'an approval card answer is not a hooks answer',
  );
  assert.equal(
    (
      await f.call('answer', {
        id: card.id,
        revision: card.revision,
        answer: 'approve',
      })
    ).ok,
    true,
  );
  await wait(() => f.model.requests.length === 1, 'first request');
  assert.match(f.model.requests[0]!.system, /hook says hi/);
  const stored = JSON.parse(
    await readFile(join(f.home, 'hook-trust.json'), 'utf8'),
  ) as { files: Record<string, { digest: string }> };
  assert.equal(typeof stored.files[canonicalPath(f.file)]?.digest, 'string');
  await wait(
    () =>
      f.controller
        .snapshot()
        .sessions.find(
          (row) => row.id === f.controller.snapshot().activeSessionId,
        )?.state === 'idle',
    'first turn',
  );

  // The file changes. A new conversation asks again, and skip keeps it off.
  await f.write('changed words');
  assert.equal((await f.call('new-session')).ok, true);
  assert.equal((await f.call('prompt', { text: 'again' })).ok, true);
  await wait(() => Boolean(waiting(f)), 'second hooks card');
  const changed = waiting(f)!;
  assert.deepEqual(
    changed.hooks?.map((hook) => [hook.name, hook.mark]),
    [['greet', 'changed']],
  );
  assert.equal(
    (
      await f.call('answer', {
        id: changed.id,
        revision: changed.revision,
        answer: 'skip',
      })
    ).ok,
    true,
  );
  await wait(() => f.model.requests.length === 2, 'second request');
  assert.doesNotMatch(
    f.model.requests[1]!.system,
    /changed words|hook says hi/,
  );
  const session = f.controller
    .snapshot()
    .sessions.find(
      (row) => row.id === f.controller.snapshot().activeSessionId,
    )!;
  await wait(
    () =>
      f.controller
        .snapshot()
        .sessions.find((row) => row.id === session.id)!
        .messages.some((message) => message.hookNotice?.kind === 'changed'),
    'the transcript says the hooks did not run',
  );
  const notice = f.controller
    .snapshot()
    .sessions.find((row) => row.id === session.id)!
    .messages.find((message) => message.hookNotice?.kind === 'changed')!;
  assert.equal(notice.hookNotice?.name, '.circle/hooks.json');
  assert.equal(
    JSON.parse(await readFile(join(f.home, 'hook-trust.json'), 'utf8')).files[
      canonicalPath(f.file)
    ].digest,
    stored.files[canonicalPath(f.file)]!.digest,
    'skipping does not approve',
  );
  assert.equal(existsSync(f.file), true);
});
