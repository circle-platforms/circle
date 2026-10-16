import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { defaultEffort } from '../src/model.js';
import { CONTEXT_FILE_CAP, readCappedText } from '../src/memory_sources.js';
import {
  buildSystemPrompt,
  loadToolPrompt,
  readPrompt,
} from '../src/system_prompt.js';
import { defaultRunOptions } from '../src/run_options.js';
import { Sandbox } from '../src/sandbox.js';
import { buildTools } from '../src/tools.js';
import { browserTools, browserToolsWanted } from '../src/browser/tools.js';
import { tokenLen } from '../src/middleware/tool_result_prune.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { emptyUsage } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

test('an unset Anthropic effort is medium, and a saved or env value wins', () => {
  assert.equal(defaultEffort('anthropic', ''), 'medium');
  assert.equal(defaultEffort('openai', ''), '');
  assert.equal(defaultEffort('anthropic', 'high'), 'high');
  assert.equal(defaultEffort('anthropic', 'high', 'low'), 'low');
  assert.equal(defaultEffort('anthropic', 'huge'), 'medium');
  assert.equal(defaultEffort('openai', 'huge'), '');
});

test('session instructions drop example blocks and stay shorter than the file', () => {
  const prompt = buildSystemPrompt(
    '/no/such/workspace',
    'claude-sonnet',
    'anthropic',
    defaultRunOptions(),
    undefined,
    { localContext: false },
  );
  const raw = readPrompt('session', 'anthropic.md');
  assert.match(raw, /<example>/);
  assert.equal(prompt.includes('<example>'), false);
  assert.ok(prompt.length < raw.length);
  assert.match(prompt, /write_todos/);
  assert.equal(prompt.includes('as Windows does'), false);
});

test('skill blurbs in the prompt stay short', () => {
  const prompt = buildSystemPrompt(
    '/no/such/workspace',
    'glm-5.3',
    'anthropic',
    defaultRunOptions(),
    undefined,
    {
      localContext: false,
      skills: [{ name: 'long-skill', description: 'x'.repeat(400) }],
    },
  );
  assert.match(prompt, /long-skill: x{159}…/);
  assert.equal(prompt.includes('x'.repeat(200)), false);
});

test('a greeting request stays within the trimmed tool budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'circle-budget-'));
  const system = buildSystemPrompt(
    root,
    'glm-5.3',
    'anthropic',
    defaultRunOptions(),
    root,
    { localContext: false },
  );
  const sandbox = new Sandbox(root);
  const core = buildTools(sandbox, {
    jobs: {} as never,
    question: async () => '',
    skill: async () => '',
    compact: async () => '',
    plan: async () => '',
    screenshot: {},
    todos: () => {},
  });
  const browser = browserTools(
    { request: async () => ({ text: '' }) },
    { history: () => [] },
  );
  const payload = (
    tools: { name: string; description: string; parameters: unknown }[],
  ) =>
    JSON.stringify(
      tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    );
  const greeting =
    tokenLen(system) +
    tokenLen(payload(core)) +
    tokenLen(loadToolPrompt('lsp'));
  const browserTokens = tokenLen(payload(browser));
  // Live "hi" was about 12.3k with the browser manuals in the request. Those
  // stay off a greeting. 7000 here is about 7.6k at the provider, under 8k
  // with room for a few skill blurbs. The browser payload stays large so it
  // cannot slip back into this total unnoticed.
  assert.ok(greeting < 7_000, String(greeting));
  assert.ok(browserTokens > 3_000, String(browserTokens));
});

test('browser tool schemas are sent only when a page is asked for or already used', () => {
  assert.equal(browserToolsWanted([], 'hi'), false);
  assert.equal(browserToolsWanted([], 'https://example.com'), true);
  assert.equal(browserToolsWanted([], 'open the browser'), true);
  assert.equal(browserToolsWanted([], '请用浏览器打开'), true);
  assert.equal(
    browserToolsWanted(
      [
        {
          id: 'a',
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c', name: 'browser_navigate', args: {} }],
        },
      ],
      'hi',
    ),
    true,
  );
  assert.equal(
    browserToolsWanted(
      [
        {
          id: 't',
          role: 'tool',
          name: 'browser_snapshot',
          tool_call_id: 'c',
          content: 'page',
        },
      ],
      'thanks',
    ),
    true,
  );
});

test('a greeting does not send browser tools, and a url does', async (t) => {
  const root = scratch(t);
  const browser = browserTools(
    { request: async () => ({ text: '' }) },
    { history: () => [] },
  );
  const reply = {
    message: { id: 'a', role: 'assistant' as const, content: 'ok' },
    usage: emptyUsage(),
  };
  const model = new ScriptedModel([
    reply,
    {
      message: { id: 'b', role: 'assistant', content: 'ok' },
      usage: emptyUsage(),
    },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    localContext: false,
    bundledExtensions: false,
    screenshot: false,
    deferredTools: browser,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('hi');
  assert.equal(
    model.requests[0]!.tools.some((tool) => tool.name.startsWith('browser_')),
    false,
  );
  await runtime.harness.run('open https://example.com');
  assert.equal(
    model.requests[1]!.tools.some((tool) => tool.name === 'browser_navigate'),
    true,
  );
});

test('instruction files stop at the context cap', (t) => {
  const root = scratch(t);
  const path = join(root, 'AGENTS.md');
  writeFileSync(path, 'A'.repeat(CONTEXT_FILE_CAP + 50));
  const text = readCappedText(path);
  assert.match(text, /truncated: instruction file exceeds 24000 bytes/);
  assert.ok(text.length < CONTEXT_FILE_CAP + 80);
  mkdirSync(join(root, 'project'));
  writeFileSync(join(root, 'project', 'AGENTS.md'), 'B'.repeat(30_000));
  const prompt = buildSystemPrompt(
    join(root, 'project'),
    'scripted',
    'openai',
    defaultRunOptions(),
  );
  assert.match(prompt, /truncated: instruction file exceeds 24000 bytes/);
  assert.equal((prompt.match(/B{100}/g) ?? []).join('').length <= 24_000, true);
});
