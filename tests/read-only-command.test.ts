import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { readOnlyExecution } from '../src/read_only_command.js';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { Harness } from '../src/harness.js';
import { Sandbox } from '../src/sandbox.js';
import { buildTools } from '../src/tools.js';
import { ScriptedModel } from '../src/testing.js';
import { scratch, cleanup } from './helpers.js';

const safe = [
  'git status',
  'git --no-pager diff --stat',
  'git log --oneline -5',
  'git show HEAD',
  'git rev-parse --show-toplevel',
  'git branch --list',
  'pwd',
  'ls -la',
  'cat file.txt',
  'rg needle .',
  'git status && ls -la | head -10',
];
const unsafe = [
  'git diff --output=out',
  'git branch new-name',
  'git status && git add .',
  'git -c alias.x=!sh x',
  'git diff --ext-diff',
  'git show --textconv',
  'git log --exec=evil',
  'find . -exec sh {} +',
  'rg --pre=evil .',
  'jq --run-tests',
  'cat x > out',
  'ls $(touch out)',
  'env X=1 ls',
  'python -c pass',
  'ls; pwd',
  'cat ~/.ssh/id_rsa',
  'ls "$HOME"',
  'ls %HOME%',
  'cat x &',
  'ls ||',
];

test('verified read-only execution is narrower than display classification on both platforms', () => {
  for (const command of safe)
    assert.equal(
      readOnlyExecution(command, 'darwin')?.kind,
      'verified',
      command,
    );
  for (const command of unsafe)
    assert.equal(readOnlyExecution(command, 'darwin'), undefined, command);
  for (const command of [
    ...safe,
    ...unsafe,
    'dir & del file',
    'git status ^& whoami',
  ])
    assert.equal(readOnlyExecution(command, 'win32'), undefined, command);
});

test('only accept-edits allows verified queries, with terminal first-use and path scope retained', (t) => {
  const root = scratch(t);
  const policy = new ApprovalPolicy(
    new ApprovalStore(join(root, 'approvals')),
    root,
  );
  assert.equal(policy.needsApproval('execute', { command: 'pwd' }, 's'), true);
  policy.setMode('s', 'accept-edits');
  for (const command of safe)
    assert.equal(
      policy.needsApproval('execute', { command }, 's'),
      false,
      command,
    );
  for (const command of unsafe) {
    assert.equal(
      policy.readOnlyCommand('execute', { command }),
      undefined,
      command,
    );
    if (policy.review('execute', { command }).verdict !== 'DENY')
      assert.equal(
        policy.needsApproval('execute', { command }, 's'),
        true,
        command,
      );
  }
  assert.equal(
    policy.needsApproval('execute', { command: 'cat ../outside' }, 's'),
    true,
  );
  const local = { terminal: 'local:t1', command: 'pwd' };
  assert.equal(policy.needsApproval('terminal_send', local, 's'), false);
  assert.equal(
    policy.needsApproval('terminal_send', { ...local, first_use: true }, 's'),
    true,
  );
});

test('scripted query executes with Git helpers disabled and rejected mixed chain has no effects', async (t) => {
  const root = scratch(t);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(root, 'note.txt'), 'actual query evidence\n');
  git('config', 'core.fsmonitor', 'touch helper-ran');
  const store = new CheckpointStore(join(root, 'history'));
  cleanup(t, () => store.close());
  const session = store.create(root, 'scripted');
  const policy = new ApprovalPolicy(
    new ApprovalStore(join(root, 'approvals')),
    root,
  );
  policy.setMode(session.id, 'accept-edits');
  const model = new ScriptedModel([
    {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'query',
            name: 'execute',
            args: { command: 'git status --short' },
          },
          { id: 'read', name: 'execute', args: { command: 'cat note.txt' } },
          {
            id: 'mixed',
            name: 'execute',
            args: { command: 'git status && touch forbidden' },
          },
        ],
      },
    },
    {
      message: { id: crypto.randomUUID(), role: 'assistant', content: 'done' },
    },
  ]);
  const cards: string[] = [];
  await new Harness({
    model,
    tools: buildTools(new Sandbox(root)),
    store,
    session,
    policy,
    system: 'test',
    approve: async (call) => {
      cards.push(call.id);
      return 'reject';
    },
  }).run('query');
  assert.deepEqual(cards, ['mixed']);
  const results = model.requests[1]!.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.match(String(results[0]!.content), /note.txt/);
  assert.match(String(results[1]!.content), /actual query evidence/);
  assert.match(String(results[2]!.content), /rejected/);
  assert.equal(existsSync(join(root, 'helper-ran')), false);
  assert.equal(existsSync(join(root, 'forbidden')), false);
});

test('a verified query turns off what git and ripgrep would start, and leaves credential files out', () => {
  const run = (command: string) =>
    readOnlyExecution(command, 'darwin', ['.env', '*.pem'])?.command;
  assert.equal(
    run('git status --short'),
    "'git' '--no-pager' '--no-optional-locks' '-c' 'core.fsmonitor=false' 'status' '--short'",
  );
  // `log.showSignature` would start the configured gpg program.
  assert.equal(
    run('git log --oneline -5'),
    "'git' '--no-pager' '--no-optional-locks' '-c' 'core.fsmonitor=false' 'log' '--no-ext-diff' '--no-textconv' '--no-show-signature' '--oneline' '-5'",
  );
  // A patch names no file it shows: the credential files are left out of it.
  const leftOut =
    " ':(exclude,glob,icase)**/.env' ':(exclude,glob,icase)**/*.pem'";
  assert.equal(
    run('git diff --cached'),
    "'git' '--no-pager' '--no-optional-locks' '-c' 'core.fsmonitor=false' 'diff' '--no-ext-diff' '--no-textconv' '--cached'" +
      leftOut,
  );
  assert.ok(run('git show HEAD')!.endsWith("'HEAD'" + leftOut));
  assert.ok(run('git log -p -3')!.endsWith("'-p' '-3'" + leftOut));
  assert.equal(
    run('rg --hidden needle src'),
    "'rg' '--no-config' '--iglob' '!.env' '--iglob' '!*.pem' '--hidden' 'needle' 'src'",
  );
  // Only a command that names no file and reads no input stays where it is run.
  for (const [command, pathFree] of [
    ['pwd', true],
    ['ls -la', true],
    ['pwd && ls', true],
    ['ls src', false],
    ['cat note.txt', false],
    ['ls | head -3', false],
    ['git status', false],
  ] as const)
    assert.equal(
      readOnlyExecution(command, 'darwin')?.pathFree,
      pathFree,
      command,
    );
});

function repository(t: Parameters<typeof scratch>[0]) {
  const root = scratch(t);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  const policy = new ApprovalPolicy(
    new ApprovalStore(join(root, 'approvals')),
    root,
  );
  policy.setMode('s', 'accept-edits');
  const asks = (command: string) =>
    policy.needsApproval('execute', { command }, 's');
  return { root, git, policy, asks };
}

test("a git query asks when the repository's own configuration would start another program", (t) => {
  const { root, git, asks } = repository(t);
  assert.equal(asks('git status'), false);
  assert.equal(asks('git diff'), false);
  for (const [key, value] of [
    // Run on a file's content while git compares it with the index.
    ['filter.evil.clean', 'touch helper-ran'],
    // A missing object is fetched from it, through whatever its address starts.
    ['remote.origin.promisor', 'true'],
    ['extensions.partialClone', 'origin'],
    // git asks each submodule, which has a configuration of its own.
    ['submodule.lib.url', './lib'],
    // The files compared are then somewhere else.
    ['core.worktree', '/'],
  ] as const) {
    git('config', key, value);
    for (const command of ['git status', 'git diff', 'git log --oneline'])
      assert.equal(asks(command), true, `${key}: ${command}`);
    // What is not git does not read that configuration.
    assert.equal(asks('ls -la'), false, key);
    git('config', '--unset', key);
    assert.equal(asks('git status'), false, key);
  }
  // A file the configuration includes counts as the configuration.
  writeFileSync(join(root, 'more.config'), '[filter "x"]\n\tclean = cat\n');
  git('config', 'include.path', '../more.config');
  assert.equal(asks('git status'), true);
  git('config', '--unset', 'include.path');
  assert.equal(asks('git status'), false);
  assert.equal(existsSync(join(root, 'helper-ran')), false);
});

test('a link or a folder does not carry a query to a credential file, to .git or out of the workspace', (t) => {
  const { root, asks } = repository(t);
  const outside = scratch(t);
  writeFileSync(join(outside, 'notes.txt'), 'elsewhere\n');
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  writeFileSync(join(root, 'note.txt'), 'here\n');
  symlinkSync(join(root, '.env'), join(root, 'settings'));
  symlinkSync(join(outside, 'notes.txt'), join(root, 'elsewhere'));
  symlinkSync(join(root, 'missing'), join(root, 'dangling'));
  assert.equal(asks('cat note.txt'), false);
  for (const command of [
    'cat settings',
    'cat elsewhere',
    'cat dangling',
    'cat .git/config',
    'ls .git',
    'head -3 .git/HEAD',
  ])
    assert.equal(asks(command), true, command);
});

test('a terminal tab, whose folder is not known, runs unasked only what names no file', (t) => {
  const { policy } = repository(t);
  const asks = (command: string) =>
    policy.needsApproval(
      'terminal_send',
      { terminal: 'local:t1', command },
      's',
    );
  for (const command of ['pwd', 'ls -la', 'pwd && ls'])
    assert.equal(asks(command), false, command);
  for (const command of [
    'cat note.txt',
    'ls src',
    'ls | head -3',
    'git status',
    'rg needle',
    'wc -l',
  ])
    assert.equal(asks(command), true, command);
});

test('an unasked search and an unasked patch show nothing of a credential file', async (t) => {
  const { root, git, policy } = repository(t);
  writeFileSync(join(root, 'note.txt'), 'needle in the note\n');
  writeFileSync(join(root, 'server.pem'), 'needle first key\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  writeFileSync(join(root, 'note.txt'), 'needle in the changed note\n');
  writeFileSync(join(root, 'server.pem'), 'needle second key\n');
  writeFileSync(join(root, '.env'), 'needle=secret\n');
  const store = new CheckpointStore(join(root, 'history'));
  cleanup(t, () => store.close());
  const session = store.create(root, 'scripted');
  policy.setMode(session.id, 'accept-edits');
  // ripgrep is not on every machine that runs this; the command it would run is checked
  // above either way.
  const ripgrep = spawnSync('rg', ['--version']).status === 0;
  const commands = [
    'git diff',
    'git show HEAD',
    'git log -p',
    'git status --short',
    ...(ripgrep ? ['rg --hidden --no-ignore needle'] : []),
  ];
  const model = new ScriptedModel([
    {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: commands.map((command, index) => ({
          id: `call-${index}`,
          name: 'execute',
          args: { command },
        })),
      },
    },
    {
      message: { id: crypto.randomUUID(), role: 'assistant', content: 'done' },
    },
  ]);
  const cards: string[] = [];
  await new Harness({
    model,
    tools: buildTools(new Sandbox(root)),
    store,
    session,
    policy,
    system: 'test',
    approve: async (call) => {
      cards.push(call.id);
      return 'reject';
    },
  }).run('query');
  assert.deepEqual(cards, []);
  const results = model.requests[1]!.messages.filter(
    (message) => message.role === 'tool',
  ).map((message) => String(message.content));
  const [diff, show, log, status] = results;
  // The patches carry the note and not a line of the key, in the work tree or in history.
  for (const patch of [diff, show, log]) {
    assert.match(patch!, /needle in the/, patch);
    assert.doesNotMatch(patch!, /key|secret/, patch);
  }
  // A list of names shows the names: that is all `git status` says of them.
  assert.match(status!, /server\.pem/);
  if (ripgrep) {
    const search = results[4]!;
    assert.match(search, /note\.txt/);
    assert.doesNotMatch(search, /key|secret/, search);
  }
});
