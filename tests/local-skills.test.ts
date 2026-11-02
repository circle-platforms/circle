import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalSkillsError,
  installPack,
  listInstalled,
  parsePackRef,
  resolveServer,
  runTool,
  serverBaseUrl,
  verifyInstalled,
} from '../src/local_skills.js';
import type { CircleSettings } from '../src/settings.js';

const TOKEN = 'synthetic-token-value';
const sha = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

const ECHO_TOOL = `const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
console.log(JSON.stringify({ args: process.argv.slice(2), stdin: Buffer.concat(chunks).toString(), url: process.env.API_URL, token: process.env.API_TOKEN }))
`;

function settingsWith(server: Record<string, unknown>): CircleSettings {
  return {
    version: 1,
    initialized: true,
    auth: {},
    trusted_folders: [],
    theme: 'auto',
    mcp_servers: [server],
    variables: {},
  } as unknown as CircleSettings;
}

function manifestFor(
  id: string,
  version: string,
  files: Record<string, string>,
): { manifest: Buffer; digest: string } {
  const entries = Object.entries(files)
    .map(([path, content]) => ({
      path,
      sha256: sha(content),
      size: Buffer.byteLength(content),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 'pack@1',
      id,
      version,
      kind: 'workflow',
      title: '合成',
      description: '合成',
      files: entries,
    }),
  );
  return { manifest, digest: sha(manifest) };
}

interface StubServer {
  url: string;
  close(): Promise<void>;
}

async function stubServer(
  packs: Map<string, { manifest: Buffer; files: Record<string, string> }>,
): Promise<StubServer> {
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const url = request.url ?? '';
      const reply = (status: number, bytes: Uint8Array | string): void => {
        response.writeHead(status, {
          'content-type': 'application/octet-stream',
          'content-length': Buffer.byteLength(bytes),
        });
        response.end(bytes);
      };
      if (request.headers.authorization !== `Bearer ${TOKEN}`)
        return reply(401, 'unauthorized');
      const rest = url.startsWith('/local-tools/')
        ? url.slice('/local-tools/'.length)
        : null;
      if (rest === null) return reply(404, 'not found');
      const pack = packs.get(rest);
      if (pack !== undefined) return reply(200, pack.manifest);
      for (const [ref, value] of packs) {
        if (!rest.startsWith(`${ref}/`)) continue;
        const file = value.files[rest.slice(ref.length + 1)];
        if (file !== undefined) return reply(200, file);
      }
      return reply(404, 'not found');
    },
  );
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function pack(
  id = 'demo-tools',
  version = '1.0.0',
  files: Record<string, string> = {
    'SKILL.md': '# 合成\n',
    'tools/echo.ts': ECHO_TOOL,
  },
): {
  ref: string;
  manifest: Buffer;
  digest: string;
  files: Record<string, string>;
} {
  const { manifest, digest } = manifestFor(id, version, files);
  return { ref: `${id}@${version}`, manifest, digest, files };
}

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'circle-local-skills-'));
}

test('resolveServer reads the named MCP server entry, its saved secret or a literal bearer', () => {
  const settings = settingsWith({
    name: 'example',
    url: 'http://127.0.0.1:9000/mcp',
    headers: { Authorization: 'Bearer ${secret:EXAMPLE_TOKEN}' },
  });
  assert.deepEqual(
    resolveServer(settings, { EXAMPLE_TOKEN: 'saved' }, 'example'),
    { url: 'http://127.0.0.1:9000/mcp', token: 'saved' },
  );
  const literal = settingsWith({
    name: 'example',
    url: 'http://127.0.0.1:9001/mcp',
    headers: { authorization: 'Bearer literal-token' },
  });
  assert.deepEqual(resolveServer(literal, {}, 'example'), {
    url: 'http://127.0.0.1:9001/mcp',
    token: 'literal-token',
  });
  const unknown = resolveServer(settings, { EXAMPLE_TOKEN: 'saved' }, 'other');
  assert.ok('problem' in unknown && unknown.problem.includes('other'));
  const missing = resolveServer(
    settingsWith({ name: 'example', url: 'http://127.0.0.1:9000/mcp' }),
    {},
    'example',
  );
  assert.ok('problem' in missing && missing.problem.includes('令牌'));
});

test('serverBaseUrl and parsePackRef keep the shared contract', () => {
  assert.equal(
    serverBaseUrl('http://127.0.0.1:8080/mcp'),
    'http://127.0.0.1:8080',
  );
  assert.equal(
    serverBaseUrl('http://127.0.0.1:8080/mcp/'),
    'http://127.0.0.1:8080',
  );
  assert.deepEqual(parsePackRef('case-compile@3.9.14'), {
    id: 'case-compile',
    version: '3.9.14',
  });
  assert.equal(parsePackRef('case-compile'), null);
  assert.equal(parsePackRef('Case@1.0.0'), null);
});

test('installs, verifies and lists a pack under the skills root', async () => {
  const root = await tempRoot();
  const value = pack();
  const server = await stubServer(
    new Map([[value.ref, { manifest: value.manifest, files: value.files }]]),
  );
  try {
    const result = await installPack({
      url: server.url,
      token: TOKEN,
      ref: value.ref,
      digest: value.digest,
      root,
    });
    assert.equal(result.installed, true);
    assert.equal(result.directory, join(root, 'demo-tools'));
    assert.equal(
      await readFile(join(result.directory, 'pack.json'), 'utf8'),
      value.manifest.toString('utf8'),
    );
    assert.equal(
      await readFile(join(result.directory, 'tools', 'echo.ts'), 'utf8'),
      ECHO_TOOL,
    );
    assert.deepEqual(await verifyInstalled(result.directory, value.digest), {
      pack: 'demo-tools',
      version: '1.0.0',
      digest: value.digest,
      files: 2,
    });
    assert.deepEqual(await listInstalled(root), [
      {
        pack: 'demo-tools',
        version: '1.0.0',
        digest: value.digest,
        directory: join(root, 'demo-tools'),
      },
    ]);
    assert.equal(
      (
        await installPack({
          url: server.url,
          token: TOKEN,
          ref: value.ref,
          digest: value.digest,
          root,
        })
      ).installed,
      false,
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a wrong digest, a tampered file and a traversal path, leaving nothing installed', async () => {
  const root = await tempRoot();
  const value = pack();
  const server = await stubServer(
    new Map([[value.ref, { manifest: value.manifest, files: value.files }]]),
  );
  try {
    await assert.rejects(
      installPack({
        url: server.url,
        token: TOKEN,
        ref: value.ref,
        digest: 'f'.repeat(64),
        root,
      }),
      (error: unknown) =>
        error instanceof LocalSkillsError && error.message.includes('不符'),
    );
    const tampered = await stubServer(
      new Map([
        [
          value.ref,
          {
            manifest: value.manifest,
            files: { ...value.files, 'tools/echo.ts': 'x' },
          },
        ],
      ]),
    );
    await assert.rejects(
      installPack({ url: tampered.url, token: TOKEN, ref: value.ref, root }),
      (error: unknown) =>
        error instanceof LocalSkillsError && error.message.includes('不符'),
    );
    await tampered.close();
    const evil = Buffer.from(
      JSON.stringify({
        schema: 'pack@1',
        id: 'evil',
        version: '1.0.0',
        kind: 'workflow',
        title: 'x',
        description: 'x',
        files: [{ path: '../outside.ts', sha256: sha('x'), size: 1 }],
      }),
    );
    const evilServer = await stubServer(
      new Map([['evil@1.0.0', { manifest: evil, files: {} }]]),
    );
    await assert.rejects(
      installPack({
        url: evilServer.url,
        token: TOKEN,
        ref: 'evil@1.0.0',
        root,
      }),
      (error: unknown) =>
        error instanceof LocalSkillsError && error.message.includes('不安全'),
    );
    await evilServer.close();
    assert.equal(await stat(join(root, 'demo-tools')).catch(() => null), null);
    assert.equal(await stat(join(root, 'evil')).catch(() => null), null);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a different installed version needs replace, and replace backs the old tree up outside the skills root', async () => {
  const root = await tempRoot();
  const first = pack('demo-tools', '1.0.0');
  const second = pack('demo-tools', '2.0.0', {
    'SKILL.md': '# 合成 v2\n',
    'tools/echo.ts': ECHO_TOOL,
  });
  const server = await stubServer(
    new Map([
      [first.ref, { manifest: first.manifest, files: first.files }],
      [second.ref, { manifest: second.manifest, files: second.files }],
    ]),
  );
  try {
    await installPack({ url: server.url, token: TOKEN, ref: first.ref, root });
    await assert.rejects(
      installPack({ url: server.url, token: TOKEN, ref: second.ref, root }),
      (error: unknown) =>
        error instanceof LocalSkillsError && error.message.includes('已经装有'),
    );
    assert.equal(
      (
        await installPack({
          url: server.url,
          token: TOKEN,
          ref: second.ref,
          root,
          replace: true,
        })
      ).installed,
      true,
    );
    assert.equal(
      (await verifyInstalled(join(root, 'demo-tools'), second.digest)).version,
      '2.0.0',
    );
    assert.equal(
      (
        await verifyInstalled(
          join(root, '..', '.local-skills-backup', 'demo-tools@1.0.0'),
          first.digest,
        )
      ).version,
      '1.0.0',
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(join(root, '..', '.local-skills-backup'), {
      recursive: true,
      force: true,
    });
  }
});

test('runTool expands placeholders, runs under the pack and redacts secrets', async () => {
  const root = await tempRoot();
  const value = pack();
  const server = await stubServer(
    new Map([[value.ref, { manifest: value.manifest, files: value.files }]]),
  );
  try {
    await installPack({ url: server.url, token: TOKEN, ref: value.ref, root });
    const result = await runTool({
      root,
      pack: 'demo-tools',
      script: 'tools/echo.ts',
      args: ['--url', '%API_URL%', 'literal'],
      stdin: '%API_TOKEN%\n',
      variables: { API_URL: 'http://127.0.0.1:1' },
      secrets: { API_TOKEN: TOKEN },
    });
    assert.equal(result.exit_code, 0);
    const printed = JSON.parse(result.stdout) as {
      args: string[];
      stdin: string;
      url: string;
      token?: string;
    };
    assert.deepEqual(printed.args, ['--url', 'http://127.0.0.1:1', 'literal']);
    assert.equal(printed.stdin, '%API_TOKEN%\n');
    assert.equal(printed.url, 'http://127.0.0.1:1');
    assert.equal(
      printed.token,
      undefined,
      'a saved secret never enters the script environment',
    );
    assert.ok(!result.stdout.includes(TOKEN));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('runTool refuses scripts outside tools/ and reports a timeout', async () => {
  const root = await tempRoot();
  const files = {
    'SKILL.md': '# 合成\n',
    'tools/echo.ts': ECHO_TOOL,
    'tools/sleep.ts': 'await new Promise((r) => setTimeout(r, 30000))\n',
  };
  const value = pack('demo-tools', '1.0.0', files);
  const server = await stubServer(
    new Map([[value.ref, { manifest: value.manifest, files: value.files }]]),
  );
  try {
    await installPack({ url: server.url, token: TOKEN, ref: value.ref, root });
    await assert.rejects(
      runTool({ root, pack: 'demo-tools', script: 'functions/x.ts' }),
      /tools\//,
    );
    const slow = await runTool({
      root,
      pack: 'demo-tools',
      script: 'tools/sleep.ts',
      timeoutMs: 200,
    });
    assert.equal(slow.exit_code, null);
    assert.equal(slow.truncated, true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
