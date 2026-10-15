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
import { browserTools } from '../src/browser/tools.js';
import { tokenLen } from '../src/middleware/tool_result_prune.js';
import { scratch } from './helpers.js';

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
  const tokens =
    tokenLen(system) +
    tokenLen(payload(core)) +
    tokenLen(payload(browser)) +
    tokenLen(loadToolPrompt('lsp'));
  // Tool manuals are most of a short turn. This locks the trim (question, lsp,
  // read/edit, paths, todo examples) so a greeting does not grow back past it.
  assert.ok(tokens < 11_500, String(tokens));
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
