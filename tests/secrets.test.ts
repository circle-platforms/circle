import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
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
  secretRedactor,
  standsIn,
  written,
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
  loadSettings,
  loadSettingsFromDict,
  trustFolder,
} from '../src/settings.js';
import { buildSystemPrompt } from '../src/system_prompt.js';
import type { Tool, ToolContext } from '../src/types.js';
import { cleanup, scratch as made } from './helpers.js';

const scratch = (t: test.TestContext) => made(t, 'circle-secrets-');

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
  cleanup(t, () => runtime.close());
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
  cleanup(t, () => runtime.close());
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
  cleanup(t, () => runtime.close());
  await runtime.harness.run('fill the user');
  const result = model.requests[1]!.messages.find(
    (message) => message.role === 'tool',
  )!;
  assert.equal(result.content, 'field: admin %LAB_TOKEN%');
});

test('a value stands in text only as a whole word, and what the person and the model wrote leaves out notices and command output', () => {
  assert.equal(standsIn('用户名 admin，登录后告诉我', 'admin'), true);
  assert.equal(standsIn('admin', 'admin'), true);
  assert.equal(standsIn('value="admin"', 'admin'), true);
  assert.equal(standsIn('the administrator', 'admin'), false);
  assert.equal(standsIn('sysadmin', 'admin'), false);
  assert.equal(standsIn('admin_2 or 管理admin', 'admin'), false);
  assert.equal(standsIn('sysadmin, then admin', 'admin'), true);
  assert.equal(standsIn('', 'admin'), false);
  assert.equal(standsIn('anything', ''), false);
  assert.deepEqual(
    written([
      { id: '1', role: 'user', content: 'sign in as admin' },
      {
        id: '2',
        role: 'assistant',
        content: 'typing',
        tool_calls: [
          {
            id: 'c',
            name: 'fill',
            args: { fields: [{ text: 'admin' }], password: '%PASS%', n: 3 },
          },
        ],
      },
      {
        id: '3',
        role: 'tool',
        content: 'page shows hunter2',
        tool_call_id: 'c',
      },
      {
        id: '4',
        role: 'user',
        content: 'job printed hunter2',
        internal: 'job_notice',
      },
      {
        id: '5',
        role: 'user',
        content: '!cat notes',
        shell: { command: 'cat notes', output: 'hunter2', exit_code: 0 },
      },
    ]),
    ['sign in as admin', 'typing', 'admin', '%PASS%'],
  );
  const redact = secretRedactor(() => ({
    PASS: 'admin',
    TOKEN: 'token-value-1',
  }));
  let read = 0;
  const known = () => {
    read += 1;
    return ['sign in as admin'];
  };
  assert.equal(
    redact('value="admin" token-value-1', {}, known),
    'value="admin" %TOKEN%',
  );
  // Inside another word in what was written, or with nothing written, the value is hidden
  assert.equal(
    redact('value="admin"', {}, () => ['the administrator']),
    'value="%PASS%"',
  );
  assert.equal(redact('value="admin"'), 'value="%PASS%"');
  // What was written is read only when a secret's value is in the text
  read = 0;
  assert.equal(redact('nothing secret here', {}, known), 'nothing secret here');
  assert.equal(read, 0);
});

test('a user name that is also the password stays as the person and the model wrote it, in a page and in a background notice', async (t) => {
  const root = scratch(t);
  // A lab device whose password is its user name; the person names the user in the prompt
  saveSecret(root, 'LAB_PASSWORD', 'admin');
  saveSecret(root, 'LAB_TOKEN', 'token-value-1');
  const fields: Record<string, string> = { user: '', password: '' };
  const form: Tool = {
    name: 'fill_field',
    description: 'types into a sign-in form and shows the form',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: { field: { type: 'string' }, text: { type: 'string' } },
      required: ['field', 'text'],
    },
    run: async (args) => {
      fields[String(args.field)] = String(args.text);
      return [
        `textbox "user" value="${fields.user}"`,
        `password "password" ${fields.password ? 'filled' : 'empty'}`,
        'session token-value-1',
      ].join('\n');
    },
  };
  const step = (id: string, name: string, args: Record<string, unknown>) => ({
    message: {
      id,
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id, name, args }],
    },
  });
  const model = new ScriptedModel([
    step('user', 'fill_field', { field: 'user', text: 'admin' }),
    step('password', 'fill_field', {
      field: 'password',
      text: '%LAB_PASSWORD%',
    }),
    step('job', 'execute', {
      command: 'echo signed in as admin with %LAB_TOKEN%',
      background: true,
    }),
    { message: { id: 'first', role: 'assistant', content: 'signed in' } },
    { message: { id: 'second', role: 'assistant', content: 'seen' } },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: [form],
    approve: async () => 'approve',
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('sign in to the lab device as admin');
  const end = Date.now() + 10000;
  while (
    runtime.jobs.list().some((job) => job.status === 'running') &&
    Date.now() < end
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  await runtime.harness.run('anything new?');
  // The page got the password; the model reads the user name it typed, not the secret's name
  assert.deepEqual(fields, { user: 'admin', password: 'admin' });
  const last = model.requests.at(-1)!.messages;
  const result = (id: string) =>
    last.find((message) => message.tool_call_id === id)!.content;
  assert.equal(
    result('password'),
    'textbox "user" value="admin"\npassword "password" filled\nsession %LAB_TOKEN%',
  );
  const notice = last.find((message) => message.internal === 'job_notice');
  assert(notice, 'the background notice reached the model');
  assert.match(String(notice.content), /signed in as admin with %LAB_TOKEN%/);
  // In history too: no tool result or notice shows the user name as the secret
  const stored = runtime.store
    .messages(runtime.session.id)
    .filter((message) => message.role === 'tool' || message.internal);
  assert.equal(JSON.stringify(stored).includes('%LAB_PASSWORD%'), false);
  assert.equal(JSON.stringify(model.requests).includes('token-value-1'), false);
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
  cleanup(t, () => runtime.close());
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

test('a command is judged by what it runs: a variable that makes it delete asks, even under a rule for commands that only read', async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'victim.txt'), 'keep me');
  const model = new ScriptedModel([
    {
      message: {
        id: 'run',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'ls', name: 'execute', args: { command: 'ls %TAIL%' } },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const settings = trustFolder(defaultSettings(), root);
  settings.variables = { TAIL: '&& rm victim.txt' };
  const cards: string[] = [];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model,
    approve: async (call) => {
      cards.push(String(call.args.command));
      return 'reject';
    },
  });
  cleanup(t, () => runtime.close());
  // Commands that only read are allowed for the session
  assert.equal(
    runtime.policy.remember(
      runtime.session.id,
      'execute',
      { command: 'ls' },
      'always',
    ),
    true,
  );
  await runtime.harness.run('list the folder');
  // The card shows what would run; the person said no, and nothing was deleted
  assert.deepEqual(cards, ['ls && rm victim.txt']);
  assert.equal(readFileSync(join(root, 'victim.txt'), 'utf8'), 'keep me');
});

test("a secret stays its name where a model reads it: a subagent's task, a background job's notice, and a value changed while a tool used the old one", async (t) => {
  const root = scratch(t);
  saveSecret(root, 'API_TOKEN', 'old-token-value');
  const rotating: Tool = {
    name: 'rotating_login',
    description: 'uses the token, which is changed meanwhile',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    run: async (args) => {
      saveSecret(root, 'API_TOKEN', 'new-token-value');
      return `sent ${String(args.text)}`;
    },
  };
  const step = (id: string, name: string, args: Record<string, unknown>) => ({
    message: {
      id,
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id, name, args }],
    },
  });
  const model = new ScriptedModel([
    step('task', 'task', {
      description: 'Call the API using %API_TOKEN%',
      subagent_type: 'general-purpose',
    }),
    // The subagent's own turn
    { message: { id: 'child', role: 'assistant', content: 'child done' } },
    step('job', 'execute', {
      command: 'echo %API_TOKEN%',
      background: true,
    }),
    step('rotate', 'rotating_login', { text: '%API_TOKEN%' }),
    { message: { id: 'first', role: 'assistant', content: 'started' } },
    { message: { id: 'second', role: 'assistant', content: 'seen' } },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: [rotating],
    approve: async () => 'approve',
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('use the token');
  // The background command ends, and its notice comes with the next turn
  const end = Date.now() + 10000;
  while (
    runtime.jobs.list().some((job) => job.status === 'running') &&
    Date.now() < end
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  await runtime.harness.run('anything new?');
  // The subagent was given the name; its tools would put the value in
  const child = model.requests[1]!;
  assert(
    JSON.stringify(child.messages).includes('Call the API using %API_TOKEN%'),
  );
  const everything = JSON.stringify(model.requests);
  assert.equal(everything.includes('old-token-value'), false);
  assert.equal(everything.includes('new-token-value'), false);
  const rotated = model.requests
    .at(-2)!
    .messages.find((message) => message.tool_call_id === 'rotate')!;
  assert.equal(rotated.content, 'sent %API_TOKEN%');
  // The notice says what the command printed, by name, in the request and in history
  const notice = model.requests
    .at(-1)!
    .messages.find((message) => message.internal === 'job_notice');
  assert(notice, 'the background notice reached the model');
  assert.match(String(notice.content), /%API_TOKEN%/);
  const history = JSON.stringify(runtime.store.get(runtime.session.id));
  assert.equal(history.includes('old-token-value'), false);
});

test('a question with a key keeps the answer as a Circle variable, which the next tools take as %KEY%', async (t) => {
  const root = scratch(t);
  const seen: string[] = [];
  const echo: Tool = {
    name: 'echo_path',
    description: 'echoes the path',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    run: async (args) => {
      seen.push(String(args.path));
      return `listed ${String(args.path)}`;
    },
  };
  const step = (id: string, name: string, args: Record<string, unknown>) => ({
    message: {
      id,
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id, name, args }],
    },
  });
  const model = new ScriptedModel([
    step('ask', 'question', {
      questions: [
        { question: 'Where are the backups kept?', key: 'BACKUP_DIR' },
      ],
    }),
    step('use', 'echo_path', { path: '%BACKUP_DIR%/latest' }),
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const asked: unknown[] = [];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: [echo],
    // The person types the path on the question's card
    question: async (args) => {
      asked.push(structuredClone(args));
      return JSON.stringify([['/data/backups']]);
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('back up the device');
  // The card says the answer is kept, and under what name
  assert.equal(
    (asked[0] as { questions: { header: string }[] }).questions[0]!.header,
    '%BACKUP_DIR%',
  );
  // Saved for later runs, and told to the model with the next request
  assert.deepEqual(loadSettings(root).variables, {
    BACKUP_DIR: '/data/backups',
  });
  const answer = model.requests[1]!.messages.find(
    (message) => message.tool_call_id === 'ask',
  )!;
  assert.match(
    String(answer.content),
    /BACKUP_DIR = "\/data\/backups" — kept as a Circle variable; write %BACKUP_DIR%/,
  );
  assert.match(model.requests[1]!.system, /- BACKUP_DIR = \/data\/backups/);
  assert.deepEqual(seen, ['/data/backups/latest']);
});
