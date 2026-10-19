// A write to one of the person's own terminal tabs, as the approval policy and the harness
// judge it from the facts the terminal tools add: the line it runs is an execute command
// under the execute rules, and the tab's first use asks in every mode, whatever a rule,
// a setting or a hook says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalPolicy, ApprovalStore, ruleTool } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { Harness } from '../src/harness.js';
import { HookRunner, loadHooks } from '../src/hooks.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, Tool } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const tab = 'local:3f2a';
const write = (extra: Record<string, unknown>) => ({
  session: tab,
  text: 'x',
  terminal: tab,
  ordinal: 1,
  first_use: false,
  ...extra,
});

function policy(t: { after(fn: () => void | Promise<void>): void }) {
  const root = realpathSync(scratch(t));
  return new ApprovalPolicy(new ApprovalStore(join(root, 'approvals')), root);
}

test('a line a tab runs is reviewed as the execute command it is', (t) => {
  const p = policy(t);
  for (const command of ['npm test', 'ls -la', 'rm -rf build', 'sudo ls']) {
    const tabbed = p.review('terminal_send', write({ command }));
    const executed = p.review('execute', { command });
    assert.deepEqual(tabbed, executed, command);
  }
  // typing that runs nothing is no command; it has no rule to keep
  const typing = p.review('terminal_send', write({ typed: 'git sta' }));
  assert.equal(typing.verdict, 'ASK');
  assert.equal(typing.reason, 'types in your terminal');
  assert.equal(typing.pattern, '');
  // a device's send is judged as before, by its host
  const device = p.review('terminal_send', {
    session: 't1',
    text: 'ls',
    host: 'sw1.lan:22',
  });
  assert.equal(device.reason, 'types to the device');
  assert.equal(device.pattern, 'host:sw1.lan:22');
  assert.equal(ruleTool('terminal_send'), 'terminal');
});

test('the first use asks in every mode and past every rule; after it, the execute rules decide', (t) => {
  const p = policy(t);
  const thread = 'conversation';
  p.setAllowedCommands(['npm test']);
  const first = write({ first_use: true, command: 'npm test' });
  for (const mode of ['manual', 'accept-edits', 'auto'] as const) {
    p.setMode(thread, mode);
    assert.equal(p.needsApproval('terminal_send', first, thread), true, mode);
  }
  assert.equal(p.tabAlwaysAsks('terminal_send', first), true);
  assert.equal(p.allowedBySettings('terminal_send', first), false);
  // once in use: a setting's pattern covers the line as it covers execute
  const later = write({ command: 'npm test' });
  assert.equal(p.tabAlwaysAsks('terminal_send', later), false);
  assert.equal(p.allowedBySettings('terminal_send', later), true);
  p.setAllowedCommands([]);
  p.setMode(thread, 'auto');
  assert.equal(p.needsApproval('terminal_send', later, thread), false);
  p.setMode(thread, 'accept-edits');
  assert.equal(p.needsApproval('terminal_send', later, thread), true);
  p.setMode(thread, 'manual');
  assert.equal(p.needsApproval('terminal_send', later, thread), true);
  // typing that runs nothing asks nothing once the tab is in use
  assert.equal(
    p.needsApproval('terminal_send', write({ typed: 'git sta' }), thread),
    false,
  );
  assert.equal(
    p.needsApproval('terminal_press', write({ key: 'ArrowUp' }), thread),
    false,
  );
});

test('"allow for this session" on a tab line is an execute rule, and an execute rule covers a tab line', (t) => {
  const p = policy(t);
  const thread = 'conversation';
  assert.equal(
    p.remember(
      thread,
      'terminal_send',
      write({ command: 'npm test' }),
      'always',
    ),
    true,
  );
  assert.deepEqual(
    p.store.rules(thread).map((rule) => rule.tool),
    ['execute'],
  );
  assert.equal(
    p.needsApproval('execute', { command: 'npm test' }, thread),
    false,
  );
  assert.equal(
    p.needsApproval(
      'terminal_press',
      write({ key: 'Enter', command: 'npm test' }),
      thread,
    ),
    false,
  );
  // a prefix rule from an execute card covers the tab's line too
  assert.equal(
    p.remember(thread, 'execute', { command: 'npm run lint' }, 'prefix'),
    true,
  );
  assert.ok(
    p.store
      .rules(thread)
      .some((rule) => rule.pattern === 'prefix:["npm","run","lint"]'),
  );
  assert.equal(
    p.needsApproval(
      'terminal_send',
      write({ command: 'npm run lint --fix' }),
      thread,
    ),
    false,
  );
  assert.equal(
    p.needsApproval(
      'terminal_send',
      write({ command: 'npm run deploy' }),
      thread,
    ),
    true,
  );
  // still asks for a first use, and a forced ask has no session answer
  assert.equal(
    p.needsApproval(
      'terminal_send',
      write({ first_use: true, command: 'npm test' }),
      thread,
    ),
    true,
  );
  assert.equal(
    p.remember(
      thread,
      'terminal_send',
      write({ command: 'rm -rf build' }),
      'always',
    ),
    false,
  );
});

test('a hook that allows the call still leaves the tab’s first use to the person; later it skips the card', async (t) => {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(home);
  mkdirSync(join(workspace, '.circle'), { recursive: true });
  const script = join(workspace, 'allow.mjs');
  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify({ decision: 'allow', reason: 'fine' }));\n",
  );
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  writeFileSync(
    join(workspace, '.circle', 'hooks.json'),
    JSON.stringify({
      hooks: {
        before_tool: [{ name: 'allow', command }],
        permission_request: [{ name: 'allow', command }],
      },
    }),
  );
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const session = store.create(workspace, 'scripted');
  const rules = new ApprovalPolicy(
    new ApprovalStore(join(home, 'approvals')),
    workspace,
  );
  rules.setMode(session.id, 'auto');
  // A terminal tab's send as the desktop's tools describe it: in use after it first runs
  let used = false;
  const typed: string[] = [];
  const send: Tool = {
    name: 'terminal_send',
    description: 'type in a terminal tab',
    effect: 'unknown',
    subagents: false,
    parameters: {
      type: 'object',
      properties: { session: { type: 'string' }, text: { type: 'string' } },
      required: ['session', 'text'],
      additionalProperties: false,
    },
    approvalFacts: (args, _session, shown) => ({
      terminal: args.session,
      ordinal: 1,
      first_use: !used,
      command: String(shown?.text ?? args.text),
    }),
    async run(args) {
      used = true;
      typed.push(String(args.text));
      return 'typed';
    },
  };
  const call = (id: string): Message => ({
    id,
    role: 'assistant',
    content: '',
    tool_calls: [
      { id, name: 'terminal_send', args: { session: tab, text: 'ls' } },
    ],
  });
  const model = new ScriptedModel(
    [
      call('first'),
      call('second'),
      { id: 'end', role: 'assistant', content: 'done' } as Message,
    ].map((message) => ({ message })),
  );
  const asked: string[] = [];
  const harness = new Harness({
    model,
    tools: [send],
    store,
    session,
    policy: rules,
    system: 'test',
    hooks: new HookRunner(
      loadHooks({ workspace, home, trusted: true, userHome: home }),
      { workspace, home },
    ),
    approve: async (toolCall) => {
      asked.push(toolCall.id);
      return 'approve';
    },
  });
  await harness.run('go');
  // auto mode and two allowing hooks, and still the person was asked the first time only
  assert.deepEqual(asked, ['first']);
  assert.deepEqual(typed, ['ls', 'ls']);
});

test('a line read off the screen without its prompt end asks every time, keeps no rule, and is still refused when it reads as refused', (t) => {
  const p = policy(t);
  const thread = 'conversation';
  p.setAllowedCommands(['jiang@mac']);
  const uncertain = write({
    command: 'jiang@mac circle % rm -rf build',
    uncertain: true,
  });
  for (const mode of ['manual', 'accept-edits', 'auto'] as const) {
    p.setMode(thread, mode);
    assert.equal(
      p.needsApproval('terminal_press', uncertain, thread),
      true,
      mode,
    );
  }
  assert.equal(p.tabAlwaysAsks('terminal_press', uncertain), true);
  // no setting, no session rule and no prefix rule comes from it or covers it
  assert.equal(p.allowedBySettings('terminal_press', uncertain), false);
  const found = p.review('terminal_press', uncertain);
  assert.equal(found.verdict, 'ASK_FORCED');
  assert.equal(found.reason, 'runs the line on the screen');
  assert.equal(found.pattern, '');
  assert.deepEqual(found.prefix, []);
  assert.equal(
    p.remember(thread, 'terminal_press', uncertain, 'always'),
    false,
  );
  assert.equal(
    p.remember(thread, 'terminal_press', uncertain, 'prefix'),
    false,
  );
  assert.deepEqual(p.store.rules(thread), []);
  // a line that reads as refused stays refused, prompt or not
  assert.equal(
    p.review(
      'terminal_press',
      write({ command: 'sudo rm -rf /', uncertain: true }),
    ).verdict,
    p.review('execute', { command: 'sudo rm -rf /' }).verdict,
  );
});

test('a tab line is judged with its secrets’ values, as execute is, and the card shows their names', async (t) => {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(home);
  mkdirSync(workspace);
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const session = store.create(workspace, 'scripted');
  const rules = new ApprovalPolicy(
    new ApprovalStore(join(home, 'approvals')),
    workspace,
  );
  // The value names a credential file: `cat` of it is refused as execute refuses it
  const secrets = { KEYFILE: '.ssh/id_rsa', TOKEN: 's3cr3t-value' };
  const typed: string[] = [];
  const send: Tool = {
    name: 'terminal_send',
    description: 'type in a terminal tab',
    effect: 'unknown',
    subagents: false,
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        text: { type: 'string' },
        enter: { type: 'boolean' },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
    // As the desktop's tab facts do: from the values the write runs with
    approvalFacts: (args) => ({
      terminal: args.session,
      ordinal: 1,
      first_use: false,
      command: String(args.text),
      typed: String(args.text),
    }),
    async run(args) {
      typed.push(String(args.text));
      return 'typed';
    },
  };
  const call = (id: string, text: string): Message => ({
    id,
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id,
        name: 'terminal_send',
        args: { session: tab, text, enter: true },
      },
    ],
  });
  const model = new ScriptedModel(
    [
      call('refused', 'cat ~/%KEYFILE%'),
      call('shown', 'curl -H "Authorization: %TOKEN%" https://example.test'),
      { id: 'end', role: 'assistant', content: 'done' } as Message,
    ].map((message) => ({ message })),
  );
  const cards: Record<string, unknown>[] = [];
  const harness = new Harness({
    model,
    tools: [send],
    store,
    session,
    policy: rules,
    system: 'test',
    secrets: () => secrets,
    approve: async (toolCall) => {
      cards.push(toolCall.args);
      return 'approve';
    },
  });
  await harness.run('go');
  // the credential file the value names is refused before any card, and nothing is typed
  assert.equal(
    typed.some((text) => text.includes('id_rsa')),
    false,
  );
  // the line that ran had the value; the card that asked for it showed the name
  assert.deepEqual(typed, [
    'curl -H "Authorization: s3cr3t-value" https://example.test',
  ]);
  assert.equal(cards.length, 1);
  assert.equal(
    cards[0]!.command,
    'curl -H "Authorization: %TOKEN%" https://example.test',
  );
  assert.equal(JSON.stringify(cards).includes('s3cr3t-value'), false);
});
