import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import type {
  FileMutations,
  FileMutationChange,
} from '../src/file_mutations.js';
import { AgentRuntime } from '../src/runtime.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { buildTools } from '../src/tools.js';
import type { ToolContext } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

function fixture(t: TestContext) {
  // Grants are keyed by the native canonical name the tools use. On a Windows
  // runner TEMP is an 8.3 short name that only the native realpath expands.
  const workspace = realpathSync.native(scratch(t));
  const external = realpathSync.native(scratch(t));
  const file = join(external, 'granted.txt');
  const sibling = join(external, 'sibling.txt');
  const local = join(workspace, 'local.txt');
  for (const path of [file, sibling, local]) writeFileSync(path, 'original\n');
  let owner = 'owner';
  const grants = new Map<string, 'read' | 'write'>();
  const inside = (path: string) => {
    const rel = relative(workspace, path);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
  };
  const key = (sessionId: string, path: string) =>
    JSON.stringify([sessionId, path]);
  const authorized = (
    path: string,
    sessionId: string,
    access: 'read' | 'write',
  ) => {
    if (inside(path)) return;
    const grant = grants.get(key(sessionId, path));
    if (
      sessionId !== owner ||
      !grant ||
      (access === 'write' && grant !== 'write')
    )
      throw Error(`external file grant is missing or revoked: ${path}`);
  };
  const snapshot = (path: string) => {
    const content = existsSync(path) ? readFileSync(path, 'utf8') : null;
    return {
      path,
      content,
      revision:
        content === null
          ? null
          : createHash('sha256').update(content).digest('hex'),
    };
  };
  let beforeApply: (() => void) | undefined;
  let writes = 0;
  const backend: FileMutations = {
    authorize: authorized,
    async read(path) {
      authorized(path, owner, 'read');
      return snapshot(path);
    },
    async apply(changes: FileMutationChange[]) {
      beforeApply?.();
      // A real native backend performs this same check at its transaction boundary.
      for (const change of changes) {
        authorized(change.path, owner, 'write');
        if (snapshot(change.path).revision !== change.expectedRevision)
          throw Error('file changed after preparation');
      }
      for (const change of changes) {
        if (change.content === null)
          throw Error('deletion unsupported by test backend');
        writeFileSync(change.path, change.content);
        writes++;
      }
    },
  };
  const tools = buildTools(new Sandbox(workspace), { fileMutations: backend });
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  const context = (sessionId = owner): ToolContext => ({
    sessionId,
    signal: new AbortController().signal,
  });
  return {
    workspace,
    file,
    sibling,
    local,
    external,
    backend,
    tool,
    context,
    grant: (
      sessionId = owner,
      access: 'read' | 'write' = 'write',
      path = file,
    ) => grants.set(key(sessionId, path), access),
    revoke: () => grants.clear(),
    setOwner: (id: string) => {
      owner = id;
    },
    beforeApply: (fn: () => void) => {
      beforeApply = fn;
    },
    writes: () => writes,
  };
}

test('external reads require backend authority and share the version used by edit', async (t) => {
  const f = fixture(t),
    args = { file_path: f.file, old_string: 'original', new_string: 'updated' };
  await assert.rejects(
    f.tool('read_file').run({ file_path: f.file }, f.context()),
    /grant/,
  );
  f.grant();
  await f.tool('read_file').run({ file_path: f.file }, f.context());
  await f.tool('edit_file').run(args, f.context());
  assert.equal(readFileSync(f.file, 'utf8'), 'updated\n');
  assert.equal(readFileSync(f.sibling, 'utf8'), 'original\n');
  assert.equal(f.writes(), 1);
  // A different session does not inherit either the grant or the read version.
  await assert.rejects(
    f.tool('edit_file').run(args, f.context('child')),
    /grant/,
  );
});

test('tool approval, a read-only grant, and a sibling path do not grant write authority', async (t) => {
  const f = fixture(t);
  f.grant('owner', 'read');
  await f.tool('read_file').run({ file_path: f.file }, f.context());
  await assert.rejects(
    f
      .tool('write_file')
      .run({ file_path: f.file, content: 'forbidden' }, f.context()),
    /grant/,
  );
  f.grant();
  await assert.rejects(
    f
      .tool('write_file')
      .run({ file_path: f.sibling, content: 'forbidden' }, f.context()),
    /grant/,
  );
  const missing = join(f.external, 'new.txt');
  f.grant('owner', 'write', missing);
  await assert.rejects(
    f
      .tool('write_file')
      .run({ file_path: missing, content: 'forbidden' }, f.context()),
    /cannot create/,
  );
  assert.equal(existsSync(missing), false);
  assert.equal(f.writes(), 0);
});

test('revocation after preparation and filesystem changes before commit produce no tool write', async (t) => {
  const f = fixture(t);
  f.grant();
  await f.tool('read_file').run({ file_path: f.file }, f.context());
  const edit = f.tool('edit_file');
  const args = {
    file_path: f.file,
    old_string: 'original',
    new_string: 'forbidden',
  };
  const prepared = await edit.prepare!(args, f.context());
  f.revoke();
  await assert.rejects(prepared(args, f.context()), /grant/);
  assert.equal(readFileSync(f.file, 'utf8'), 'original\n');
  f.grant();
  const raced = await edit.prepare!(args, f.context());
  f.beforeApply(() => writeFileSync(f.file, 'external writer\n'));
  await assert.rejects(raced(args, f.context()), /changed after preparation/);
  assert.equal(readFileSync(f.file, 'utf8'), 'external writer\n');
  assert.equal(f.writes(), 0);
});

test('mixed workspace/external patches and ungranted move targets fail before any writes', async (t) => {
  const f = fixture(t);
  f.grant();
  const mixed = `*** Begin Patch\n*** Update File: ${f.file}\n@@\n-original\n+changed\n*** Update File: local.txt\n@@\n-original\n+changed\n*** End Patch`;
  await assert.rejects(
    f.tool('apply_patch').run({ patchText: mixed }, f.context()),
    /cannot mix/,
  );
  const moved = `*** Begin Patch\n*** Update File: ${f.file}\n*** Move to: ${f.sibling}\n@@\n-original\n+changed\n*** End Patch`;
  await assert.rejects(
    f.tool('apply_patch').run({ patchText: moved }, f.context()),
    /grant/,
  );
  assert.equal(readFileSync(f.file, 'utf8'), 'original\n');
  assert.equal(readFileSync(f.local, 'utf8'), 'original\n');
  assert.equal(readFileSync(f.sibling, 'utf8'), 'original\n');
  assert.equal(f.writes(), 0);
});

test('credentials remain denied even when the backend grants the exact path', async (t) => {
  const f = fixture(t),
    credential = join(f.external, '.env');
  writeFileSync(credential, 'secret');
  f.grant('owner', 'write', credential);
  await assert.rejects(
    f.tool('read_file').run({ file_path: credential }, f.context()),
    /credential/,
  );
  await assert.rejects(
    f
      .tool('write_file')
      .run({ file_path: credential, content: 'changed' }, f.context()),
    /credential/,
  );
  assert.equal(readFileSync(credential, 'utf8'), 'secret');
});

test('ScriptedModel external read/edit changes the exact file and records balanced results in next request', async (t) => {
  const f = fixture(t);
  const model = new ScriptedModel([
    {
      message: {
        id: 'read',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'read-call', name: 'read_file', args: { file_path: f.file } },
        ],
      },
    },
    {
      message: {
        id: 'edit',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'edit-call',
            name: 'edit_file',
            args: {
              file_path: f.file,
              old_string: 'original',
              new_string: 'verified',
            },
          },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const runtime = new AgentRuntime({
    home: scratch(t),
    workspace: f.workspace,
    settings: defaultSettings(),
    model,
    headless: true,
    fileMutations: f.backend,
    approve: async () => 'approve',
  });
  cleanup(t, () => runtime.close());
  f.setOwner(runtime.session.id);
  f.grant();
  await runtime.harness.run('edit the explicitly granted file');
  assert.equal(readFileSync(f.file, 'utf8'), 'verified\n');
  assert.equal(readFileSync(f.sibling, 'utf8'), 'original\n');
  const messages = model.requests[2]!.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.status !== 'error'));
  assert.match(messages[0]!.content, /original/);
  assert.match(messages[1]!.content, /Edited/);
  runtime.store.requireBalancedTools(runtime.harness.messages);
});

test('native external directory/media reads cannot bypass the exact text-file backend', async (t) => {
  const f = fixture(t);
  f.grant('owner', 'read', f.external);
  await assert.rejects(
    f.tool('read_file').run({ file_path: f.external }, f.context()),
    /existing text files only/,
  );
  const image = join(f.external, 'picture.png');
  writeFileSync(image, 'not an actual image');
  f.grant('owner', 'read', image);
  let emitted = false;
  await assert.rejects(
    f.tool('read_file').run(
      { file_path: image },
      {
        ...f.context(),
        emitAttachments: () => {
          emitted = true;
        },
      },
    ),
    /existing text files only/,
  );
  assert.equal(emitted, false);
});

test('CLI external reads retain their original behavior without an injected backend', async (t) => {
  const f = fixture(t);
  const tool = buildTools(new Sandbox(f.workspace)).find(
    (tool) => tool.name === 'read_file',
  )!;
  assert.match(await tool.run({ file_path: f.file }, f.context()), /original/);
});

test('a real approval cannot retain an external grant revoked while the edit waited', async (t) => {
  const f = fixture(t);
  const model = new ScriptedModel([
    {
      message: {
        id: 'read',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'read-call', name: 'read_file', args: { file_path: f.file } },
        ],
      },
    },
    {
      message: {
        id: 'edit',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'edit-call',
            name: 'edit_file',
            args: {
              file_path: f.file,
              old_string: 'original',
              new_string: 'forbidden',
            },
          },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'stopped' } },
  ]);
  let approvals = 0;
  const runtime = new AgentRuntime({
    home: scratch(t),
    workspace: f.workspace,
    settings: defaultSettings(),
    model,
    headless: true,
    fileMutations: f.backend,
    approve: async () => {
      approvals++;
      f.revoke();
      return 'approve';
    },
  });
  cleanup(t, () => runtime.close());
  f.setOwner(runtime.session.id);
  f.grant();
  await runtime.harness.run('attempt a change while its grant is revoked');
  assert.equal(approvals, 1);
  assert.equal(f.writes(), 0);
  assert.equal(readFileSync(f.file, 'utf8'), 'original\n');
  const result = model.requests[2]!.messages.findLast(
    (message) => message.role === 'tool',
  )!;
  assert.equal(result.status, 'error');
  assert.match(result.content, /grant is missing or revoked/);
  runtime.store.requireBalancedTools(runtime.harness.messages);
});

test('a native backend without exact-file capability cannot fall back to raw external reads', async (t) => {
  const f = fixture(t);
  let reads = 0;
  const backend: FileMutations = {
    read: async (path) => {
      reads++;
      return { path, content: 'must not be exposed', revision: 'v1' };
    },
    apply: async () => {
      throw Error('unexpected write');
    },
  };
  const tools = buildTools(new Sandbox(f.workspace), {
    fileMutations: backend,
  });
  await assert.rejects(
    tools
      .find((tool) => tool.name === 'read_file')!
      .run({ file_path: f.file }, f.context()),
    /explicit external file grant/,
  );
  assert.equal(reads, 0);
});

test('with a native file backend, read_file still reads Circle offloaded results and job logs', async (t) => {
  const workspace = realpathSync.native(scratch(t));
  const offload = realpathSync.native(scratch(t));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(offload, 'large_tool_results'), { recursive: true });
  mkdirSync(join(offload, 'background_jobs', 'j1'), { recursive: true });
  writeFileSync(join(offload, 'large_tool_results', 'r1.txt'), 'large\n');
  writeFileSync(join(offload, 'background_jobs', 'j1', 'output'), 'job\n');
  const outside = realpathSync.native(scratch(t));
  writeFileSync(join(outside, 'other.txt'), 'other\n');
  // A desktop backend: nothing outside the workspace without a grant.
  const backend: FileMutations = {
    authorize(path) {
      throw Error(`external file grant is missing or revoked: ${path}`);
    },
    async read(path) {
      throw Error(`backend read ${path}`);
    },
    async apply() {
      throw Error('no writes');
    },
  };
  const tools = buildTools(new Sandbox(workspace, offload), {
    fileMutations: backend,
  });
  const read = tools.find((entry) => entry.name === 'read_file')!;
  const context: ToolContext = {
    sessionId: 's',
    signal: new AbortController().signal,
  };
  assert.match(
    String(
      await read.run({ file_path: '/large_tool_results/r1.txt' }, context),
    ),
    /large/,
  );
  assert.match(
    String(
      await read.run({ file_path: '/background_jobs/j1/output' }, context),
    ),
    /job/,
  );
  // Anything else outside still needs a grant.
  await assert.rejects(
    read.run({ file_path: join(outside, 'other.txt') }, context),
    /grant is missing or revoked/,
  );
});
