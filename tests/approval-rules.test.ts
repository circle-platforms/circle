import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { ruleFileFor, type ApprovalRule } from '../src/approval_rules.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

const THREAD = 'thread-with-rules';
const command = (text: string) => ({ command: text });

/**
 * A policy over a data folder and a workspace of its own, with the rules of each
 * layer written as the files the policy reads. Nothing here touches ~/.circle.
 */
function folders(
  t: TestContext,
  layers: { user?: ApprovalRule[]; project?: ApprovalRule[] } = {},
): { policy: ApprovalPolicy; home: string; workspace: string } {
  const root = scratch(t);
  const home = join(root, 'data');
  const workspace = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(workspace, '.circle'), { recursive: true });
  for (const layer of ['user', 'project'] as const) {
    const rules = layers[layer];
    if (rules)
      writeFileSync(
        ruleFileFor(layer, home, workspace),
        JSON.stringify({ rules }),
      );
  }
  return {
    policy: new ApprovalPolicy(
      new ApprovalStore(join(home, 'approvals')),
      workspace,
    ),
    home,
    workspace,
  };
}

const rule = (
  effect: 'allow' | 'deny',
  tool: string,
  pattern: string,
): ApprovalRule => ({ tool, pattern, effect, label: pattern });

test('a deny of your own file refuses the call and names the rule that decided', (t) => {
  const { policy } = folders(t, {
    user: [rule('deny', 'execute', 'npm publish *')],
  });
  const found = policy.review('execute', command('npm publish --tag next'));
  assert.equal(found.verdict, 'DENY');
  assert.equal(
    found.reason,
    'refused by your approvals.json: execute "npm publish *" is denied',
  );
  // The pattern does not reach for another command.
  assert.notEqual(
    policy.review('execute', command('npm test')).verdict,
    'DENY',
  );
});

test('a deny in the project file refuses too, and says so: a project can tighten', (t) => {
  const { policy } = folders(t, {
    project: [rule('deny', 'execute', 'make deploy *')],
  });
  const found = policy.review('execute', command('make deploy --dry-run'));
  assert.equal(found.verdict, 'DENY');
  assert.equal(
    found.reason,
    'refused by the project\'s rule: execute "make deploy *" is denied',
  );
  // A command Circle refuses on its own terms keeps that reason: a rule
  // does not get to rewrite the floors.
  const escalated = folders(t, {
    project: [rule('deny', 'execute', 'sudo *')],
  });
  assert.equal(
    escalated.policy.review('execute', command('sudo rm -rf /tmp/thing'))
      .reason,
    'privilege escalation',
  );
});

test('a deny wins over auto, over a settings pattern and over an allow of any layer', (t) => {
  const { policy } = folders(t, {
    user: [rule('allow', 'execute', '*'), rule('allow', 'delete', '*')],
    project: [rule('deny', 'execute', 'git push *')],
  });
  policy.setAllowedCommands(['git *']);
  policy.setMode(THREAD, 'auto');
  assert.equal(
    policy.review('execute', command('git push origin main')).verdict,
    'DENY',
    'auto does not outrank a deny',
  );
  assert.equal(
    policy.needsApproval('execute', command('git push origin main'), THREAD),
    false,
    'a refused call asks for nothing',
  );
  // What no rule denies runs as before, without a card, in auto.
  assert.equal(policy.review('execute', command('git status')).verdict, 'ASK');
  assert.equal(
    policy.needsApproval('execute', command('git status'), THREAD),
    false,
  );
});

test('an allow of your own file answers the card, and a project file never grants one', (t) => {
  const mine = folders(t, {
    user: [rule('allow', 'execute', 'git status *')],
  });
  assert.equal(
    mine.policy.needsApproval('execute', command('git status --short'), THREAD),
    false,
  );
  const theirs = folders(t, {
    project: [rule('allow', 'execute', 'git status *')],
  });
  assert.equal(
    theirs.policy.needsApproval(
      'execute',
      command('git status --short'),
      THREAD,
    ),
    true,
    'a rule of the repository you did not write does not answer for you',
  );
});

test('an allow does not skip a call that always asks, and never outranks a hard refusal', (t) => {
  const { policy } = folders(t, {
    user: [rule('allow', 'execute', '*')],
  });
  // A command that deletes asks every time: an allow is not a way round it.
  assert.equal(
    policy.needsApproval('execute', command('rm -rf build'), THREAD),
    true,
  );
  // A credential file is refused on its own terms, before any rule is read.
  const found = policy.review('execute', command('cat .env'));
  assert.equal(found.verdict, 'DENY');
  assert.ok(
    !found.reason.includes('approvals.json'),
    'the reason is the file, not a rule: ' + found.reason,
  );
});

test('a pattern needs the whole word: "npm publish *" does not cover the bare command', (t) => {
  const { policy } = folders(t, {
    user: [rule('deny', 'execute', 'npm publish *')],
  });
  // The same reach allowed_commands has: the space is part of the pattern.
  assert.equal(policy.review('execute', command('npm publish')).verdict, 'ASK');
  assert.equal(
    policy.review('execute', command('npm publish --tag next')).verdict,
    'DENY',
  );
  const loose = folders(t, { user: [rule('deny', 'execute', 'npm *')] });
  assert.equal(
    loose.policy.review('execute', command('npm publish')).verdict,
    'DENY',
  );
});

test('a command pattern has to cover every segment, so one half of a chain is not enough', (t) => {
  const { policy } = folders(t, {
    project: [rule('deny', 'execute', 'git *')],
  });
  assert.equal(
    policy.review('execute', command('git add . && git status')).verdict,
    'DENY',
  );
  assert.notEqual(
    policy.review('execute', command('git status && npm test')).verdict,
    'DENY',
    'npm test is not covered by git *',
  );
});

test('a rule is kept under the name the card uses: browser and terminal each take one', (t) => {
  const browser = folders(t, { user: [rule('deny', 'browser', '*')] });
  assert.equal(
    browser.policy.review('browser_click', { site: 'example.com' }).verdict,
    'DENY',
  );
  const terminal = folders(t, {
    user: [rule('deny', 'terminal', 'host:router-1')],
  });
  assert.equal(
    terminal.policy.review('terminal_send', {
      host: 'router-1',
      line: 'show ip',
    }).verdict,
    'DENY',
  );
  assert.notEqual(
    terminal.policy.review('terminal_send', {
      host: 'router-2',
      line: 'show ip',
    }).verdict,
    'DENY',
    'another device is not covered',
  );
});

test('a rules file that does not read is a layer that says nothing, not a crash', (t) => {
  const { policy, home, workspace } = folders(t);
  writeFileSync(ruleFileFor('user', home, workspace), '{not json');
  assert.equal(policy.review('execute', command('npm test')).verdict, 'ASK');
  assert.equal(
    policy.needsApproval('execute', command('npm test'), THREAD),
    true,
  );
});

test('the files are read again for every call, so a deny added while Circle runs takes effect', (t) => {
  const { policy, home, workspace } = folders(t);
  assert.equal(policy.review('execute', command('make deploy')).verdict, 'ASK');
  writeFileSync(
    ruleFileFor('user', home, workspace),
    JSON.stringify({ rules: [rule('deny', 'execute', 'make *')] }),
  );
  assert.equal(
    policy.review('execute', command('make deploy')).verdict,
    'DENY',
  );
});

test('what a card kept for this conversation still allows, and nothing leaks to another', (t) => {
  const { policy } = folders(t);
  policy.remember(THREAD, 'execute', command('make build'), 'always');
  assert.equal(
    policy.needsApproval('execute', command('make build'), THREAD),
    false,
  );
  assert.equal(
    policy.needsApproval('execute', command('make build'), 'another-thread'),
    true,
  );
});

test('a denied command does not run in an auto session, and the model is told the rule', async (t) => {
  const root = scratch(t);
  const home = join(root, 'data');
  const workspace = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    ruleFileFor('user', home, workspace),
    JSON.stringify({ rules: [rule('deny', 'execute', 'mkdir *')] }),
  );
  const model = new ScriptedModel([
    {
      message: {
        id: 'call',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'run-it',
            name: 'execute',
            args: command('mkdir ran'),
          },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'told' } },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings: trustFolder(defaultSettings(), workspace),
    model,
    approve: async () => {
      throw new Error('an auto session shows no card');
    },
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('run that');
  assert.equal(runtime.policy.mode(runtime.session.id), 'auto', 'auto mode');
  assert.equal(
    existsSync(join(workspace, 'ran')),
    false,
    'the folder was not made',
  );
  const told = JSON.stringify(
    model.requests
      .at(-1)!
      .messages.filter((message) => message.role === 'tool'),
  );
  assert.match(told, /refused by your approvals\.json/);
  assert.match(told, /mkdir \*/);
});
