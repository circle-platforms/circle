import test from 'node:test';
import assert from 'node:assert/strict';
import { structuredTextOutput } from '../src/model/tool-output';
import type { GitHubConnectionBackend } from '../../../src/github_connection';
test('structured log text is readable while both originals remain exact', () => {
  const text = Array.from(
    { length: 600 },
    (_, i) => `job\tstep\tline ${i} 中文\x1b[31m red\x1b[0m`,
  ).join('\n');
  const output = JSON.stringify({
    text,
    head: 'trusted only at backend',
    runId: 4,
  });
  const result = structuredTextOutput(output)!;
  assert.equal(result.text, text);
  assert.equal(result.preview.split('\n').length, 600);
  assert(result.preview.includes('job\tstep\tline 599 中文 red'));
  assert(!result.preview.includes('\x1b'));
  assert.equal(JSON.parse(output).text, text);
});
test('only a root string text field gets an inert text preview', () => {
  for (const value of [
    'not JSON',
    '"quoted"',
    'null',
    '["a"]',
    '{"text":3}',
    '{"nested":{"text":"hello"}}',
    '{"text":""}',
    '{"text":',
  ])
    assert.equal(structuredTextOutput(value), undefined, value);
  const text =
    '<img src=x onerror=alert(1)>\x1b]8;;https://example.test\x07untrusted link\x1b]8;;\x07\x00';
  assert.equal(
    structuredTextOutput(JSON.stringify({ text }))?.preview,
    '<img src=x onerror=alert(1)>untrusted link',
  );
});

test('real bundled extension serialization retains its log envelope for the model and raw view', async () => {
  const { ExtensionHost } = await import('../../../src/extensions.ts');
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'circle-log-envelope-'));
  const home = join(root, 'home'),
    workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  const state = {
    provider: 'github',
    client: 'GitHub CLI',
    epoch: 1,
    state: 'connected',
    account: { login: 'fixture', id: 1 },
    repositories: ['fixture/repo'],
    storage: 'session',
    remoteRevocation: 'not-requested',
  };
  const text = 'test\tRun npm test\tfirst\nsecond\x1b[31m error\x1b[0m';
  const response = { text, head: 'h', runId: 2 };
  const host = new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: fileURLToPath(
      new URL('../../../src/extensions', import.meta.url),
    ),
    settings: { github: { enabled: true } },
    githubConnection: {
      call: async (method: string) => (method === 'status' ? state : response),
      subscribe: () => () => {},
    } as GitHubConnectionBackend,
  });
  try {
    await host.load();
    const tool = host.tools().find((t) => t.name === 'github_logs');
    assert(tool);
    const actual = await tool.run(
      { epoch: 1, repository: 'fixture/repo', head: 'h', runId: 2 },
      { signal: new AbortController().signal, sessionId: 'fixture' },
    );
    assert.equal(actual, JSON.stringify(response));
    assert.deepEqual(JSON.parse(actual), response);
    assert.equal(structuredTextOutput(actual)?.text, text);
    assert.equal(
      structuredTextOutput(actual)?.preview,
      'test\tRun npm test\tfirst\nsecond error',
    );
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
