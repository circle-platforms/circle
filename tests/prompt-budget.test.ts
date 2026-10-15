import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultEffort } from '../src/model.js';
import { CONTEXT_FILE_CAP, readCappedText } from '../src/memory_sources.js';
import { buildSystemPrompt, readPrompt } from '../src/system_prompt.js';
import { defaultRunOptions } from '../src/run_options.js';
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
