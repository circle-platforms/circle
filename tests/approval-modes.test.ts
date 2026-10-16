import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ApprovalPolicy,
  ApprovalStore,
  commandAllowed,
  SESSION_MODES,
} from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { Harness } from '../src/harness.js';
import { AgentRuntime } from '../src/runtime.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultSettings, loadSettingsFromDict } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { buildTools } from '../src/tools.js';
import type { Message, ToolCall } from '../src/types.js';

const assistant = (
  content: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content,
  tool_calls: calls,
});

function policy(root: string) {
  return new ApprovalPolicy(new ApprovalStore(join(root, 'approvals')), root);
}

test('one session browser rule covers every browser action and can be revoked', (t) => {
  const root = scratch(t);
  const rules = policy(root);
  const actions = [
    'browser_navigate',
    'browser_click',
    'browser_type',
    'browser_select',
    'browser_press',
    'browser_dialog',
  ];
  const click = { ref: 'e3', element: 'sign in' };
  assert.equal(rules.needsApproval('browser_click', click, 's'), true);
  assert.equal(rules.remember('s', 'browser_click', click, 'always'), true);
  assert.deepEqual(
    rules.store.rules('s').map(({ tool, pattern, label }) => ({
      tool,
      pattern,
      label,
    })),
    [{ tool: 'browser', pattern: '*', label: 'browser control' }],
  );
  for (const action of actions) {
    assert.equal(rules.needsApproval(action, {}, 's'), false, action);
    assert.equal(rules.needsApproval(action, {}, 'other'), true, action);
  }
  assert.equal(
    rules.needsApproval('write_file', { file_path: 'a' }, 's'),
    true,
  );
  rules.store.revoke('s', 0);
  assert.equal(rules.needsApproval('browser_type', {}, 's'), true);
  assert.equal(rules.remember('s', 'browser_click', click, 'approve'), true);
  assert.equal(rules.needsApproval('browser_type', {}, 's'), true);
});

test('accept-edits answers for edits inside the workspace and asks for the rest', (t) => {
  const root = scratch(t);
  const rules = policy(root);
  const inside = { file_path: join(root, 'a.py'), content: 'x' };
  const outside = { file_path: join(root, '..', 'b.py'), content: 'x' };
  assert.equal(rules.mode('s'), 'manual');
  assert.equal(rules.needsApproval('write_file', inside, 's'), true);
  rules.setMode('s', 'accept-edits');
  assert.equal(rules.mode('s'), 'accept-edits');
  assert.equal(rules.yoloEnabled('s'), false);
  assert.equal(rules.needsApproval('write_file', inside, 's'), false);
  assert.equal(
    rules.needsApproval(
      'edit_file',
      { file_path: 'a.py', old_string: 'x', new_string: 'y' },
      's',
    ),
    false,
  );
  assert.equal(rules.needsApproval('write_file', outside, 's'), true);
  assert.equal(
    rules.needsApproval('delete', { path: join(root, 'a.py') }, 's'),
    true,
  );
  assert.equal(
    rules.needsApproval(
      'apply_patch',
      { patchText: '*** Begin Patch\n*** Delete File: a.py\n*** End Patch' },
      's',
    ),
    true,
  );
  assert.equal(
    rules.needsApproval('execute', { command: 'touch made' }, 's'),
    true,
  );
  // The mode belongs to one session.
  assert.equal(rules.needsApproval('write_file', inside, 'other'), true);
});

test('accept-edits still asks before overwriting a skill-run output', (t) => {
  const root = scratch(t);
  mkdirSync(join(root, 'out'));
  mkdirSync(join(root, 'pack'));
  writeFileSync(join(root, 'out', 'report.md'), 'old\n');
  writeFileSync(join(root, 'notes.txt'), 'keep\n');
  writeFileSync(
    join(root, 'pack', 'skillpack.json'),
    JSON.stringify({ outputs: ['out/report.md'] }),
  );
  const rules = policy(root);
  rules.setMode('s', 'accept-edits');
  assert.equal(
    rules.review('write_file', { file_path: 'out/report.md', content: 'new' })
      .verdict,
    'ASK_FORCED',
  );
  assert.equal(
    rules.needsApproval(
      'write_file',
      { file_path: 'out/report.md', content: 'new' },
      's',
    ),
    true,
  );
  assert.equal(
    rules.needsApproval(
      'edit_file',
      { file_path: 'out/report.md', old_string: 'old', new_string: 'new' },
      's',
    ),
    true,
  );
  assert.equal(
    rules.needsApproval(
      'write_file',
      { file_path: 'out/fresh.md', content: 'n' },
      's',
    ),
    false,
  );
  assert.equal(
    rules.needsApproval(
      'write_file',
      { file_path: 'notes.txt', content: 'n' },
      's',
    ),
    false,
  );
  assert.equal(
    rules.review('execute', { command: 'printf n > out/report.md' }).verdict,
    'ASK_FORCED',
  );
  rules.setMode('s', 'auto');
  assert.equal(
    rules.needsApproval(
      'write_file',
      { file_path: 'out/report.md', content: 'new' },
      's',
    ),
    false,
  );
});

test('auto is the old yolo switch and manual clears it', (t) => {
  const root = scratch(t);
  const rules = policy(root);
  rules.setYolo('s', true);
  assert.equal(rules.mode('s'), 'auto');
  assert.equal(
    rules.needsApproval('execute', { command: 'touch made' }, 's'),
    false,
  );
  rules.setMode('s', 'manual');
  assert.equal(rules.yoloEnabled('s'), false);
  assert.equal(
    rules.needsApproval('execute', { command: 'touch made' }, 's'),
    true,
  );
  assert.deepEqual(SESSION_MODES, ['manual', 'accept-edits', 'plan', 'auto']);
});

test('in accept-edits the harness writes the file without asking and still asks before a command', async (t) => {
  // The policy compares resolved paths; the temporary folder is a link on macOS.
  const root = realpathSync(scratch(t));
  writeFileSync(join(root, 'calc.py'), 'def add(a, b):\n    return a - b\n');
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'scripted');
  const rules = policy(root);
  rules.setMode(session.id, 'accept-edits');
  const model = new ScriptedModel([
    {
      message: assistant('', [
        { id: 'read', name: 'read_file', args: { file_path: 'calc.py' } },
      ]),
    },
    {
      message: assistant('', [
        {
          id: 'edit',
          name: 'edit_file',
          args: {
            file_path: 'calc.py',
            old_string: 'a - b',
            new_string: 'a + b',
          },
        },
        {
          id: 'run',
          name: 'execute',
          args: { command: 'touch ran.txt' },
        },
      ]),
    },
    { message: assistant('done') },
  ]);
  const asked: ToolCall[] = [];
  const harness = new Harness({
    model,
    tools: buildTools(new Sandbox(root)),
    store,
    session,
    policy: rules,
    system: 'test',
    approve: async (call) => {
      asked.push(call);
      return 'reject';
    },
  });
  await harness.run('fix it');
  assert.equal(
    readFileSync(join(root, 'calc.py'), 'utf8'),
    'def add(a, b):\n    return a + b\n',
  );
  assert.deepEqual(
    asked.map((call) => call.name),
    ['execute'],
  );
  const results = model.requests[2]!.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.match(String(results[1]!.content), /Edited/);
  assert.match(String(results[2]!.content), /rejected/);
});

test('the runtime mode joins plan and the approval modes, and plan exit can accept edits', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    {
      message: assistant('', [{ id: 'exit', name: 'plan_exit', args: {} }]),
    },
    { message: assistant('ok') },
  ]);
  const questions: unknown[] = [];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    question: async (args) => {
      questions.push(args);
      return JSON.stringify([['implement plan, accept edits']]);
    },
  });
  cleanup(t, () => runtime.close());
  assert.equal(runtime.mode, 'manual');
  runtime.setMode('auto');
  assert.equal(runtime.policy.yoloEnabled(runtime.session.id), true);
  runtime.setMode('plan');
  assert.equal(runtime.harness.planMode, true);
  assert.equal(runtime.mode, 'plan');
  assert.equal(
    runtime.policy.mode(runtime.session.id),
    'manual',
    'leaving plan asks again',
  );
  await runtime.harness.run('done planning');
  assert.equal(questions.length, 1);
  assert.equal(runtime.harness.planMode, false);
  assert.equal(runtime.mode, 'accept-edits');
  const result = model.requests[1]!.messages.findLast(
    (message) => message.role === 'tool',
  );
  assert.match(String(result!.content), /accepted without asking/);
});

test('a settings pattern covers a command only when every segment matches', (t) => {
  const root = scratch(t);
  const allows = (command: string, patterns: string[]): boolean =>
    commandAllowed(command, patterns, root);
  assert.equal(allows('npm run build', ['npm *']), true);
  assert.equal(allows('npm run build --watch', ['npm run *']), true);
  assert.equal(allows('npm run build', ['npm run build']), true);
  // `npm *` asks for a word after npm
  assert.equal(allows('npm', ['npm *']), false);
  assert.equal(allows('npmx run', ['npm *']), false);
  // every segment of a compound command must be covered
  assert.equal(allows('npm ci && npm run build', ['npm *']), true);
  assert.equal(allows('npm ci && rm -rf dist', ['npm *']), false);
  assert.equal(allows('npm ci && rm -rf dist', ['npm *', 'rm -rf *']), true);
  assert.equal(allows('cat a.txt | grep x', ['cat *', 'grep *']), true);
  assert.equal(allows('cat a.txt | grep x', ['cat *']), false);
  // a leading cd into the workspace is stripped before matching
  assert.equal(allows(`cd ${root} && npm run build`, ['npm *']), true);
  assert.equal(allows(`cd ${root}; npm run build`, ['npm *']), true);
  // a cd anywhere else stays a segment of its own
  assert.equal(allows('cd /tmp && npm run build', ['npm *']), false);
  assert.equal(allows('cd /tmp && npm run build', ['cd *', 'npm *']), true);
  // quotes come off and runs of whitespace become one space
  assert.equal(allows('git commit -m "a b"', ['git commit -m a b']), true);
  assert.equal(allows('npm   run    build', ['npm run build']), true);
  // ? stands for one character
  assert.equal(allows('ls -la', ['ls -l?']), true);
  // a command that does not parse is never covered
  assert.equal(allows('npm "unterminated', ['*']), false);
  assert.equal(allows('', ['*']), false);
  assert.equal(allows('ls', []), false);
  // only execute is covered by patterns
  const rules = new ApprovalPolicy(
    new ApprovalStore(join(root, 'approvals')),
    root,
    undefined,
    undefined,
    ['*'],
  );
  assert.equal(rules.allowedBySettings('execute', { command: 'ls' }), true);
  assert.equal(
    rules.allowedBySettings('write_file', { file_path: 'a' }),
    false,
  );
});

test('a settings pattern answers for an always-asking command and never for a denied one', async (t) => {
  const root = realpathSync(scratch(t));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'gone.txt'), 'x');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'scripted');
  const rules = new ApprovalPolicy(
    new ApprovalStore(join(root, 'approvals')),
    root,
    undefined,
    undefined,
    ['rm *', '*'],
  );
  // the classification still sees the destructive command …
  assert.equal(
    rules.review('execute', { command: 'rm -rf dist' }).verdict,
    'ASK_FORCED',
  );
  // … but the pattern answers for it, and DENY stays out of reach
  assert.equal(
    rules.needsApproval('execute', { command: 'rm -rf dist' }, session.id),
    false,
  );
  assert.equal(
    rules.review('execute', { command: 'cat .env' }).verdict,
    'DENY',
  );
  const model = new ScriptedModel([
    {
      message: assistant('', [
        { id: 'rm', name: 'execute', args: { command: 'rm -rf dist' } },
        { id: 'env', name: 'execute', args: { command: 'cat .env' } },
        { id: 'sudo', name: 'execute', args: { command: 'sudo rm -rf /' } },
      ]),
    },
    { message: assistant('done') },
  ]);
  const harness = new Harness({
    model,
    tools: buildTools(new Sandbox(root)),
    store,
    session,
    policy: rules,
    system: 'test',
    headless: true,
  });
  await harness.run('clean up');
  // the allowed destructive command really ran, with no approve callback
  assert.equal(existsSync(join(root, 'dist')), false);
  const results = model.requests[1]!.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.match(String(results[0]!.content), /Exit code: 0/);
  assert.match(
    String(results[1]!.content),
    /Denied by approval policy.*credential file/s,
  );
  assert.match(String(results[2]!.content), /Denied by approval policy/);
});

test('default_mode starts a session, a restored plan wins, and /new applies it again', async (t) => {
  const root = scratch(t);
  const settings = defaultSettings();
  settings.default_mode = 'accept-edits';
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model: new ScriptedModel([]),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  assert.equal(runtime.mode, 'accept-edits');
  assert.equal(
    runtime.policy.needsApproval(
      'write_file',
      { file_path: 'a.txt', content: 'x' },
      runtime.session.id,
    ),
    false,
  );
  await runtime.newSession();
  assert.equal(runtime.mode, 'accept-edits', '/new starts in the default too');
  // plan as the default: read-only from the first message, boundary recorded
  const planSettings = defaultSettings();
  planSettings.default_mode = 'plan';
  const planned = new AgentRuntime({
    workspace: root,
    home: root,
    settings: planSettings,
    model: new ScriptedModel([]),
    headless: true,
  });
  cleanup(t, () => planned.close());
  assert.equal(planned.mode, 'plan');
  assert.equal(planned.harness.planMode, true);
  assert.match(JSON.stringify(planned.harness.messages), /Plan mode is now ON/);
  const id = planned.session.id;
  await planned.close();
  // resuming that transcript keeps plan even though the default is now auto
  const autoSettings = defaultSettings();
  autoSettings.default_mode = 'auto';
  const resumed = new AgentRuntime({
    workspace: root,
    home: root,
    settings: autoSettings,
    model: new ScriptedModel([]),
    headless: true,
    session: id,
  });
  cleanup(t, () => resumed.close());
  assert.equal(resumed.harness.planMode, true);
  assert.equal(resumed.mode, 'plan');
});

test('rules a Python release revoked stay revoked, and the tombstones go on the next save', (t) => {
  const root = scratch(t);
  mkdirSync(join(root, 'approvals'), { recursive: true });
  const thread = 's';
  const name =
    createHash('sha256').update(thread).digest('hex').slice(0, 32) + '.json';
  // what Python 0.5.0 leaves behind: the revoked rule kept with its mark
  writeFileSync(
    join(root, 'approvals', name),
    JSON.stringify({
      rules: [
        {
          tool: 'execute',
          pattern: 'npm *',
          label: 'npm …',
          at: 1,
          revoked: true,
        },
        { tool: 'execute', pattern: 'git *', label: 'git …', at: 2 },
      ],
      log: [],
    }),
  );
  const store = new ApprovalStore(join(root, 'approvals'));
  assert.deepEqual(
    store.rules(thread).map((rule) => rule.pattern),
    ['git *'],
  );
  assert.equal(store.matchesAny(thread, 'execute', ['npm *']), false);
  assert.equal(store.matchesAny(thread, 'execute', ['git *']), true);
  // numbering counts the live rules only
  assert.equal(store.revoke(thread, 0)?.pattern, 'git *');
  const saved = JSON.parse(readFileSync(join(root, 'approvals', name), 'utf8'));
  assert.deepEqual(saved.rules, []);
});

test('the settings loader takes only known mode names and real pattern strings', () => {
  assert.deepEqual(defaultSettings().allowed_commands, []);
  assert.equal(defaultSettings().default_mode, '');
  assert.equal(
    loadSettingsFromDict({ default_mode: ' AUTO ' }).default_mode,
    'auto',
  );
  assert.equal(
    loadSettingsFromDict({ default_mode: 'accept-edits' }).default_mode,
    'accept-edits',
  );
  assert.equal(loadSettingsFromDict({ default_mode: 'yolo' }).default_mode, '');
  assert.equal(
    loadSettingsFromDict({ default_mode: 'accept_edits' }).default_mode,
    '',
  );
  assert.deepEqual(
    loadSettingsFromDict({ allowed_commands: ['npm *', 42, ' ', 'git *'] })
      .allowed_commands,
    ['npm *', 'git *'],
  );
  // the loader's list of names is the policy's list of modes
  for (const mode of SESSION_MODES)
    assert.equal(
      loadSettingsFromDict({ default_mode: mode }).default_mode,
      mode,
    );
});
