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
import { setTimeout as delay } from 'node:timers/promises';
import {
  packToolArgv,
  parsePackTools,
  readPackTools,
} from '../src/pack_tools.js';
import { AgentRuntime } from '../src/runtime.js';
import { saveSecret } from '../src/secrets.js';
import { defaultSettings, saveSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message } from '../src/types.js';
import { discoverSkills, loadSkillBody } from '../src/skills.js';
import { cleanup, scratch, until } from './helpers.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Installs a pack as `skill_install` leaves it: its files and a `pack.json` that lists each with its digest. */
function installPack(root: string, id: string, files: Record<string, string>) {
  const directory = join(root, id);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  writeFileSync(
    join(directory, 'pack.json'),
    JSON.stringify({
      schema: 'pack@1',
      id,
      version: '1.0.0',
      files: Object.entries(files)
        .map(([path, content]) => ({
          path,
          sha256: sha(content),
          size: Buffer.byteLength(content),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
    }),
  );
  return directory;
}

const CONVERT = {
  name: 'convert',
  description: 'Convert a text file to PDF or HTML.',
  script: 'tools/convert.mjs',
  input_schema: {
    type: 'object',
    properties: {
      in: { type: 'string', description: 'The text file' },
      format: { enum: ['pdf', 'html'] },
      title: { type: 'string' },
      tag: { type: 'array', items: { type: 'string' } },
      draft: { type: 'boolean' },
    },
    required: ['in', 'format'],
  },
  args: [
    '--in',
    '{in}',
    '--format',
    '{format}',
    { flag: '--title', param: 'title' },
    { flag: '--tag', param: 'tag' },
    { flag: '--draft', param: 'draft' },
  ],
  env: { HUB_TOKEN: '%HUB_TOKEN%' },
};

test('a pack declaration is checked before any tool is offered', () => {
  const files = ['tools/convert.mjs', 'tools.json', 'SKILL.md'];
  const parse = (tools: unknown[], listed = files) =>
    parsePackTools(JSON.stringify({ version: 1, tools }), listed);
  const [tool] = parse([CONVERT]);
  // Only what the declaration names reaches the script
  assert.equal(tool?.input_schema.additionalProperties, false);
  assert.deepEqual(tool?.env, { HUB_TOKEN: '%HUB_TOKEN%' });
  const refused = (tools: unknown[], pattern: RegExp, listed = files) =>
    assert.throws(() => parse(tools, listed), pattern);
  refused([{ ...CONVERT, script: '../outside.mjs' }], /under tools\//);
  refused([{ ...CONVERT, script: 'tools/run.sh' }], /\.js or \.ts/);
  refused([CONVERT], /that the pack lists/, ['tools.json']);
  refused([{ ...CONVERT, args: ['{title}'] }], /optional title needs the form/);
  refused([{ ...CONVERT, args: ['{nope}'] }], /nope, which is not a property/);
  refused([{ ...CONVERT, env: { PATH: '/tmp' } }], /env cannot set PATH/);
  refused([CONVERT, CONVERT], /declared twice/);
  refused(
    [
      {
        ...CONVERT,
        input_schema: {
          type: 'object',
          properties: { in: { $ref: '#/x' } },
        },
      },
    ],
    /tools\.json/,
  );
  assert.throws(() => parsePackTools('{', files), /not JSON/);
});

test('the template turns the input into arguments, and a literal takes plain variables only', () => {
  assert.deepEqual(
    packToolArgv(
      [...CONVERT.args, '--server', '%HUB_URL%', '--token', '%HUB_TOKEN%'],
      { in: 'a b.txt', format: 'pdf', tag: ['x', 'y'], draft: true },
      { HUB_URL: 'http://127.0.0.1:1' },
    ),
    [
      '--in',
      'a b.txt',
      '--format',
      'pdf',
      '--tag',
      'x',
      '--tag',
      'y',
      '--draft',
      '--server',
      'http://127.0.0.1:1',
      '--token',
      '%HUB_TOKEN%',
    ],
  );
  // An optional flag with no value, or false, is left out
  assert.deepEqual(
    packToolArgv(CONVERT.args, { in: 'a', format: 'html', draft: false }, {}),
    ['--in', 'a', '--format', 'html'],
  );
});

test('a pack whose files no longer match its manifest offers no tools', (t) => {
  const root = realpathSync(scratch(t));
  const directory = installPack(root, 'example-pack', {
    'tools.json': JSON.stringify({ version: 1, tools: [CONVERT] }),
    'tools/convert.mjs': 'process.exit(0);\n',
  });
  return (async () => {
    assert.equal((await readPackTools(root, 'example-pack')).length, 1);
    writeFileSync(
      join(directory, 'tools.json'),
      JSON.stringify({ version: 1, tools: [{ ...CONVERT, env: {} }] }),
    );
    await assert.rejects(readPackTools(root, 'example-pack'));
  })();
});

test('a loaded pack offers its declared scripts as typed tools that check their input before the script runs', async (t) => {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  const workspace = join(root, 'project');
  mkdirSync(home);
  mkdirSync(workspace);
  const packs = join(userHome, '.agents', 'skills');
  mkdirSync(packs, { recursive: true });
  const marker = join(root, 'runs.jsonl');
  const script = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
  argv: process.argv.slice(2),
  token: process.env.HUB_TOKEN ?? null,
  session: process.env.CIRCLE_SESSION_ID ?? null,
  stdin: readFileSync(0, 'utf8'),
  cwd: process.cwd(),
  skillDir: process.env.CIRCLE_SKILL_DIR ?? null,
  data: process.env.CIRCLE_SKILL_DATA ?? null,
  leaked: process.env.CIRCLE_TEST_YOURS ?? null,
}) + '\\n');
// A relative path is the workspace's
writeFileSync('converted.txt', 'done');
console.log('converted with ' + process.env.HUB_TOKEN);
`;
  installPack(packs, 'example-pack', {
    'SKILL.md':
      '---\nname: example-pack\ndescription: Converts text files.\n---\n\nUse the convert tool.\n',
    'tools.json': JSON.stringify({ version: 1, tools: [CONVERT] }),
    'tools/convert.mjs': script,
    'tools/env.mjs':
      'console.log(JSON.stringify([process.env.CIRCLE_SESSION_ID ?? null, process.env.CIRCLE_AGENT_ID ?? null]));\n',
  });
  saveSecret(home, 'HUB_TOKEN', 'synthetic-hub-token');
  // A variable of yours a pack's script must not see
  process.env.CIRCLE_TEST_YOURS = 'yours';
  t.after(() => {
    delete process.env.CIRCLE_TEST_YOURS;
  });
  const call = (id: string, name: string, args: Record<string, unknown>) => ({
    message: {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      tool_calls: [{ id, name, args }],
    } satisfies Message,
  });
  const model = new ScriptedModel([
    // A skill that cannot be read is not loaded: its tools do not start
    call('missing', 'skill', { name: 'example-pack', reference: 'nope.md' }),
    call('load', 'skill', { name: 'example-pack' }),
    call('bad', 'example-pack_convert', { in: 'a.txt', format: 'docx' }),
    // What the model writes is checked and runs as written: a variable's or a secret's name is not its value here
    call('good', 'example-pack_convert', {
      in: '%IN_FILE%',
      format: 'pdf',
      title: '%HUB_TOKEN%',
    }),
    // The same script by another case of its path
    call('free', 'skill_run', {
      pack: 'example-pack',
      script: 'tools/Convert.mjs',
      args: ['--in', 'a.txt'],
    }),
    // A script with no declaration runs through skill_run, and knows the conversation too (#551)
    call('plain', 'skill_run', {
      pack: 'example-pack',
      script: 'tools/env.mjs',
    }),
    {
      message: { id: crypto.randomUUID(), role: 'assistant', content: 'done' },
    },
  ]);
  const runtime = new AgentRuntime({
    workspace,
    home,
    userHome,
    localSkillsRoot: packs,
    settings: { ...defaultSettings(), variables: { IN_FILE: '/etc/passwd' } },
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.setMode('auto');
  await runtime.harness.run('convert a.txt');

  const offered = (index: number) =>
    model.requests[index]!.tools.map((tool) => tool.name);
  // Not before the skill loads; from the next request on, with only the declared parameters
  assert.ok(!offered(0).includes('example-pack_convert'));
  assert.ok(!offered(1).includes('example-pack_convert'));
  assert.ok(offered(2).includes('example-pack_convert'));
  const tool = model.requests[2]!.tools.find(
    (item) => item.name === 'example-pack_convert',
  )!;
  // The declared input, then how long and where it runs, as execute takes them
  assert.deepEqual(Object.keys(tool.parameters.properties as object), [
    'in',
    'format',
    'title',
    'tag',
    'draft',
    'timeout',
    'background',
  ]);
  assert.doesNotMatch(JSON.stringify(tool), /HUB_TOKEN/);
  const results = model.requests
    .at(-1)!
    .messages.filter((message) => message.role === 'tool');
  assert.doesNotMatch(String(results[0]?.content), /offered/);
  assert.match(
    String(results[1]?.content),
    /offered from the next request: example-pack_convert \(tools\/convert\.mjs\)/,
  );
  // A value outside the declared ones is refused before the script starts
  assert.match(
    String(results[2]?.content),
    /example-pack_convert was called with invalid arguments.*format/,
  );
  // The script ran once: with the arguments the template made and the secret in its environment, which the
  // model reads back only as its name
  const runs = readFileSync(marker, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  // It ran in the workspace, found its pack and its data folder by name, and got nothing else of yours
  assert.deepEqual(runs, [
    {
      argv: ['--in', '%IN_FILE%', '--format', 'pdf', '--title', '%HUB_TOKEN%'],
      token: 'synthetic-hub-token',
      // The conversation the call runs for (#551)
      session: runtime.session.id,
      stdin: '',
      cwd: realpathSync(workspace),
      skillDir: realpathSync(join(packs, 'example-pack')),
      data: join(home, 'skill-data', 'example-pack'),
      leaked: null,
    },
  ]);
  assert.equal(readFileSync(join(workspace, 'converted.txt'), 'utf8'), 'done');
  // The pack is as it was installed: what the script wrote is not in it
  assert.equal((await readPackTools(packs, 'example-pack')).length, 1);
  assert.match(
    String(results[3]?.content),
    /converted with %HUB_TOKEN%\n[\s\S]*Exit code: 0$/,
  );
  assert.doesNotMatch(
    model.requests
      .at(-1)!
      .messages.map((m) => String(m.content))
      .join('\n'),
    /synthetic-hub-token/,
  );
  // skill_run points at the typed tool for a declared script, whatever the case of its path
  assert.match(
    String(results[4]?.content),
    /The pack declares this script's parameters: call example-pack_convert/,
  );
  // skill_run's output comes back as execute's: what the script printed, then its exit code
  assert.deepEqual(JSON.parse(String(results[5]?.content).split('\n')[0]!), [
    runtime.session.id,
    null,
  ]);
  // Loaded again, the skill tells the model again which tools it has
  assert.match(
    await runtime.activateSkillHooks('example-pack'),
    /offered from the next request: example-pack_convert/,
  );
});

test("a pack's tool gives way to an extension's tool of the same name, and the tool list still refreshes", async (t) => {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const settings = trustFolder(defaultSettings(), workspace);
  saveSettings(settings, home);
  const packs = join(userHome, '.agents', 'skills');
  mkdirSync(packs, { recursive: true });
  installPack(packs, 'example-pack', {
    'SKILL.md':
      '---\nname: example-pack\ndescription: Converts text files.\n---\n\nUse the convert tool.\n',
    'tools.json': JSON.stringify({ version: 1, tools: [CONVERT] }),
    'tools/convert.mjs': "console.log('from the pack');\n",
  });
  // An extension that, once connected, offers a tool with the pack tool's name
  const extension = join(home, 'extensions', 'remote');
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, 'extension.mjs'),
    `export function register(api){
      const schema = { type: 'object', properties: {} };
      api.registerTool('connect', 'connect', schema, () => {
        api.registerTool('example-pack_convert', 'convert', schema, () => 'from the extension', { readOnly: true });
        return 'connected';
      }, { readOnly: true });
    }`,
  );
  const call = (id: string, name: string, args: Record<string, unknown>) => ({
    message: {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      tool_calls: [{ id, name, args }],
    } satisfies Message,
  });
  const say = (content: string) => ({
    message: {
      id: crypto.randomUUID(),
      role: 'assistant',
      content,
    } satisfies Message,
  });
  const model = new ScriptedModel([
    call('load', 'skill', { name: 'example-pack' }),
    call('connect', 'connect', {}),
    say('connected'),
    call('use', 'example-pack_convert', {}),
    say('done'),
  ]);
  const runtime = new AgentRuntime({
    workspace,
    home,
    userHome,
    localSkillsRoot: packs,
    settings,
    model,
    headless: true,
    // Load the extension in a headless run, as `--extensions` does
    integrations: true,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  runtime.setMode('auto');
  await runtime.harness.run('load and connect');
  // Between turns the list is built again: the extension's tool takes the name, once
  await delay(5);
  await runtime.harness.run('convert');
  const names = model.requests.at(-2)!.tools.map((tool) => tool.name);
  assert.equal(
    names.filter((name) => name === 'example-pack_convert').length,
    1,
  );
  const results = runtime.harness.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.equal(results.at(-1)?.content, 'from the extension');
});

/** A runtime with one installed pack whose tool `run` is `script`, loaded, and the tool as the model calls it. */
async function loadedTool(
  t: Parameters<typeof scratch>[0],
  script: string,
  before?: (packs: string) => void,
) {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  const workspace = join(root, 'project');
  mkdirSync(home);
  mkdirSync(workspace);
  const packs = join(userHome, '.agents', 'skills');
  mkdirSync(packs, { recursive: true });
  installPack(packs, 'example-pack', {
    'SKILL.md':
      '---\nname: example-pack\ndescription: Runs a script.\n---\n\nUse run.\n',
    'tools.json': JSON.stringify({
      version: 1,
      tools: [
        {
          name: 'run',
          description: 'Run the script.',
          script: 'tools/run.mjs',
          input_schema: { type: 'object', properties: {} },
        },
      ],
    }),
    'tools/run.mjs': script,
  });
  before?.(packs);
  const runtime = new AgentRuntime({
    workspace,
    home,
    userHome,
    localSkillsRoot: packs,
    settings: defaultSettings(),
    model: new ScriptedModel([]),
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  await runtime.activateSkillHooks('example-pack');
  const tool = runtime.harness.tools.find(
    (item) => item.name === 'example-pack_run',
  )!;
  assert.ok(tool, 'the pack offers its tool');
  const call = (args: Record<string, unknown>, signal: AbortSignal) =>
    tool.run(args, {
      sessionId: runtime.session.id,
      callId: crypto.randomUUID(),
      signal,
    });
  return { root, packs, runtime, call };
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A script that starts a process of its own, says both ids, and waits. */
const WAITS = (file: string) => `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(file)}, JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`;

test('a declared script given a timeout is ended then, together with what it started', async (t) => {
  const file = join(realpathSync(scratch(t)), 'pids.json');
  const { call } = await loadedTool(t, WAITS(file));
  await assert.rejects(
    () => call({ timeout: 1 }, new AbortController().signal),
    /Command ended: timeout[\s\S]*Exit code: [1-9]\d*/,
  );
  const pids = JSON.parse(readFileSync(file, 'utf8')) as number[];
  for (const pid of pids) await until(() => !alive(pid), { timeout: 10_000 });
});

test('esc on a declared script ends it and what it started', async (t) => {
  const file = join(realpathSync(scratch(t)), 'pids.json');
  const { call } = await loadedTool(t, WAITS(file));
  const controller = new AbortController();
  const running = call({}, controller.signal);
  await until(() => existsSync(file), { timeout: 10_000 });
  controller.abort(new Error('esc'));
  await assert.rejects(running);
  const pids = JSON.parse(readFileSync(file, 'utf8')) as number[];
  for (const pid of pids) await until(() => !alive(pid), { timeout: 10_000 });
});

test('a declared script can start as a background job, as execute can', async (t) => {
  const { call } = await loadedTool(t, "console.log('started');\n");
  assert.match(
    String(await call({ background: true }, new AbortController().signal)),
    /^In background: j\d+ · shell · /,
  );
});

test('a character a script writes in two pieces reaches the model whole', async (t) => {
  const { call } = await loadedTool(
    t,
    `process.stdout.write(Buffer.from([0xe4]));
setTimeout(() => process.stdout.write(Buffer.from([0xb8, 0xad, 0x0a])), 100);
`,
  );
  const result = String(await call({}, new AbortController().signal));
  assert.match(result, /^中\n/);
  assert.doesNotMatch(result, /\uFFFD/);
});

test('a skill folder under the packs without a pack.json is not a pack: loading it says nothing of tools', async (t) => {
  const { packs, runtime } = await loadedTool(
    t,
    'process.exit(0);\n',
    (packs) => {
      mkdirSync(join(packs, 'plain'));
      writeFileSync(
        join(packs, 'plain', 'SKILL.md'),
        '---\nname: plain\ndescription: A skill of your own.\n---\n\nPlain.\n',
      );
    },
  );
  assert.deepEqual(await readPackTools(packs, 'plain'), []);
  // It is a skill the session knows, so loading it does reach the pack check
  assert.ok(runtime.skills.some((skill) => skill.name === 'plain'));
  assert.equal(await runtime.activateSkillHooks('plain'), '');
});

test("a declaration cannot name the run options as its input, or set Circle's own variables", () => {
  const files = ['tools/convert.mjs', 'tools.json', 'SKILL.md'];
  const declare = (tool: Record<string, unknown>) =>
    JSON.stringify({ version: 1, tools: [{ ...CONVERT, ...tool }] });
  assert.throws(
    () =>
      parsePackTools(
        declare({
          input_schema: {
            type: 'object',
            properties: { timeout: { type: 'integer' } },
          },
          args: [],
        }),
        files,
      ),
    /timeout is how long or where the script runs/,
  );
  assert.throws(
    () => parsePackTools(declare({ env: { CIRCLE_SKILL_DIR: '/x' } }), files),
    /env cannot set CIRCLE_SKILL_DIR/,
  );
});

test('SKILL.md names its own folder with ${CIRCLE_SKILL_DIR}', (t) => {
  const root = realpathSync(scratch(t));
  const workspace = join(root, 'project');
  const folder = join(workspace, '.agents', 'skills', 'kit');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'SKILL.md'),
    '---\nname: kit\ndescription: A kit.\n---\n\nRun node ${CIRCLE_SKILL_DIR}/scripts/go.mjs.\n',
  );
  const skills = discoverSkills(
    workspace,
    join(root, 'home'),
    join(root, 'user'),
    false,
  );
  const body = loadSkillBody('kit', skills);
  assert.match(
    body,
    new RegExp(
      `Run node ${folder.replace(/[\\\\^$.*+?()[\]{}|]/g, '\\$&')}/scripts/go\\.mjs`,
    ),
  );
  assert.doesNotMatch(body, /\$\{CIRCLE_SKILL_DIR\}/);
});

test("a subagent that loads a pack's skill can call the pack's tools from its next request; explore is told it has none", async (t) => {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  const workspace = join(root, 'project');
  mkdirSync(home);
  mkdirSync(workspace);
  const packs = join(userHome, '.agents', 'skills');
  mkdirSync(packs, { recursive: true });
  const marker = join(root, 'ran');
  installPack(packs, 'example-pack', {
    'SKILL.md':
      '---\nname: example-pack\ndescription: Converts text files.\n---\n\nUse the convert tool.\n',
    'tools.json': JSON.stringify({
      version: 1,
      tools: [{ ...CONVERT, env: {} }],
    }),
    'tools/convert.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));\nconsole.log('converted');\n`,
  });
  const say = (calls: Message['tool_calls'], text = '') => ({
    message: {
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      content: text,
      tool_calls: calls,
    },
  });
  const model = new ScriptedModel([
    say([
      {
        id: 'worker',
        name: 'task',
        args: {
          description: 'convert a.txt',
          subagent_type: 'general-purpose',
        },
      },
    ]),
    // The subagent loads the skill, then calls the tool it brings
    say([{ id: 'load', name: 'skill', args: { name: 'example-pack' } }]),
    say([
      {
        id: 'convert',
        name: 'example-pack_convert',
        args: { in: 'a.txt', format: 'pdf' },
      },
    ]),
    say([], 'converted a.txt'),
    say([
      {
        id: 'looker',
        name: 'task',
        args: { description: 'look around', subagent_type: 'explore' },
      },
    ]),
    say([{ id: 'peek', name: 'skill', args: { name: 'example-pack' } }]),
    say([], 'looked'),
    say([], 'done'),
  ]);
  const runtime = new AgentRuntime({
    workspace,
    home,
    userHome,
    localSkillsRoot: packs,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('convert a.txt, then look around');
  // The subagent's call ran the script
  assert.equal(readFileSync(marker, 'utf8'), '--in a.txt --format pdf');
  const toolResult = (id: string) =>
    model.requests
      .flatMap((request) => request.messages)
      .find((message) => message.tool_call_id === id)?.content ?? '';
  assert.match(
    String(toolResult('load')),
    /offered to you from the next request: example-pack_convert/,
  );
  assert.match(String(toolResult('convert')), /converted/);
  // explore reads and looks only: it is told the tools are not its own
  assert.match(
    String(toolResult('peek')),
    /declares tools this subagent does not have: example-pack_convert/,
  );
});
