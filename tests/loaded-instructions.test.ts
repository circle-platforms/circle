import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSystemPrompt,
  type ContextInstruction,
} from '../src/system_prompt.js';
import { defaultRunOptions } from '../src/run_options.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import type { Message } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
function fixture(t: test.TestContext) {
  const base = realpathSync(scratch(t)),
    repo = join(base, 'repo'),
    workspace = join(repo, 'src', 'feature'),
    home = join(base, 'home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(repo, '.git'));
  mkdirSync(home);
  writeFileSync(join(base, 'AGENTS.md'), 'OUTSIDE REPOSITORY');
  writeFileSync(join(repo, 'AGENTS.md'), ' ROOT RULES \n');
  writeFileSync(join(repo, 'src', 'CLAUDE.md'), 'PARENT CLAUDE');
  writeFileSync(join(workspace, 'AGENTS.override.md'), 'OVERRIDE RULES');
  writeFileSync(join(workspace, 'AGENTS.md'), 'NESTED RULES');
  return { base, repo, workspace, home };
}
function assertPromptCatalog(
  prompt: string,
  expected: readonly ContextInstruction[],
) {
  assert.deepEqual(
    [
      ...prompt.matchAll(
        /<project_instructions path="([^"]+)">\n([\s\S]*?)\n<\/project_instructions>/g,
      ),
    ].map(([, path, content]) => ({ path, content })),
    expected,
  );
  for (const excluded of ['OUTSIDE REPOSITORY', 'ROOT RULES', 'PARENT CLAUDE'])
    assert.ok(
      !prompt.includes(excluded),
      `parent context stays out: ${excluded}`,
    );
}
test('prompt callback records exact included project context once and confines discovery to the open folder', (t) => {
  const { workspace, home } = fixture(t);
  const calls: readonly ContextInstruction[][] = [];
  const captured: ContextInstruction[][] = calls as ContextInstruction[][];
  const prompt = buildSystemPrompt(
    workspace,
    'scripted-model',
    'openai',
    defaultRunOptions(),
    home,
    { onContextFiles: (files) => captured.push([...files]) },
  );
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], [
    { path: join(workspace, 'AGENTS.override.md'), content: 'OVERRIDE RULES' },
    { path: join(workspace, 'AGENTS.md'), content: 'NESTED RULES' },
  ]);
  assertPromptCatalog(prompt, captured[0]!);
});
test('disabled local context reports an empty catalog rather than discovered but unloaded files', (t) => {
  const { workspace, home } = fixture(t);
  let captured: readonly ContextInstruction[] | undefined;
  const run = defaultRunOptions();
  run.no_context_files = true;
  const prompt = buildSystemPrompt(
    workspace,
    'scripted-model',
    'openai',
    run,
    home,
    {
      onContextFiles: (files) => {
        captured = files;
      },
    },
  );
  assert.deepEqual(captured, []);
  assert.ok(!prompt.includes('NESTED RULES'));
  captured = undefined;
  buildSystemPrompt(
    workspace,
    'scripted-model',
    'openai',
    defaultRunOptions(),
    home,
    {
      localContext: false,
      onContextFiles: (files) => {
        captured = files;
      },
    },
  );
  assert.deepEqual(captured, []);
});
test('runtime catalog changes only when prompt is rebuilt and matches the next scripted model request', async (t) => {
  const { workspace, home } = fixture(t);
  const model = new ScriptedModel([
    { message: { id: 'reply', role: 'assistant', content: 'ok' } as Message },
    {
      message: {
        id: 'after-delete',
        role: 'assistant',
        content: 'ok',
      } as Message,
    },
  ]);
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings: trustFolder(defaultSettings(), workspace),
    model,
  });
  cleanup(t, () => runtime.close());
  const initial = runtime.loadedInstructions;
  assert.deepEqual(initial, [
    {
      path: join(runtime.options.workspace, 'AGENTS.override.md'),
      content: 'OVERRIDE RULES',
    },
    {
      path: join(runtime.options.workspace, 'AGENTS.md'),
      content: 'NESTED RULES',
    },
  ]);
  assertPromptCatalog(runtime.harness.system, initial);
  const leaf = join(workspace, 'AGENTS.md');
  writeFileSync(leaf, 'CHANGED AFTER BUILD');
  const newFile = join(workspace, 'CLAUDE.md');
  writeFileSync(newFile, 'NEW AFTER BUILD');
  // Keep the caller's alias spelling for actual input and writes. Runtime
  // catalogs identify the same sources with its native canonical workspace.
  const expectedLeaf = realpathSync.native(leaf);
  const expectedNewFile = realpathSync.native(newFile);
  assert.equal(runtime.options.workspace, realpathSync.native(workspace));
  assert.deepEqual(runtime.loadedInstructions, initial);
  initial[0]!.content = 'MUTATED GETTER';
  assert.notEqual(runtime.loadedInstructions[0]!.content, 'MUTATED GETTER');
  runtime.refreshPrompt();
  assert.equal(
    runtime.loadedInstructions.find((file) => file.path === expectedLeaf)
      ?.content,
    'CHANGED AFTER BUILD',
  );
  assert.ok(
    runtime.loadedInstructions.some((file) => file.path === expectedNewFile),
  );
  await runtime.harness.run('verify instructions');
  assert.equal(model.requests.length, 1);
  const firstRequest = model.requests[0]!.system;
  assertPromptCatalog(firstRequest, runtime.loadedInstructions);
  assert.ok(firstRequest.includes('CHANGED AFTER BUILD'));
  assert.ok(firstRequest.includes('NEW AFTER BUILD'));
  unlinkSync(newFile);
  assert.ok(
    runtime.loadedInstructions.some((file) => file.path === expectedNewFile),
    'deletion does not rewrite the already-loaded prompt',
  );
  runtime.refreshPrompt();
  assert.ok(
    !runtime.loadedInstructions.some((file) => file.path === expectedNewFile),
  );
  await runtime.harness.run('verify instructions after deletion');
  assert.equal(model.requests.length, 2);
  assertPromptCatalog(model.requests[1]!.system, runtime.loadedInstructions);
  assert.ok(model.requests[1]!.system.includes('CHANGED AFTER BUILD'));
  assert.ok(!model.requests[1]!.system.includes('NEW AFTER BUILD'));
  assert.ok(model.requests[0]!.system.includes('NEW AFTER BUILD'));
});
