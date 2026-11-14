import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  packToolArgv,
  parsePackTools,
  readPackTools,
} from '../src/pack_tools.js';
import { AgentRuntime } from '../src/runtime.js';
import { saveSecret } from '../src/secrets.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

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
  const script = `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
  argv: process.argv.slice(2),
  token: process.env.HUB_TOKEN ?? null,
  stdin: readFileSync(0, 'utf8'),
}) + '\\n');
console.log('converted with ' + process.env.HUB_TOKEN);
`;
  installPack(packs, 'example-pack', {
    'SKILL.md':
      '---\nname: example-pack\ndescription: Converts text files.\n---\n\nUse the convert tool.\n',
    'tools.json': JSON.stringify({ version: 1, tools: [CONVERT] }),
    'tools/convert.mjs': script,
  });
  saveSecret(home, 'HUB_TOKEN', 'synthetic-hub-token');
  const call = (id: string, name: string, args: Record<string, unknown>) => ({
    message: {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      tool_calls: [{ id, name, args }],
    } satisfies Message,
  });
  const model = new ScriptedModel([
    call('load', 'skill', { name: 'example-pack' }),
    call('bad', 'example-pack_convert', { in: 'a.txt', format: 'docx' }),
    call('good', 'example-pack_convert', {
      in: 'a.txt',
      format: 'pdf',
      title: 'T',
    }),
    call('free', 'skill_run', {
      pack: 'example-pack',
      script: 'tools/convert.mjs',
      args: ['--in', 'a.txt'],
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
    settings: defaultSettings(),
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
  assert.ok(offered(1).includes('example-pack_convert'));
  const tool = model.requests[1]!.tools.find(
    (item) => item.name === 'example-pack_convert',
  )!;
  assert.deepEqual(Object.keys(tool.parameters.properties as object), [
    'in',
    'format',
    'title',
    'tag',
    'draft',
  ]);
  assert.doesNotMatch(JSON.stringify(tool), /HUB_TOKEN/);
  const results = model.requests
    .at(-1)!
    .messages.filter((message) => message.role === 'tool');
  assert.match(
    String(results[0]?.content),
    /offered from the next request: example-pack_convert \(tools\/convert\.mjs\)/,
  );
  // A value outside the declared ones is refused before the script starts
  assert.match(
    String(results[1]?.content),
    /example-pack_convert was called with invalid arguments.*format/,
  );
  // The script ran once: with the arguments the template made and the secret in its environment, which the
  // model reads back only as its name
  const runs = readFileSync(marker, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(runs, [
    {
      argv: ['--in', 'a.txt', '--format', 'pdf', '--title', 'T'],
      token: 'synthetic-hub-token',
      stdin: '',
    },
  ]);
  assert.match(String(results[2]?.content), /converted with %HUB_TOKEN%/);
  assert.doesNotMatch(
    model.requests
      .at(-1)!
      .messages.map((m) => String(m.content))
      .join('\n'),
    /synthetic-hub-token/,
  );
  // skill_run points at the typed tool for a declared script
  assert.match(String(results[3]?.content), /调用工具 example-pack_convert/);
});
