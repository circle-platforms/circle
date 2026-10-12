import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSecrets,
  onlyReferences,
  redactSecrets,
  removeSecret,
  saveSecret,
  secretNames,
  secretsPath,
  expandVariables,
} from '../src/secrets.js';
import {
  ApprovalPolicy,
  ApprovalStore,
  DEFAULT_CREDENTIAL_FILES,
} from '../src/approvals.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import {
  defaultSettings,
  loadSettingsFromDict,
  trustFolder,
} from '../src/settings.js';
import { buildSystemPrompt } from '../src/system_prompt.js';
import type { Tool, ToolContext } from '../src/types.js';

const scratch = (t: test.TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'circle-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('secrets are kept privately by name, and a damaged file reads as empty', (t) => {
  const home = scratch(t);
  saveSecret(home, 'DB_PASSWORD', 'lab-value-1');
  saveSecret(home, 'API_TOKEN', 'token-2');
  assert.deepEqual(loadSecrets(home), {
    DB_PASSWORD: 'lab-value-1',
    API_TOKEN: 'token-2',
  });
  assert.deepEqual(secretNames(home), ['API_TOKEN', 'DB_PASSWORD']);
  if (process.platform !== 'win32')
    assert.equal(statSync(secretsPath(home)).mode & 0o777, 0o600);
  assert.equal(removeSecret(home, 'API_TOKEN'), true);
  assert.equal(removeSecret(home, 'API_TOKEN'), false);
  for (const name of ['db', '1PASS', 'DB-PASSWORD', '', 'A'.repeat(65)])
    assert.throws(() => saveSecret(home, name, 'x'), /secret name/);
  assert.throws(() => saveSecret(home, 'EMPTY', ''), /enter the value/);
  assert.throws(
    () => saveSecret(home, 'LONG', 'x'.repeat(4097)),
    /longer than 4096/,
  );
  writeFileSync(secretsPath(home), '{not json');
  assert.deepEqual(loadSecrets(home), {});
  writeFileSync(
    secretsPath(home),
    JSON.stringify({
      secrets: { GOOD: 'v', bad: 'v', NOT_TEXT: 1, EMPTY: '' },
    }),
  );
  assert.deepEqual(loadSecrets(home), { GOOD: 'v' });
  assert(DEFAULT_CREDENTIAL_FILES.includes('secrets.json'));
  const policy = new ApprovalPolicy(
    new ApprovalStore(join(home, 'rules')),
    home,
  );
  assert.equal(
    policy.review('execute', { command: 'cat ~/.circle/secrets.json' }).verdict,
    'DENY',
  );
});

test('%NAME% takes a value at any depth, names that are not set stay, and secret values show as names again', () => {
  const secrets = { PASS: 'p@ss', PASS_LONG: 'p@ss-and-more' };
  const used = new Set<string>();
  assert.deepEqual(
    expandVariables(
      {
        command:
          'login -u admin -p %PASS% %UNKNOWN% %lower% %PATH% date +%Y%m%d',
        nested: [{ text: '%PASS_LONG%' }, 3, true],
        // A name that is not set does not take the % of the one after it
        joined: '%X%PASS%',
      },
      secrets,
      used,
    ),
    {
      command: 'login -u admin -p p@ss %UNKNOWN% %lower% %PATH% date +%Y%m%d',
      nested: [{ text: 'p@ss-and-more' }, 3, true],
      joined: '%Xp@ss',
    },
  );
  assert.deepEqual([...used].sort(), ['PASS', 'PASS_LONG']);
  assert.equal(expandVariables('%PASS%', {}), '%PASS%');
  assert.equal(
    redactSecrets('echo p@ss-and-more and p@ss', secrets),
    'echo %PASS_LONG% and %PASS%',
  );
  const names = ['PASS', 'PASS_LONG'];
  assert.equal(onlyReferences('%PASS%', names), true);
  assert.equal(onlyReferences('%PASS%%PASS_LONG%', names), true);
  assert.equal(onlyReferences('x%PASS%', names), false);
  assert.equal(onlyReferences('%PASS%%USER%', names), false);
  assert.equal(onlyReferences('hunter2', names), false);
  assert.equal(onlyReferences('', names), false);
  assert.equal(onlyReferences('%PASS%', []), false);
});

test('a tool runs with the values, the model sees a secret only by name, and file writers keep %NAME%', async (t) => {
  const root = scratch(t);
  saveSecret(root, 'API_TOKEN', 'value-the-model-must-not-see');
  const seen: { args: Record<string, unknown>; context: ToolContext }[] = [];
  const echo: Tool = {
    name: 'echo_login',
    description: 'echoes what it was given',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    run: async (args, context) => {
      seen.push({ args: structuredClone(args), context });
      return `the server said: ${String(args.text)}`;
    },
  };
  const failing: Tool = {
    ...echo,
    name: 'failing_login',
    run: async (args) => {
      throw new Error(`refused ${String(args.text)}`);
    },
  };
  const writer: Tool = { ...echo, name: 'note_writer', variables: false };
  const model = new ScriptedModel([
    {
      message: {
        id: 'calls',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'echo',
            name: 'echo_login',
            args: { text: '%USER_NAME%/%API_TOKEN%' },
          },
          {
            id: 'fail',
            name: 'failing_login',
            args: { text: '%API_TOKEN%' },
          },
          {
            id: 'write',
            name: 'note_writer',
            args: { text: 'TOKEN=%API_TOKEN% USER=%USER_NAME%' },
          },
          {
            id: 'plain',
            name: 'echo_login',
            args: { text: '%USER_NAME%' },
          },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const settings = trustFolder(defaultSettings(), root);
  settings.variables = { USER_NAME: 'admin' };
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model,
    extraTools: [echo, failing, writer],
  });
  t.after(() => runtime.close());
  await runtime.harness.run('log in');
  assert.equal(seen[0]!.args.text, 'admin/value-the-model-must-not-see');
  assert.deepEqual(seen[0]!.context.secretNames, ['API_TOKEN']);
  assert.equal(seen[0]!.context.rawArgs?.text, '%USER_NAME%/%API_TOKEN%');
  // A tool that keeps its text gets the references, not the values
  assert.equal(seen[1]!.args.text, 'TOKEN=%API_TOKEN% USER=%USER_NAME%');
  assert.equal(seen[1]!.context.secretNames, undefined);
  assert.equal(seen[1]!.context.rawArgs, undefined);
  // A plain variable is put in, and its value is not hidden from the model
  assert.equal(seen[2]!.args.text, 'admin');
  assert.equal(seen[2]!.context.secretNames, undefined);
  assert.equal(seen[2]!.context.rawArgs?.text, '%USER_NAME%');
  const results = model.requests[1]!.messages.filter(
    (message) => message.role === 'tool',
  );
  const result = (id: string) =>
    results.find((row) => row.tool_call_id === id)!.content;
  assert.equal(result('echo'), 'the server said: admin/%API_TOKEN%');
  assert.equal(result('fail'), 'refused %API_TOKEN%');
  assert.equal(result('plain'), 'the server said: admin');
  assert.equal(
    JSON.stringify(model.requests).includes('value-the-model-must-not-see'),
    false,
  );
  assert.match(model.requests[0]!.system, /API_TOKEN/);
  assert.match(model.requests[0]!.system, /- USER_NAME = admin/);
  assert.equal(
    model.requests[0]!.system.includes('value-the-model-must-not-see'),
    false,
  );
  // The built-in file writers keep %NAME% as text
  const tools = runtime.allTools;
  for (const name of ['write_file', 'edit_file', 'apply_patch'])
    assert.equal(tools.find((tool) => tool.name === name)?.variables, false);
  assert.equal(
    tools.find((tool) => tool.name === 'execute')?.variables,
    undefined,
  );
});

test('a secret question without a target file keeps the value as a Circle secret', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    {
      message: {
        id: 'ask',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'question',
            name: 'question',
            args: {
              questions: [
                {
                  question: 'The API token?',
                  secret: true,
                  key: 'API_TOKEN',
                },
              ],
            },
          },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'kept' } },
  ]);
  const { submitAnswer } = await import('../src/secret_prompt.js');
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    secret: async (request) => {
      assert.equal(request.target_file, '');
      await submitAnswer(root, request.id, 'typed-by-the-person');
    },
  });
  t.after(() => runtime.close());
  await runtime.harness.run('ask me');
  assert.deepEqual(loadSecrets(root), {
    API_TOKEN: 'typed-by-the-person',
  });
  const result = model.requests[1]!.messages.find(
    (message) => message.role === 'tool',
  )!;
  assert.match(
    String(result.content),
    /API_TOKEN → collected and kept as a Circle secret; write %API_TOKEN%/,
  );
  assert.equal(
    JSON.stringify(model.requests).includes('typed-by-the-person'),
    false,
  );
  assert.equal(readFileSync(secretsPath(root), 'utf8').length > 0, true);
});

test('a secret that is also a plain variable is not hidden behind the secret name', async (t) => {
  const root = scratch(t);
  // A lab device whose password is its user name
  saveSecret(root, 'LAB_PASSWORD', 'admin');
  saveSecret(root, 'LAB_TOKEN', 'token-value-1');
  const echo: Tool = {
    name: 'echo_text',
    description: 'echoes what it was given',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    run: async (args) => `field: ${String(args.text)}`,
  };
  const model = new ScriptedModel([
    {
      message: {
        id: 'calls',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'user',
            name: 'echo_text',
            args: { text: '%LAB_USER% %LAB_TOKEN%' },
          },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const settings = trustFolder(defaultSettings(), root);
  settings.variables = { LAB_USER: 'admin' };
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model,
    extraTools: [echo],
  });
  t.after(() => runtime.close());
  await runtime.harness.run('fill the user');
  const result = model.requests[1]!.messages.find(
    (message) => message.role === 'tool',
  )!;
  assert.equal(result.content, 'field: admin %LAB_TOKEN%');
});

test('a secret question that is not answered asks again rather than pointing to a file', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    {
      message: {
        id: 'ask',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'question',
            name: 'question',
            args: {
              questions: [
                { question: 'The API token?', secret: true, key: 'API_TOKEN' },
              ],
            },
          },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'waiting' } },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    secret: async () => {
      throw new Error('the card was closed');
    },
  });
  t.after(() => runtime.close());
  await runtime.harness.run('ask me');
  const result = String(
    model.requests[1]!.messages.find((message) => message.role === 'tool')!
      .content,
  );
  assert.match(result, /the secret was not collected/);
  assert.match(result, /Ask again with the question tool/);
  assert.doesNotMatch(result, /target file/);
  assert.deepEqual(loadSecrets(root), {});
});

test('the model is told the variables with their values and the secrets by name only', () => {
  const settings = loadSettingsFromDict({
    variables: {
      BASE_URL: 'https://example.test',
      USER_NAME: 'admin',
      lower: 'dropped',
      TOO_LONG: 'x'.repeat(2001),
      NOT_TEXT: 7,
    },
  });
  assert.deepEqual(settings.variables, {
    BASE_URL: 'https://example.test',
    USER_NAME: 'admin',
  });
  const prompt = buildSystemPrompt(
    tmpdir(),
    'model',
    'openai',
    { no_context_files: true } as never,
    undefined,
    {
      localContext: false,
      variables: settings.variables,
      secrets: ['API_TOKEN'],
    },
  );
  assert.match(prompt, /<variables>/);
  assert.match(prompt, /- BASE_URL = https:\/\/example\.test/);
  assert.match(prompt, /- USER_NAME = admin/);
  assert.match(prompt, /which you know only by name: API_TOKEN/);
  assert.match(prompt, /Write %NAME% in a tool's arguments/);
  const plain = buildSystemPrompt(
    tmpdir(),
    'model',
    'openai',
    { no_context_files: true } as never,
    undefined,
    { localContext: false },
  );
  assert.equal(plain.includes('<variables>'), false);
});
