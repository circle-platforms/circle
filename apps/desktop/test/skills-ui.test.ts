import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import type { RuntimeCommandName } from '../src/runtime-protocol.ts';

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'circle-skill-ui-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  await mkdir(join(workspace, '.git'));
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model: new ScriptedModel([]),
    emit: () => {},
  });
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
  ) =>
    controller.dispatch({
      id: randomUUID(),
      name,
      payload,
      sessionId: controller.snapshot().activeSessionId,
    });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return { workspace, controller, call };
}

test('the skill that ships with Circle is listed as bundled until a project skill of the same name replaces it', async (t) => {
  const { workspace, controller, call } = await setup(t);
  const shipped = controller
    .snapshot()
    .skills.find((skill) => skill.name === 'create-pr');
  assert.ok(shipped, 'create-pr is listed');
  assert.equal(shipped.scope, 'bundled');
  assert.match(
    shipped.path,
    /[\\/]builtin_skills[\\/]create-pr[\\/]SKILL\.md$/,
  );
  assert.match(shipped.content, /^<skill_content name="create-pr">/);
  assert.match(shipped.content, /gh pr create --draft/);
  const created = await call('create-skill', {
    name: 'create-pr',
    description: 'Our own pull requests',
    body: 'Use the release train.',
  });
  assert.equal(created.ok, true, created.error);
  const replaced = controller
    .snapshot()
    .skills.filter((skill) => skill.name === 'create-pr');
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]!.scope, 'project');
  assert.equal(replaced[0]!.description, 'Our own pull requests');
  assert.ok(
    replaced[0]!.path.endsWith(
      join('.circle', 'skills', 'create-pr', 'SKILL.md'),
    ),
  );
  assert.match(replaced[0]!.content, /Use the release train\./);
  assert.ok(
    (await readFile(replaced[0]!.path, 'utf8')).includes(
      'Use the release train.',
    ),
  );
  assert.ok(replaced[0]!.path.startsWith(await realpath(workspace)));
});

test('create-skill writes a project skill and lists it after reload', async (t) => {
  const { workspace, controller, call } = await setup(t);
  const created = await call('create-skill', {
    name: 'review-diff',
    description: 'Review a diff',
    body: 'Look at the diff.',
  });
  assert.equal(created.ok, true, created.error);
  const text = await readFile(
    join(workspace, '.circle', 'skills', 'review-diff', 'SKILL.md'),
    'utf8',
  );
  assert.match(text, /name: review-diff/);
  assert.match(text, /Look at the diff/);
  assert.equal(
    controller.snapshot().skills.some((skill) => skill.name === 'review-diff'),
    true,
  );
  const again = await call('create-skill', {
    name: 'review-diff',
    description: 'again',
    body: 'no',
  });
  assert.equal(again.ok, false);
  const bad = await call('create-skill', {
    name: 'Bad Name',
    description: 'x',
    body: 'y',
  });
  assert.equal(bad.ok, false);
});
