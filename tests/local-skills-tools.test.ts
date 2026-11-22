import { test } from 'node:test';
import { entryOf } from './helpers.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools } from '../src/tools.js';
import { Sandbox } from '../src/sandbox.js';
import { writePrivateJson, type CircleSettings } from '../src/settings.js';
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

test('skill_install gives the model what the server said when it refuses a download, and what to do about it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-local-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const said =
    '无权限：当前账户未获授权使用工作流「demo-tools」。请联系管理员为该账户或所在团队分配此工作流。';
  const hub = createServer((request, response) => {
    // No discovery document, as the Hub answers: its local tools are beside its MCP endpoint
    if (request.url === '/.well-known/knowledge-sync') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(said);
  });
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => hub.close(() => resolve())));
  const address = hub.address();
  const settings = settingsWith({
    name: 'Hub',
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`,
    headers: { authorization: 'Bearer literal-token' },
  });
  const install = buildTools(new Sandbox(root), {
    localSkills: {
      home: root,
      settings: () => settings,
      secrets: () => ({}),
      variables: () => ({}),
      root: join(root, 'skills'),
    },
  }).find((item) => item.name === 'skill_install')!;
  await assert.rejects(
    install.run({ server: 'Hub', pack: 'demo-tools@1.0.0' }, {
      signal: new AbortController().signal,
    } as never),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        `服务器说（HTTP 403）：“${said}”；照服务器说的做，然后再试`,
  );
});
