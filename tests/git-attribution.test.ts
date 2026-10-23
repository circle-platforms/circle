import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { CIRCLE_GIT_EMAIL, CIRCLE_PR_LINE } from '../src/attribution.js';
import {
  applyProjectSettings,
  defaultSettings,
  loadSettingsFromDict,
  saveSettings,
  trustFolder,
  type CircleSettings,
} from '../src/settings.js';
import type { Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const reply = (text: string) => ({
  message: {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: text,
  } as Message,
});
const circleTrailer = `Co-authored-by: Circle <${CIRCLE_GIT_EMAIL}>`;
const circleAuthor = `--author="Circle <${CIRCLE_GIT_EMAIL}>"`;

// The machine's own git configuration never reaches these checks.
function isolateGit(t: TestContext): void {
  const saved = {
    global: process.env.GIT_CONFIG_GLOBAL,
    system: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.system;
  });
}
function repo(t: TestContext, email = 'ada@example.com'): string {
  const root = scratch(t);
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'Ada Lovelace'], {
    cwd: workspace,
  });
  if (email)
    execFileSync('git', ['config', 'user.email', email], { cwd: workspace });
  return workspace;
}
async function firstSystem(
  t: TestContext,
  workspace: string,
  change: (settings: CircleSettings) => void = () => {},
  headless = false,
): Promise<string> {
  const home = join(workspace, '..', 'home');
  mkdirSync(home, { recursive: true });
  const settings = trustFolder(defaultSettings(), workspace);
  change(settings);
  saveSettings(settings, home);
  const model = new ScriptedModel([reply('done')]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model,
    headless,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('commit this');
  return model.requests[0]!.system;
}

test('an interactive run asks for a Circle co-author trailer and a pull request line', async (t) => {
  isolateGit(t);
  const system = await firstSystem(t, repo(t));
  assert.match(system, /<git_attribution>/);
  assert.ok(system.includes(circleTrailer), system);
  assert.ok(system.includes(CIRCLE_PR_LINE));
  assert.ok(!system.includes('--author'));
});

test('a headless run makes Circle the author and the person from git config the co-author', async (t) => {
  isolateGit(t);
  const system = await firstSystem(t, repo(t), undefined, true);
  assert.ok(system.includes(circleAuthor), system);
  assert.ok(system.includes('Co-authored-by: Ada Lovelace <ada@example.com>'));
  assert.ok(!system.includes(circleTrailer));
});

test('Circle is never the only author: without a git user.email it stays a co-author', async (t) => {
  isolateGit(t);
  const system = await firstSystem(
    t,
    repo(t, ''),
    (settings) => {
      settings.attribution = { enabled: true, author: 'circle' };
    },
    true,
  );
  assert.ok(system.includes(circleTrailer));
  assert.ok(!system.includes('--author'));
});

test('author "user" keeps the person as author even when headless', async (t) => {
  isolateGit(t);
  const system = await firstSystem(
    t,
    repo(t),
    (settings) => {
      settings.attribution = { enabled: true, author: 'user' };
    },
    true,
  );
  assert.ok(system.includes(circleTrailer));
  assert.ok(!system.includes('--author'));
});

test('turned off, the prompt says not to add attribution and names no trailer', async (t) => {
  isolateGit(t);
  const system = await firstSystem(t, repo(t), (settings) => {
    settings.attribution = { enabled: false, author: 'auto' };
  });
  assert.match(system, /Circle attribution is disabled for this workspace/);
  assert.ok(!system.includes(CIRCLE_GIT_EMAIL));
  assert.ok(!system.includes(CIRCLE_PR_LINE));
});

test('outside a git repository there is no attribution section', async (t) => {
  isolateGit(t);
  const workspace = join(scratch(t), 'plain');
  mkdirSync(workspace);
  const system = await firstSystem(t, workspace);
  assert.ok(!system.includes('<git_attribution>'));
});

test('a project can turn attribution off; bad values fall back to the defaults', (t) => {
  const workspace = repo(t);
  mkdirSync(join(workspace, '.circle'));
  writeFileSync(
    join(workspace, '.circle', 'settings.json'),
    JSON.stringify({ attribution: { enabled: false } }),
  );
  const settings = defaultSettings();
  const { changed, problems } = applyProjectSettings(
    settings,
    workspace,
    join(workspace, '..', 'home'),
  );
  assert.deepEqual(problems, []);
  assert.ok(changed.attribution);
  assert.deepEqual(settings.attribution, { enabled: false, author: 'auto' });
  assert.deepEqual(
    loadSettingsFromDict({ attribution: { author: 'robot', enabled: 0 } })
      .attribution,
    { enabled: false, author: 'auto' },
  );
  assert.deepEqual(loadSettingsFromDict({}).attribution, {
    enabled: true,
    author: 'auto',
  });
});
