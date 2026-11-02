import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, saveSettings, trustFolder } from '../src/settings.js';
import { parseFrontmatter } from '../src/skills.js';
import type { ModelResponse } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const skill = parseFrontmatter(
  readFileSync(
    join(repo, 'src', 'builtin_skills', 'pr-review', 'SKILL.md'),
    'utf8',
  ),
);
// Every gh command the skill puts in front of the model, in the order it appears.
const suggested = [...skill.body.matchAll(/`gh [^`]+`/g)].map((match) =>
  match[0].slice(1, -1),
);
// The sign-in is the person's own, in their own terminal: Circle is told to stop.
const forTheHuman = 'gh auth login';
const quote = (value: string) => '"' + value + '"';

test('pr-review takes a pull request from red checks to an answered thread with its own commands', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  const bin = join(root, 'bin');
  const kept = join(root, 'gh-saw');
  const outside = join(root, 'reply');
  mkdirSync(join(root, 'project'));
  // A repository with a branch, so the skill's first step has something to answer.
  const workspace = realpathSync(join(root, 'project'));
  for (const folder of [home, userHome, bin, kept, outside]) mkdirSync(folder);
  const init = spawnSync(
    'git',
    ['init', '-q', '-b', 'pr-review-fixture', workspace],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(init.status, 0, init.stderr || init.error?.message);

  // The reply bodies are written outside the repository, as the skill says.
  const commentFile = join(outside, 'comment.md');
  const reviewFile = join(outside, 'review.md');
  const program = join(repo, 'tests', 'fixtures', 'pr-review-gh.cjs');
  const windows = process.platform === 'win32';
  const shim = join(bin, windows ? 'gh.cmd' : 'gh');
  writeFileSync(
    shim,
    windows
      ? '@echo off\r\n"' + process.execPath + '" "' + program + '" %*\r\n'
      : '#!/bin/sh\nexec "' + process.execPath + '" "' + program + '" "$@"\n',
  );
  if (!windows) chmodSync(shim, 0o755);
  const saved = {
    PATH: process.env.PATH,
    GH_LOG: process.env.GH_LOG,
    GH_KEPT: process.env.GH_KEPT,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  process.env.PATH = [bin, process.env.PATH].filter(Boolean).join(delimiter);
  process.env.GH_LOG = join(kept, 'calls.jsonl');
  process.env.GH_KEPT = kept;

  const run = suggested
    .filter((command) => command !== forTheHuman)
    .map((command) =>
      command
        .replace('<number>', '42')
        .replace('<comment-id>', 'c-7')
        .replace('<run-id>', '9001')
        .replace(
          '<file>',
          quote(command.startsWith('gh pr review') ? reviewFile : commentFile),
        ),
    );
  assert.ok(run.length >= 9, run.join('\n'));
  const call = (id: string, command: string) => ({
    message: {
      id,
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id, name: 'execute', args: { command } }],
    },
  });
  const steps: Partial<ModelResponse>[] = [
    {
      message: {
        id: 'load',
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          { id: 'load-skill', name: 'skill', args: { name: 'pr-review' } },
        ],
      },
    },
    call('branch', 'git branch --show-current'),
  ];
  // The bodies are written between the four reads and the answers.
  const answerFirst = run.findIndex((command) =>
    command.startsWith('gh pr comment'),
  );
  run.slice(0, answerFirst).forEach((command, index) => {
    steps.push(call('read-' + index, command));
  });
  steps.push({
    message: {
      id: 'bodies',
      role: 'assistant' as const,
      content: '',
      tool_calls: [
        {
          id: 'write-comment',
          name: 'write_file',
          args: {
            file_path: commentFile,
            content:
              'Done in 1a2b3c: src/file_rewind.ts now reads 41 lines. The plan file stays unrecorded on purpose, and a turn that cannot be restored whole is dropped with its receipts.\n',
          },
        },
        {
          id: 'write-review',
          name: 'write_file',
          args: {
            file_path: reviewFile,
            content:
              'Both requests are in 1a2b3c. The restore-all-or-nothing rule is covered by tests/file-rewind.test.ts.\n',
          },
        },
      ],
    },
  });
  run.slice(answerFirst).forEach((command, index) => {
    steps.push(call('answer-' + index, command));
  });
  steps.push({
    message: {
      id: 'report',
      role: 'assistant' as const,
      content:
        'The red check was check (ubuntu-24.04): expected 2 items but got 3. Both threads are answered; the review still stands, and I have not merged or approved.',
    },
  });
  const model = new ScriptedModel(steps);
  const settings = trustFolder(defaultSettings(), workspace);
  saveSettings(settings, home);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings,
    model,
    approve: async () => 'approve',
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('address the review on my pull request');

  const toolResults = model.requests
    .flatMap((request) => request.messages)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content));
  const refused = toolResults.filter((result) =>
    result.includes('unknown gh call'),
  );
  assert.deepEqual(refused, [], 'every command the skill suggests exists');

  // The commands ran in the order the skill gives them, each against the gh the
  // person has, and the branch was read first.
  const calls = readFileSync(process.env.GH_LOG!, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  // The quotes are the shell's, so the program is handed the path alone.
  assert.deepEqual(
    calls.map((args) => 'gh ' + args.join(' ')),
    run.map((command) => command.replace(/"/g, '')),
    'the gh calls, in the skill order',
  );
  assert.ok(
    toolResults.some((result) => result.includes('pr-review-fixture')),
    'the branch name reached the model',
  );

  // All four reads reached the model as evidence, not as a summary of them.
  assert.ok(
    toolResults.some((result) => result.includes('expected 2 items but got 3')),
    'the failing line reached the model',
  );
  assert.ok(
    toolResults.some((result) =>
      result.includes('Why is the plan file never recorded?'),
    ),
    'the open thread reached the model',
  );
  assert.ok(
    toolResults.some((result) => result.includes('file_rewind.ts b/')),
    'the diff reached the model',
  );
  // A red check is the answer: the run carried on after it.
  const checks = toolResults.find((result) => result.includes('runs/9001'));
  assert.ok(checks && checks.includes('Exit code: 1'), checks);

  // The answer went to the thread it belongs to, from a file outside the
  // repository, and the review was answered without approving it.
  assert.ok(!commentFile.startsWith(workspace), 'the body is outside the work');
  assert.ok(existsSync(commentFile) && existsSync(reviewFile));
  const comment = JSON.parse(
    readFileSync(join(kept, 'comment.json'), 'utf8'),
  ) as { number: string; replyTo: string; body: string };
  assert.equal(comment.number, '42');
  assert.equal(comment.replyTo, 'c-7');
  assert.equal(comment.body, readFileSync(commentFile, 'utf8'));
  const review = JSON.parse(
    readFileSync(join(kept, 'review.json'), 'utf8'),
  ) as {
    event: string;
    body: string;
  };
  assert.equal(review.event, 'comment');
  assert.equal(review.body, readFileSync(reviewFile, 'utf8'));
  assert.ok(
    toolResults.some((result) => result.includes('#issuecomment-1001')),
    'the comment URL came back to the model',
  );

  // The skill itself was in front of the model while it did all of this.
  const loaded = model.requests
    .flatMap((request) => request.messages)
    .find(
      (message) =>
        message.role === 'tool' && message.tool_call_id === 'load-skill',
    );
  assert.ok(loaded, 'the skill tool answered');
  assert.ok(String(loaded.content).includes(skill.body.trim()));
});
