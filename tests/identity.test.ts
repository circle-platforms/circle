import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';
import { mcpStub } from './mcp-stub.js';

const reply = (
  text: string,
  calls: Message['tool_calls'] = [],
): Partial<ModelResponse> => ({
  message: {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: text,
    tool_calls: calls,
  },
});

// A script that appends what it was told, one JSON line per run, in any system shell
function recorder(dir: string, name: string, line: string): string {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from 'node:fs';
const input = (() => { try { return JSON.parse(readFileSync(0, 'utf8')); } catch { return {}; } })();
appendFileSync(${JSON.stringify(join(dir, `${name}.jsonl`))}, JSON.stringify(${line}) + '\\n');
`,
  );
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}
const lines = (dir: string, name: string) =>
  readFileSync(join(dir, `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test("a subagent's calls carry the conversation's session everywhere, with its own as the agent's", async (t) => {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const stub = await mcpStub(t, {
    tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
  });
  const hook = recorder(
    root,
    'hook',
    `{ tool: input.tool_name, session_id: input.session_id, agent_id: input.agent_id ?? null, agent_type: input.agent_type ?? null, env: [process.env.CIRCLE_SESSION_ID ?? null, process.env.CIRCLE_AGENT_ID ?? null] }`,
  );
  writeFileSync(
    join(home, 'hooks.json'),
    JSON.stringify({
      hooks: {
        before_tool: [{ name: 'who', command: hook, tools: 'execute' }],
      },
    }),
  );
  const command = recorder(
    root,
    'command',
    `[process.env.CIRCLE_SESSION_ID ?? null, process.env.CIRCLE_AGENT_ID ?? null]`,
  );
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'http-server', url: stub.url, transport: 'streamable_http' },
  ];
  const both = () =>
    reply('', [
      { id: crypto.randomUUID(), name: 'execute', args: { command } },
      { id: crypto.randomUUID(), name: 'http-server_echo', args: {} },
    ]);
  const model = new ScriptedModel([
    // The conversation: a command and a server call, then a subagent that does the same
    both(),
    reply('', [
      {
        id: 'task',
        name: 'task',
        args: { description: 'check', subagent_type: 'general-purpose' },
      },
    ]),
    both(),
    reply('child done'),
    reply('done'),
  ]);
  // Inherited from a Circle this one runs inside: never passed on as this conversation's
  const inherited = process.env.CIRCLE_AGENT_ID;
  process.env.CIRCLE_AGENT_ID = 'inherited';
  t.after(() => {
    if (inherited === undefined) delete process.env.CIRCLE_AGENT_ID;
    else process.env.CIRCLE_AGENT_ID = inherited;
  });
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('go');

  const main = runtime.session.id;
  const [own, sub] = lines(root, 'hook');
  assert.deepEqual(own, {
    tool: 'execute',
    session_id: main,
    agent_id: null,
    agent_type: null,
    env: [main, null],
  });
  const agent = sub.agent_id as string;
  assert.ok(agent && agent !== main);
  assert.deepEqual(sub, {
    tool: 'execute',
    session_id: main,
    agent_id: agent,
    agent_type: 'general-purpose',
    env: [main, agent],
  });
  // The agent is the subagent's own session, a child of the conversation
  assert.equal(runtime.store.get(agent)?.parent_id, main);
  // Its commands are told the same
  assert.deepEqual(lines(root, 'command'), [
    [main, null],
    [main, agent],
  ]);
  // And so is the server, on each call's requests
  assert.deepEqual(
    stub
      .calls()
      .map((request) => [
        request.headers['circle-session-id'],
        request.headers['circle-agent-id'] ?? null,
      ]),
    [
      [main, null],
      [main, agent],
    ],
  );
});
