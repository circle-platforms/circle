import { test } from 'node:test';
import { cleanup, entryOf, scratch } from './helpers.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { saveSecret } from '../src/secrets.js';
import { ScriptedModel } from '../src/testing.js';
import { buildTools } from '../src/tools.js';
import { Sandbox } from '../src/sandbox.js';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
  writePrivateJson,
  type CircleSettings,
} from '../src/settings.js';
import type { Tool } from '../src/types.js';

function settingsWith(server: Record<string, unknown>): CircleSettings {
  return {
    version: 1,
    initialized: true,
    auth: {},
    trusted_folders: [],
    theme: 'auto',
    // The server under its name, its transport as the entry's type: over HTTP unless it says otherwise
    mcpServers: {
      [String(server.name)]: { type: 'http', ...entryOf(server) },
    },
    variables: {},
  } as unknown as CircleSettings;
}

const sha = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

test('tools are registered with the shared names and the execute effect when the hooks are present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-local-skills-'));
  try {
    const sandbox = new Sandbox(root);
    const tools = buildTools(sandbox, {
      localSkills: {
        home: root,
        settings: () =>
          settingsWith({
            name: 'example',
            url: 'http://127.0.0.1:1/mcp',
          }),
        secrets: () => ({ EXAMPLE_TOKEN: 't' }),
        variables: () => ({}),
        root: join(root, 'skills'),
      },
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get('skill_install')?.effect, 'execute');
    assert.equal(byName.get('skill_run')?.effect, 'execute');
    assert.equal(byName.get('skill_list')?.effect, 'read');
    const list = byName.get('skill_list');
    assert.ok(list !== undefined);
    assert.deepEqual(
      JSON.parse(String(await list.run({}, { signal: undefined } as never))),
      { skills: [] },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skill_install takes the token of the Hub entry signed in from the extension, which has no Authorization header', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-local-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tool = 'console.log("synthetic tool")\n';
  const files: Record<string, string> = {
    'SKILL.md': '# synthetic\n',
    'tools/fetch.ts': tool,
  };
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 'pack@1',
      id: 'demo-tools',
      version: '1.0.0',
      kind: 'workflow',
      title: 'synthetic',
      description: 'synthetic',
      files: Object.entries(files)
        .map(([path, content]) => ({
          path,
          sha256: sha(content),
          size: Buffer.byteLength(content),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
    }),
  );
  const sent: string[] = [];
  // The Hub: no discovery document, so its local tools are beside its MCP endpoint
  const hub = createServer((request, response) => {
    const url = request.url ?? '';
    if (url === '/.well-known/knowledge-sync') {
      response.writeHead(404).end();
      return;
    }
    sent.push(String(request.headers.authorization));
    if (request.headers.authorization !== 'Bearer signed-in-token') {
      response.writeHead(401).end('unauthorized');
      return;
    }
    const rest = url.replace(/^\/local-tools\/demo-tools@1\.0\.0/, '');
    const body =
      rest === '' ? manifest : rest.startsWith('/') ? files[rest.slice(1)] : '';
    if (body === undefined || rest === url) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => hub.close(() => resolve())));
  const address = hub.address();
  const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`;
  // The entry the Hub extension writes
  const settings = settingsWith({
    name: 'Hub',
    url: endpoint,
    transport: 'http',
    enabled: true,
  });
  const install = (): Tool =>
    buildTools(new Sandbox(root), {
      localSkills: {
        home: root,
        settings: () => settings,
        secrets: () => ({}),
        variables: () => ({}),
        root: join(root, 'skills'),
      },
    }).find((item) => item.name === 'skill_install')!;
  const args = {
    server: 'Hub',
    pack: 'demo-tools@1.0.0',
    digest: sha(manifest),
  };
  const context = { signal: new AbortController().signal } as never;
  // Not signed in yet: it says where to sign in, and asks the Hub nothing
  await assert.rejects(
    install().run(args, context),
    /还没有登录[\s\S]*设置 → 扩展[\s\S]*\/mcp/,
  );
  assert.deepEqual(sent, []);
  // Signed in: the token its sign-in keeps goes to the Hub's local tools
  writePrivateJson(join(root, 'mcp-auth.json'), {
    servers: {
      [endpoint]: {
        tokens: { access_token: 'signed-in-token', token_type: 'Bearer' },
      },
    },
  });
  const result = JSON.parse(String(await install().run(args, context)));
  assert.equal(result.installed, true);
  assert.equal(result.directory, join(root, 'skills', 'demo-tools'));
  assert.equal(
    await readFile(
      join(root, 'skills', 'demo-tools', 'tools', 'fetch.ts'),
      'utf8',
    ),
    tool,
  );
  assert.ok(sent.length >= 3);
  assert.ok(sent.every((value) => value === 'Bearer signed-in-token'));
});

async function writeSyntheticPack(
  skillsRoot: string,
  packName: string,
): Promise<void> {
  const files: Record<string, string> = {
    'SKILL.md': `# ${packName}\n`,
    'functions/usage.ts':
      "export function usageText(): string {\n  return 'Usage: check-record.ts --file <path>';\n}\n",
    'tools/check-record.ts': `import { writeFileSync } from 'node:fs';
import { usageText } from '../functions/usage.ts';
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(usageText());
  process.exit(2);
}
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const stdin = Buffer.concat(chunks).toString('utf8');
writeFileSync('check-record-receipt.json', JSON.stringify({
  execPath: process.execPath,
  args,
  stdin,
  cwd: process.cwd(),
}));
console.log('checked:' + stdin.trim());
`,
  };
  const packDir = join(skillsRoot, packName);
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(packDir, ...rel.split('/'));
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, content, 'utf8');
  }
  await writeFile(
    join(packDir, 'pack.json'),
    JSON.stringify({
      schema: 'pack@1',
      id: packName,
      version: '1.2.7',
      files: Object.entries(files)
        .map(([path, content]) => ({
          path,
          sha256: sha(content),
          size: Buffer.byteLength(content),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
    }),
    'utf8',
  );
}

test('skill_run via AgentRuntime uses nodeExecutable in paths with spaces and preserves non-zero exit and stdin secrets', async (t) => {
  const root = await realpath(scratch(t, 'circle-skill-run-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const skillsRoot = join(root, 'skills');
  const stagedDir = join(root, 'Program Files Circle', 'tools', 'node', 'bin');
  const stagedNode = join(
    stagedDir,
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(skillsRoot, { recursive: true }),
    mkdir(stagedDir, { recursive: true }),
  ]);
  await copyFile(process.execPath, stagedNode);
  if (process.platform !== 'win32') await chmod(stagedNode, 0o755);
  await writeSyntheticPack(skillsRoot, 'recompose');
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  saveSecret(home, 'HUB_TOKEN', 'secret-hub-token-987');

  const model = new ScriptedModel([
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-usage',
            name: 'skill_run',
            args: { pack: 'recompose', script: 'tools/check-record.ts' },
          },
        ],
      },
    },
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-run',
            name: 'skill_run',
            args: {
              pack: 'recompose',
              script: 'tools/check-record.ts',
              args: ['--file', 'record.json'],
              stdin: '%HUB_TOKEN%\n',
            },
          },
        ],
      },
    },
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: 'done',
      },
    },
  ]);

  const runtime = new AgentRuntime({
    workspace,
    home,
    userHome: home,
    localSkillsRoot: skillsRoot,
    nodeExecutable: stagedNode,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('check recompose pack');

  const usageResult = model.requests[1]?.messages.find(
    (m) => m.tool_call_id === 'call-usage',
  );
  assert.equal(usageResult?.status, 'success');
  assert.match(String(usageResult?.content), /Usage: check-record\.ts/);
  assert.match(String(usageResult?.content), /Exit code: 2/);

  const runResult = model.requests[2]?.messages.find(
    (m) => m.tool_call_id === 'call-run',
  );
  const content = String(runResult?.content ?? '');
  assert.match(content, /checked:%HUB_TOKEN%/);
  assert.match(content, /Exit code: 0/);
  assert.equal(content.includes('secret-hub-token-987'), false);

  const receipt = JSON.parse(
    await readFile(join(workspace, 'check-record-receipt.json'), 'utf8'),
  ) as { execPath: string; args: string[]; stdin: string; cwd: string };
  assert.equal(await realpath(receipt.execPath), await realpath(stagedNode));
  assert.notEqual(
    await realpath(receipt.execPath),
    await realpath(process.execPath),
  );
  assert.deepEqual(receipt.args, ['--file', 'record.json']);
  assert.equal(receipt.stdin, 'secret-hub-token-987\n');
  assert.equal(await realpath(receipt.cwd), workspace);
});

test('skill_run errors explicitly and cleans up spec.json if nodeExecutable exits 0 with \\r\\n without running the script', async (t) => {
  const root = await realpath(scratch(t, 'circle-skill-silent-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const skillsRoot = join(root, 'skills');
  const isolatedTmp = join(root, 'tmp');
  const fakeDir = join(root, 'FakeCircleApp');
  const fakeExe = join(
    fakeDir,
    process.platform === 'win32' ? 'Circle.cmd' : 'Circle.sh',
  );
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(skillsRoot, { recursive: true }),
    mkdir(isolatedTmp, { recursive: true }),
    mkdir(fakeDir, { recursive: true }),
  ]);
  if (process.platform === 'win32') {
    await writeFile(fakeExe, '@echo off\r\necho.\r\nexit /b 0\r\n', 'utf8');
  } else {
    await writeFile(fakeExe, "#!/bin/sh\nprintf '\\r\\n'\nexit 0\n", {
      mode: 0o755,
    });
  }
  await writeSyntheticPack(skillsRoot, 'recompose');
  saveSettings(trustFolder(defaultSettings(), workspace), home);

  const prevEnv = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.TEMP = isolatedTmp;
  process.env.TMP = isolatedTmp;
  process.env.TMPDIR = isolatedTmp;
  cleanup(t, () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const model = new ScriptedModel([
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-silent',
            name: 'skill_run',
            args: {
              pack: 'recompose',
              script: 'tools/check-record.ts',
              stdin: 'secret-body\n',
            },
          },
        ],
      },
    },
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: 'reported failure',
      },
    },
  ]);

  const runtime = new AgentRuntime({
    workspace,
    home,
    userHome: home,
    localSkillsRoot: skillsRoot,
    nodeExecutable: fakeExe,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('attempt skill_run with fake Circle binary');

  const toolResult = model.requests[1]?.messages.find(
    (m) => m.tool_call_id === 'call-silent',
  );
  assert.equal(toolResult?.status, 'error');
  const message = String(toolResult?.content ?? '');
  assert.equal(message.includes(fakeExe), true, message);
  assert.equal(message.includes('Exit code: 0'), false, message);
  assert.equal(existsSync(join(workspace, 'check-record-receipt.json')), false);
  const leftover = (await readdir(isolatedTmp)).filter((name) =>
    name.startsWith('circle-script-'),
  );
  assert.deepEqual(leftover, []);
});
