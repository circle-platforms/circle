import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceDocuments } from '../src/workspace/documents.ts';
import { AgentRuntime } from '../../../src/runtime.ts';
import { defaultSettings } from '../../../src/settings.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import type { Message, ToolCall } from '../../../src/types.ts';
import type { FileMutations } from '../../../src/file_mutations.ts';
import {
  browserTools,
  runtimeBrowserOptions,
  type BrowserPort,
} from '../../../src/browser/tools.ts';

const assistant = (calls: ToolCall[] = []): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content: calls.length ? '' : 'done',
  tool_calls: calls,
});
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: randomUUID(),
  name,
  args,
});

async function fixture(t: TestContext) {
  const scratch = await mkdtemp(join(tmpdir(), 'circle-agent-document-cas-'));
  const workspace = join(scratch, 'workspace');
  const home = join(scratch, 'home');
  await mkdir(workspace);
  await mkdir(home);
  const documents = new WorkspaceDocuments(workspace);
  const writes: string[][] = [];
  const runtimes: AgentRuntime[] = [];
  const backend: FileMutations = {
    async read(path, signal) {
      const document = await documents.snapshot(
        relative(documents.root, path).split('\\').join('/'),
        { signal },
      );
      return {
        path,
        content: document?.content ?? null,
        revision: document?.revision ?? null,
      };
    },
    async apply(changes, signal) {
      writes.push(changes.map((change) => change.path));
      const result = await documents.applyChanges(
        changes.map((change) => ({
          ...change,
          path: relative(documents.root, change.path).split('\\').join('/'),
        })),
        { signal },
      );
      if (result.status !== 'applied') {
        const error = new Error(
          `file mutation failed: ${result.failures.map((failure) => failure.message).join('; ')}; committed paths: ${result.committedPaths.join(', ') || 'none'}`,
        );
        throw error;
      }
    },
  };
  t.after(async () => {
    for (const runtime of runtimes.reverse()) await runtime.close();
    documents.close();
    await rm(scratch, { recursive: true, force: true });
  });
  return {
    home,
    workspace,
    documents,
    backend,
    writes,
    register: (runtime: AgentRuntime) => {
      runtimes.push(runtime);
    },
  };
}

const scenarios = [
  {
    name: 'write after read',
    read: true,
    tool: () => call('write_file', { file_path: 'a.txt', content: 'agent\n' }),
    humanPath: 'a.txt',
  },
  {
    name: 'unread write snapshot',
    read: false,
    tool: () => call('write_file', { file_path: 'a.txt', content: 'agent\n' }),
    humanPath: 'a.txt',
  },
  {
    name: 'edit after read',
    read: true,
    tool: () =>
      call('edit_file', {
        file_path: 'a.txt',
        old_string: 'original',
        new_string: 'agent',
      }),
    humanPath: 'a.txt',
  },
  {
    name: 'patch update',
    read: true,
    tool: () =>
      call('apply_patch', {
        patchText:
          '*** Begin Patch\n*** Update File: a.txt\n@@\n-original\n+agent\n*** End Patch',
      }),
    humanPath: 'a.txt',
  },
  {
    name: 'patch delete',
    read: false,
    tool: () =>
      call('apply_patch', {
        patchText: '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch',
      }),
    humanPath: 'a.txt',
  },
  {
    name: 'patch move source',
    read: false,
    tool: () =>
      call('apply_patch', {
        patchText:
          '*** Begin Patch\n*** Update File: a.txt\n*** Move to: moved.txt\n@@\n-original\n+agent\n*** End Patch',
      }),
    humanPath: 'a.txt',
  },
  {
    name: 'patch move destination',
    read: false,
    tool: () =>
      call('apply_patch', {
        patchText:
          '*** Begin Patch\n*** Update File: a.txt\n*** Move to: moved.txt\n@@\n-original\n+agent\n*** End Patch',
      }),
    humanPath: 'moved.txt',
  },
  {
    name: 'patch add collision',
    read: false,
    tool: () =>
      call('apply_patch', {
        patchText:
          '*** Begin Patch\n*** Add File: new.txt\n+agent\n*** End Patch',
      }),
    humanPath: 'new.txt',
  },
];

for (const scenario of scenarios) {
  test(`approval pending: ${scenario.name} preserves a human save and reports the conflict to the next model request`, async (t) => {
    const { home, workspace, documents, backend, writes, register } =
      await fixture(t);
    await writeFile(join(workspace, 'a.txt'), 'original\n');
    const replies = scenario.read
      ? [
          { message: assistant([call('read_file', { file_path: 'a.txt' })]) },
          { message: assistant([scenario.tool()]) },
          { message: assistant() },
        ]
      : [{ message: assistant([scenario.tool()]) }, { message: assistant() }];
    const model = new ScriptedModel(replies);
    let entered!: () => void;
    let approve!: () => void;
    const waiting = new Promise<void>((done) => {
      entered = done;
    });
    const approval = new Promise<void>((done) => {
      approve = done;
    });
    const runtime: AgentRuntime = new AgentRuntime({
      home,
      workspace,
      settings: defaultSettings(),
      model,
      headless: true,
      fileMutations: backend,
      approve: async (_call, signal) => {
        entered();
        await Promise.race([
          approval,
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            }),
          ),
        ]);
        return 'approve';
      },
    });
    register(runtime);
    const running = runtime.harness.run('apply the requested change');
    await Promise.race([
      waiting,
      running.then(() => {
        throw Error('turn ended before the expected approval');
      }),
    ]);
    assert.equal(
      writes.length,
      0,
      'preparation before approval must not mutate disk',
    );
    const before = await documents.snapshot(scenario.humanPath);
    await documents.save(
      scenario.humanPath,
      'human saved while approval waited\n',
      before?.revision ?? null,
    );
    approve();
    await running;
    assert.equal(
      await readFile(join(workspace, scenario.humanPath), 'utf8'),
      'human saved while approval waited\n',
    );
    if (scenario.humanPath !== 'a.txt')
      assert.equal(
        await readFile(join(workspace, 'a.txt'), 'utf8'),
        'original\n',
      );
    if (scenario.name === 'patch move source')
      assert.equal(existsSync(join(workspace, 'moved.txt')), false);
    assert.equal(writes.length, 1);
    const result = runtime.harness.messages.findLast(
      (message) => message.role === 'tool',
    );
    assert.equal(result?.status, 'error');
    assert.match(result?.content ?? '', /file changed on disk/);
    assert.match(
      model.requests
        .at(-1)!
        .messages.findLast((message) => message.role === 'tool')!.content,
      /file changed on disk/,
    );
    runtime.store.requireBalancedTools(runtime.harness.messages);
  });
}

test('successful native patch coordinates nested create, move and delete with real disk effects', async (t) => {
  const { home, workspace, backend, register } = await fixture(t);
  await writeFile(join(workspace, 'a.txt'), 'original\n');
  await writeFile(join(workspace, 'delete.txt'), 'delete me\n');
  const model = new ScriptedModel([
    {
      message: assistant([
        call('apply_patch', {
          patchText:
            '*** Begin Patch\n*** Update File: a.txt\n*** Move to: nested/moved.txt\n@@\n-original\n+agent\n*** Delete File: delete.txt\n*** Add File: new/folder/added.txt\n+created\n*** End Patch',
        }),
      ]),
    },
    { message: assistant() },
  ]);
  const runtime: AgentRuntime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model,
    headless: true,
    fileMutations: backend,
    approve: async () => 'approve',
  });
  register(runtime);
  await runtime.harness.run('move delete and create');
  assert.equal(
    await readFile(join(workspace, 'nested/moved.txt'), 'utf8'),
    'agent\n',
  );
  assert.equal(
    await readFile(join(workspace, 'new/folder/added.txt'), 'utf8'),
    'created\n',
  );
  assert.equal(existsSync(join(workspace, 'a.txt')), false);
  assert.equal(existsSync(join(workspace, 'delete.txt')), false);
  assert.equal(
    runtime.harness.messages.findLast((message) => message.role === 'tool')
      ?.status,
    'success',
  );
});

test('cancelling an approval abandons its prepared native write and preserves disk', async (t) => {
  const { home, workspace, backend, writes, register } = await fixture(t);
  await writeFile(join(workspace, 'a.txt'), 'original\n');
  const model = new ScriptedModel([
    {
      message: assistant([
        call('write_file', { file_path: 'a.txt', content: 'never written' }),
      ]),
    },
  ]);
  let entered!: () => void;
  const waiting = new Promise<void>((done) => {
    entered = done;
  });
  const runtime: AgentRuntime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model,
    headless: true,
    fileMutations: backend,
    approve: async (_call, signal) => {
      entered();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  register(runtime);
  const running = runtime.harness.run('write');
  const stopped = assert.rejects(running, /Interrupted/);
  await Promise.race([
    waiting,
    running.then(() => {
      throw Error('turn ended before the expected approval');
    }),
  ]);
  await runtime.harness.cancel();
  await stopped;
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'original\n');
  assert.equal(writes.length, 0);
  runtime.store.requireBalancedTools(runtime.harness.messages);
});

test('browser_record shares the core writer CAS while its approval waits', async (t) => {
  const { home, workspace, documents, backend, register } = await fixture(t);
  const path = 'recording.circle-browser.json';
  await writeFile(join(workspace, path), 'old recording\n');
  let entered!: () => void;
  let approve!: () => void;
  const waiting = new Promise<void>((done) => {
    entered = done;
  });
  const approval = new Promise<void>((done) => {
    approve = done;
  });
  const port: BrowserPort = {
    async request() {
      return { text: 'page loaded' };
    },
  };
  const model = new ScriptedModel([
    {
      message: assistant([
        call('browser_navigate', { url: 'http://127.0.0.1/example' }),
      ]),
    },
    { message: assistant([call('browser_record', { path })]) },
    { message: assistant() },
  ]);
  const runtime: AgentRuntime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model,
    headless: true,
    fileMutations: backend,
    extraTools: browserTools(
      port,
      runtimeBrowserOptions(() => runtime),
    ),
    approve: async (tool) => {
      if (tool.name === 'browser_record') {
        entered();
        await approval;
      }
      return 'approve';
    },
  });
  register(runtime);
  const running = runtime.harness.run('record the page');
  await Promise.race([
    waiting,
    running.then(() => {
      throw Error('recording ended before approval');
    }),
  ]);
  const current = await documents.read(path);
  await documents.save(path, 'human edited the recording\n', current.revision);
  approve();
  await running;
  assert.equal(
    await readFile(join(workspace, path), 'utf8'),
    'human edited the recording\n',
  );
  assert.match(
    model.requests
      .at(-1)!
      .messages.findLast((message) => message.role === 'tool')!.content,
    /file changed on disk/,
  );
});

test('browser_record reuses an earlier read_file version instead of silently replacing it', async (t) => {
  const { home, workspace, documents, backend, writes, register } =
    await fixture(t);
  const path = 'recording.circle-browser.json';
  await writeFile(join(workspace, path), 'model read this version\n');
  const port: BrowserPort = {
    async request() {
      const current = await documents.read(path);
      await documents.save(
        path,
        'human changed before the recording proposal\n',
        current.revision,
      );
      return { text: 'page loaded' };
    },
  };
  const model = new ScriptedModel([
    { message: assistant([call('read_file', { file_path: path })]) },
    {
      message: assistant([
        call('browser_navigate', { url: 'http://127.0.0.1/example' }),
      ]),
    },
    { message: assistant([call('browser_record', { path })]) },
    { message: assistant() },
  ]);
  const runtime: AgentRuntime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model,
    headless: true,
    fileMutations: backend,
    extraTools: browserTools(
      port,
      runtimeBrowserOptions(() => runtime),
    ),
    approve: async () => 'approve',
  });
  register(runtime);
  await runtime.harness.run('read and record');
  assert.equal(
    await readFile(join(workspace, path), 'utf8'),
    'human changed before the recording proposal\n',
  );
  assert.equal(writes.length, 0);
  assert.match(
    model.requests
      .at(-1)!
      .messages.findLast((message) => message.role === 'tool')!.content,
    /file changed since read_file/,
  );
});
