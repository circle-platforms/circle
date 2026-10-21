// The terminal tools as the model meets them: approvals by device, the destructive word
// that always asks, the host key the person must answer, and the secrets that stay theirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { saveSecret } from '../src/secrets.js';
import { ruleTool } from '../src/approvals.js';
import { terminalTools, type TerminalPort } from '../src/terminal/tools.js';
import type { TerminalProfile } from '../src/terminal/profiles.js';
import { cleanup, scratch } from './helpers.js';

const profiles: TerminalProfile[] = [
  {
    name: 'lab',
    transport: 'ssh',
    host: 'sw1.lan',
    port: 22,
    user: 'operator',
    passwordSecret: 'LAB_PASS',
    cols: 80,
    rows: 24,
  },
  {
    name: 'core',
    transport: 'telnet',
    host: 'core.lan',
    port: 23,
    cols: 80,
    rows: 24,
  },
];

const step = (id: string, name: string, args: Record<string, unknown>) => ({
  message: {
    id,
    role: 'assistant' as const,
    content: '',
    tool_calls: [{ id, name, args }],
  },
});

test('approvals go by device: one answer covers that device, another device asks again', async (t) => {
  const root = scratch(t);
  const requests: Record<string, unknown>[] = [];
  const port: TerminalPort = {
    async request(_session, action, args) {
      requests.push({ action, ...structuredClone(args) });
      if (action === 'connect') {
        const target = args.profile === 'core' ? 'core.lan:23' : 'sw1.lan:22';
        const id = args.profile === 'core' ? 't2' : 't1';
        return {
          text: `Connected: ${id} · lab · ssh ${target} · quiet 1s`,
          host: target,
          session: id,
        };
      }
      if (action === 'send')
        return {
          text: 't1 · ok\n### Output\nran: shown',
          host: 'sw1.lan:22',
          session: 't1',
        };
      return { text: 'done' };
    },
  };
  const model = new ScriptedModel([
    step('c1', 'terminal_connect', { profile: 'lab' }),
    step('s1', 'terminal_send', {
      session: 't1',
      text: 'show version',
      enter: true,
    }),
    step('c2', 'terminal_connect', { profile: 'core' }),
    step('s2', 'terminal_send', {
      session: 't2',
      text: 'show version',
      enter: true,
    }),
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const asked: { name: string; host: unknown }[] = [];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: terminalTools(port, { profiles: () => profiles }),
    approve: async (call) => {
      asked.push({ name: call.name, host: call.args.host });
      return 'always';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('check the devices');
  // One card for the first device, none for its second action, one for the other device
  assert.deepEqual(asked, [
    { name: 'terminal_connect', host: 'sw1.lan:22' },
    { name: 'terminal_connect', host: 'core.lan:23' },
  ]);
  // The device an action was allowed on travels with the action, merged in as a fact
  assert.deepEqual(
    requests.map((r) => [r.action, r.host]),
    [
      ['connect', 'sw1.lan:22'],
      ['send', 'sw1.lan:22'],
      ['connect', 'core.lan:23'],
      ['send', 'core.lan:23'],
    ],
  );
  const review = runtime.policy.review('terminal_send', {
    session: 't1',
    host: 'sw1.lan:22',
  });
  assert.equal(review.pattern, 'host:sw1.lan:22');
  assert.equal(review.scope, 'terminal control on sw1.lan:22');
  assert.equal(ruleTool('terminal_connect'), 'terminal');
  assert.equal(ruleTool('terminal_read'), 'terminal_read');
  // The next send on the allowed device needs no card
  runtime.policy.remember(
    runtime.session.id,
    'terminal_send',
    { session: 't1', host: 'sw1.lan:22' },
    'always',
  );
  assert.equal(
    runtime.policy.needsApproval(
      'terminal_send',
      { session: 't1', text: 'x', host: 'sw1.lan:22' },
      runtime.session.id,
    ),
    false,
  );
  // Another device asks again: sw1's rule covers sw1, nothing covers this one
  assert.equal(
    runtime.policy.needsApproval(
      'terminal_send',
      { session: 't9', text: 'x', host: 'access.lan:22' },
      runtime.session.id,
    ),
    true,
  );
});

test('a sent line that can wipe the device asks every time, naming only the word', async (t) => {
  const root = scratch(t);
  const port: TerminalPort = {
    async request(_session, action, args) {
      return {
        text: `${action} done`,
        host: 'sw1.lan:22',
        session: 't1',
      };
    },
  };
  const asked: Record<string, unknown>[] = [];
  const model = new ScriptedModel([
    step('c0', 'terminal_connect', { profile: 'lab' }),
    step('a', 'terminal_send', {
      session: 't1',
      text: 'erase flash',
      enter: true,
    }),
    step('b', 'terminal_send', {
      session: 't1',
      text: 'show clock',
      enter: true,
    }),
    step('c', 'terminal_send', { session: 't1', text: 'reset', enter: true }),
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: terminalTools(port, {
      profiles: () => [profiles[0]!],
    }),
    approve: async (call) => {
      asked.push(structuredClone(call.args));
      return 'always';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('work on the switch');
  // The device rule answers ordinary sends, but each wipe-word asks again on its own
  assert.deepEqual(
    asked.map((args) => [args.host, args.deletes]),
    [
      ['sw1.lan:22', undefined],
      ['sw1.lan:22', 'erase'],
      ['sw1.lan:22', 'reset'],
    ],
  );
  // The forced review names only the matched word, never the whole line
  const review = runtime.policy.review('terminal_send', {
    session: 't1',
    host: 'sw1.lan:22',
    deletes: 'erase',
  });
  assert.equal(review.verdict, 'ASK_FORCED');
  assert.match(review.reason, /destroy what the device holds/);
  assert.equal(review.reason.includes('erase flash'), false);
});

test('an unknown host key goes to the person with a token that never reaches the model', async (t) => {
  const root = scratch(t);
  const requests: Record<string, unknown>[] = [];
  const port: TerminalPort = {
    async request(_session, action, args) {
      requests.push({ action, ...structuredClone(args) });
      if (action === 'connect' && !args.approval)
        return {
          text: 'sw1.lan:22 offered a host key nobody has trusted yet',
          host: 'sw1.lan:22',
          approval: {
            kind: 'hostkey',
            token: 'hk-token',
            host: 'sw1.lan:22',
            keyType: 'ssh-ed25519',
            fingerprint: 'SHA256:abc',
            privateHost: true,
          },
        };
      return {
        text: 'Connected: t1 · lab · ssh sw1.lan:22 · quiet 1s',
        host: 'sw1.lan:22',
        session: 't1',
      };
    },
  };
  const seen: unknown[] = [];
  const model = new ScriptedModel([
    step('a', 'terminal_connect', { profile: 'lab' }),
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const decisions: unknown[] = ['always'];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: terminalTools(port, {
      profiles: () => profiles,
      confirm: async (_session, approval) => {
        seen.push(approval);
        return decisions.shift() as 'always' | 'once' | 'reject';
      },
    }),
    approve: async () => 'approve',
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('connect the lab switch');
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as { kind: string }).kind, 'hostkey');
  assert.deepEqual(
    requests.map((request) => [request.action, request.approval]),
    [
      ['connect', undefined],
      ['connect', { token: 'hk-token', scope: 'always' }],
    ],
  );
  // The token is the person's: it never reaches the model
  assert.equal(JSON.stringify(model.requests).includes('hk-token'), false);
  const tool = model.requests[0]!.tools.find(
    (entry) => entry.name === 'terminal_connect',
  );
  assert.deepEqual(
    Object.keys(
      (tool!.parameters as never as Record<string, unknown>).properties ?? {},
    ),
    ['profile', 'host', 'port', 'transport', 'user'],
  );
});

test('a refused host key sends nothing, and auto mode trusts nothing for good', async (t) => {
  const root = scratch(t);
  const requests: Record<string, unknown>[] = [];
  const port: TerminalPort = {
    async request(_session, action, args) {
      requests.push({ action, ...structuredClone(args) });
      if (action === 'connect' && !args.approval)
        return {
          text: 'the host key needs an answer',
          host: 'sw1.lan:22',
          approval: {
            kind: 'hostkey',
            token: 'tk',
            host: 'sw1.lan:22',
            keyType: 'ssh-ed25519',
            fingerprint: 'SHA256:abc',
            privateHost: true,
          },
        };
      return {
        text: 'Connected: t1 · ssh sw1.lan:22',
        host: 'sw1.lan:22',
        session: 't1',
      };
    },
  };
  const model = new ScriptedModel([
    step('a', 'terminal_connect', { profile: 'lab' }),
    step('b', 'terminal_connect', { profile: 'lab' }),
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const answers = ['reject', 'auto'];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: terminalTools(port, {
      profiles: () => profiles,
      confirm: async () => answers.shift() as never,
    }),
    approve: async () => 'approve',
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, false);
  await runtime.harness.run('connect twice');
  const results = model.requests[2]!.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.match(
    String(results[0]!.content),
    /did not trust this device host key/,
  );
  // auto mode still needs the person for the host key, but never trusts for good
  assert.equal((requests[2]!.approval as { scope: string }).scope, 'once');
});

test('a device password is a secret name going in and its value coming back redacted', async (t) => {
  const root = scratch(t);
  saveSecret(root, 'DEV_PASS', 'hunter-super-secret');
  const requests: Record<string, unknown>[] = [];
  const port: TerminalPort = {
    async request(_session, action, args) {
      requests.push({ action, ...structuredClone(args) });
      // A console that echoes what it was given, password and all
      return {
        text: `t1 · ssh sw1.lan:22\n### Output\nran: ${args.text ?? ''}`,
        host: 'sw1.lan:22',
        session: 't1',
      };
    },
  };
  const model = new ScriptedModel([
    step('a', 'terminal_connect', { profile: 'lab' }),
    step('b', 'terminal_send', {
      session: 't1',
      text: '%DEV_PASS%',
      enter: true,
    }),
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: terminalTools(port, { profiles: () => profiles }),
    approve: async () => 'always',
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('log in and run it');
  // The device receives the value; the transcript keeps the name
  const sent = requests.find((request) => request.action === 'send')!;
  assert.equal(sent.text, 'hunter-super-secret');
  const transcript = JSON.stringify(model.requests[2]!.messages);
  assert.equal(transcript.includes('hunter-super-secret'), false);
  assert.match(transcript, /%DEV_PASS%/);
});

test('the tool surface: reads are free, actors are not, nothing of it enters subagents', () => {
  const port: TerminalPort = {
    async request() {
      return { text: 'ok' };
    },
  };
  const tools = terminalTools(port);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(byName), [
    'terminal_sessions',
    'terminal_connect',
    'terminal_send',
    'terminal_read',
    'terminal_wait',
    'terminal_press',
    'terminal_disconnect',
    'terminal_handoff',
  ]);
  for (const tool of tools) assert.equal(tool.subagents, false);
  assert.equal(byName.terminal_read!.effect, 'read');
  assert.equal(byName.terminal_sessions!.effect, 'read');
  assert.equal(byName.terminal_wait!.effect, 'read');
  assert.equal(byName.terminal_handoff!.effect, 'read');
  assert.equal(byName.terminal_connect!.effect, 'unknown');
  assert.equal(byName.terminal_send!.effect, 'unknown');
  assert.deepEqual(
    (byName.terminal_send!.parameters as never as Record<string, unknown>)
      .required,
    ['session', 'text'],
  );
  assert.deepEqual(
    (byName.terminal_wait!.parameters as never as Record<string, unknown>)
      .required,
    ['session'],
  );
  // Descriptions come from the prompt files
  assert.match(byName.terminal_connect!.description ?? '', /SecureCRT|SSH/);
});
