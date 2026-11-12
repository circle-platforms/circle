import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ExternalFileGrants } from '../src/workspace/external-file-grants.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { emptyUsage } from '../../../src/types.ts';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import type { RuntimeCommandName } from '../src/runtime-protocol.ts';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

const assistant = (
  id: string,
  name?: string,
  args: Record<string, unknown> = {},
) => ({
  usage: emptyUsage(),
  message: {
    id,
    role: 'assistant' as const,
    content: name ? '' : 'done',
    ...(name ? { tool_calls: [{ id: id + '-call', name, args }] } : {}),
  },
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

async function fixture(
  t: TestContext,
  replies: ConstructorParameters<typeof ScriptedModel>[0],
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-checkouts-'));
  const home = join(root, 'home');
  const workspace = join(root, '项目 repo');
  await mkdir(home);
  await mkdir(workspace);
  git(workspace, 'init', '-q', '-b', 'main');
  await writeFile(join(workspace, 'tracked.txt'), 'tracked\n');
  git(workspace, 'add', 'tracked.txt');
  git(workspace, 'commit', '-q', '-m', 'initial');
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const model = new ScriptedModel(replies);
  const watchers = new Set<() => void>();
  const open = () =>
    new RuntimeController({
      home,
      workspace,
      userHome: home,
      model,
      emit: () => {
        for (const check of watchers) check();
      },
    });
  let controller = open();
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ) => controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  const until = (predicate: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        watchers.delete(check);
        reject(Error('checkout state did not arrive'));
      }, 10_000);
      const check = () => {
        if (predicate()) {
          clearTimeout(timer);
          watchers.delete(check);
          resolve();
        }
      };
      watchers.add(check);
      check();
    });
  const idle = (id: string) => () =>
    model.requests.length > 0 &&
    controller.snapshot().sessions.find((s) => s.id === id)?.state !==
      'waiting';
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    workspace,
    model,
    call,
    until,
    idle,
    get controller() {
      return controller;
    },
    async restart() {
      await controller.close();
      controller = open();
      return controller;
    },
  };
}

test('a conversation continues in a linked worktree with history kept, future execution only there and the binding surviving restart', async (t) => {
  const f = await fixture(t, [
    assistant('before', 'write_file', {
      file_path: 'before.txt',
      content: 'written in the original checkout\n',
    }),
    assistant('first-end'),
    assistant('after', 'write_file', {
      file_path: 'after.txt',
      content: 'written in the worktree\n',
    }),
    assistant('where', 'execute', {
      // `pwd` is not a Windows command; ask Node for the working directory
      // instead, which runs on every shell the runtime supports.
      command: 'node -p "process.cwd()"',
    }),
    assistant('second-end'),
  ]);
  const session = f.controller.snapshot().activeSessionId;
  const listed = await f.call('checkouts', {
    workspaceId: f.controller.snapshot().workspaces[0]!.id,
  });
  assert.equal(listed.ok, true, listed.error);
  assert.deepEqual(
    (listed.data as { branch: string }[]).map((row) => row.branch),
    ['main'],
  );
  const workspaceId = f.controller.snapshot().workspaces[0]!.id;
  assert.equal((await f.call('set-mode', { mode: 'auto' })).ok, true);
  assert.equal((await f.call('prompt', { text: 'first turn' })).ok, true);
  await f.until(f.idle(session));
  assert.equal(
    await readFile(join(f.workspace, 'before.txt'), 'utf8'),
    'written in the original checkout\n',
  );
  await writeFile(join(f.workspace, 'uncommitted.txt'), 'stays here\n');

  const created = await f.call('create-checkout', {
    workspaceId,
    branch: 'feature/worktree-continue',
    start: 'HEAD',
  });
  assert.equal(created.ok, true, created.error);
  const target = created.data as { id: string; path: string; branch: string };
  assert.equal(target.branch, 'feature/worktree-continue');
  assert.notEqual(target.path, realpathSync.native(f.workspace));

  const missing = await f.call('switch-checkout', {
    checkoutId: 'not-a-checkout',
  });
  assert.equal(missing.ok, false);
  assert.equal(
    f.controller.snapshot().sessions.find((s) => s.id === session)
      ?.executionPath,
    realpathSync.native(f.workspace),
  );

  const switched = await f.call('switch-checkout', { checkoutId: target.id });
  assert.equal(switched.ok, true, switched.error);
  assert.deepEqual(switched.data, {
    ...target,
    current: false,
    switched: true,
    changesMoved: false,
  });
  const row = f.controller.snapshot().sessions.find((s) => s.id === session)!;
  assert.equal(f.controller.snapshot().activeSessionId, session);
  assert.equal(row.executionPath, target.path);
  assert.equal(row.executionBranch, 'feature/worktree-continue');
  assert.equal(row.workspaceId, workspaceId);
  assert.equal(row.mode, 'auto');
  assert.ok(
    row.messages.some((m) => m.role === 'user' && m.text === 'first turn'),
  );

  assert.equal((await f.call('prompt', { text: 'second turn' })).ok, true);
  await f.until(() => f.model.requests.length >= 5 && f.idle(session)());
  assert.equal(
    await readFile(join(target.path, 'after.txt'), 'utf8'),
    'written in the worktree\n',
  );
  assert.equal(existsSync(join(f.workspace, 'after.txt')), false);
  assert.equal(existsSync(join(target.path, 'uncommitted.txt')), false);
  assert.equal(
    await readFile(join(f.workspace, 'uncommitted.txt'), 'utf8'),
    'stays here\n',
  );
  const pwd = f.model.requests[4]!.messages.filter((m) => m.role === 'tool').at(
    -1,
  )!;
  assert.match(
    String(pwd.content),
    new RegExp(target.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  const request = f.model.requests[2]!;
  assert.ok(
    request.messages.some(
      (m) => m.role === 'user' && String(m.content).includes('first turn'),
    ),
  );
  assert.ok(String(request.system).includes(target.path));
  assert.equal(git(f.workspace, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');

  const restarted = await f.restart();
  const restored = restarted.snapshot().sessions.find((s) => s.id === session)!;
  assert.equal(restored.executionPath, target.path);
  assert.equal(restored.workspaceId, workspaceId);
});

test('a busy conversation is refused with its reason and keeps its binding and running turn', async (t) => {
  const f = await fixture(t, [
    assistant('slow', 'execute', { command: 'sleep 5' }),
  ]);
  const workspaceId = f.controller.snapshot().workspaces[0]!.id;
  const session = f.controller.snapshot().activeSessionId;
  const created = await f.call('create-checkout', {
    workspaceId,
    branch: 'feature/busy',
    start: 'HEAD',
  });
  assert.equal(created.ok, true, created.error);
  const target = created.data as { id: string };
  assert.equal((await f.call('set-mode', { mode: 'auto' })).ok, true);
  assert.equal((await f.call('prompt', { text: 'run slowly' })).ok, true);
  await f.until(
    () =>
      f.controller.snapshot().sessions.find((s) => s.id === session)?.state ===
      'waiting',
  );
  const before = git(f.workspace, 'worktree', 'list', '--porcelain');
  const status = await f.call('checkout-move-status');
  assert.deepEqual(status.data, {
    reason: 'stop this session before moving it',
  });
  const refused = await f.call('switch-checkout', { checkoutId: target.id });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'stop this session before moving it');
  const refusedCreate = await f.call('switch-checkout', {
    createWorktree: true,
  });
  assert.equal(refusedCreate.ok, false);
  assert.equal(refusedCreate.error, refused.error);
  assert.equal(git(f.workspace, 'worktree', 'list', '--porcelain'), before);
  assert.equal(
    f.controller.snapshot().sessions.find((s) => s.id === session)
      ?.executionPath,
    realpathSync.native(f.workspace),
  );
  assert.equal(
    f.controller.snapshot().sessions.find((s) => s.id === session)?.state,
    'waiting',
  );
  assert.equal((await f.call('abort')).ok, true);
});

test('listing local branches is read-only and the first message uses the chosen branch in a new checkout', async (t) => {
  const f = await fixture(t, [assistant('done')]);
  const {
    activeSessionId,
    workspaces: [project],
  } = f.controller.snapshot();
  const workspaceId = project!.id;
  git(f.workspace, 'switch', '-c', 'feature/base');
  await writeFile(join(f.workspace, 'tracked.txt'), 'feature content\n');
  git(f.workspace, 'commit', '-a', '-m', 'feature');
  const base = git(f.workspace, 'rev-parse', 'HEAD');
  git(f.workspace, 'switch', 'main');
  git(f.workspace, 'tag', 'not-a-branch', base);
  const original = git(f.workspace, 'worktree', 'list', '--porcelain');

  const branches = await f.call('checkout-branches', { workspaceId });
  assert.equal(branches.ok, true, branches.error);
  assert.deepEqual(branches.data, {
    branches: ['feature/base', 'main'],
    current: 'main',
  });
  assert.equal(git(f.workspace, 'worktree', 'list', '--porcelain'), original);

  const bad = await f.call('begin-session', {
    workspaceId,
    worktreeBase: 'not-a-branch',
    text: 'no such local branch',
  });
  assert.equal(bad.ok, false);
  assert.equal(git(f.workspace, 'worktree', 'list', '--porcelain'), original);
  const command = {
    id: randomUUID(),
    name: 'begin-session',
    sessionId: activeSessionId,
    payload: {
      workspaceId,
      worktreeBase: 'feature/base',
      text: 'first message',
    },
  };
  const started = await f.controller.dispatch(command);
  assert.equal(started.ok, true, started.error);
  const { sessionId } = started.data as { sessionId: string };
  await f.until(f.idle(sessionId));
  const row = f.controller
    .snapshot()
    .sessions.find((item) => item.id === sessionId)!;
  const target = row.executionPath!;
  assert.equal(row.workspaceId, workspaceId);
  assert.match(row.executionBranch!, /^circle-feature-base-[a-f0-9]{8}$/);
  assert.equal(basename(target), row.executionBranch);
  assert.equal(git(target, 'rev-parse', 'HEAD'), base);
  assert.equal(
    await readFile(join(target, 'tracked.txt'), 'utf8'),
    'feature content\n',
  );
  assert.equal(
    await readFile(join(f.workspace, 'tracked.txt'), 'utf8'),
    'tracked\n',
  );
  assert.ok(String(f.model.requests[0]!.system).includes(target));
  const after = git(f.workspace, 'worktree', 'list', '--porcelain');
  assert.deepEqual(await f.controller.dispatch(command), started);
  assert.equal(git(f.workspace, 'worktree', 'list', '--porcelain'), after);
});

test('a worktree created for a first command is prepared in the selected branch', async (t) => {
  const f = await fixture(t, []);
  const workspaceId = f.controller.snapshot().workspaces[0]!.id;
  const result = await f.call('begin-session', {
    workspaceId,
    worktreeBase: 'main',
    text: '!node -p "process.cwd()"',
    prepareOnly: true,
  });
  assert.equal(result.ok, true, result.error);
  const { sessionId } = result.data as { sessionId: string };
  const row = f.controller
    .snapshot()
    .sessions.find((item) => item.id === sessionId)!;
  assert.notEqual(row.executionPath, realpathSync.native(f.workspace));
  assert.equal(
    git(row.executionPath!, 'rev-parse', 'HEAD'),
    git(f.workspace, 'rev-parse', 'HEAD'),
  );
  assert.equal(f.model.requests.length, 0);
});

test('a failed first submission removes its unused clean checkout and branch', async (t) => {
  const f = await fixture(t, []);
  const {
    activeSessionId,
    workspaces: [project],
  } = f.controller.snapshot();
  const before = git(f.workspace, 'worktree', 'list', '--porcelain');
  const trusted = loadSettings(f.home).trusted_folders;
  const result = await f.call('begin-session', {
    workspaceId: project!.id,
    worktreeBase: 'main',
    text: 'invalid mode',
    mode: 'incorrect',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid mode');
  assert.equal(git(f.workspace, 'worktree', 'list', '--porcelain'), before);
  assert.equal(git(f.workspace, 'branch', '--list', 'circle-*'), '');
  assert.deepEqual(loadSettings(f.home).trusted_folders, trusted);
  assert.equal(f.controller.snapshot().activeSessionId, activeSessionId);
  assert.equal(f.model.requests.length, 0);
});

test('moving into a new worktree starts from the current checkout commit and rejects a stale location', async (t) => {
  const f = await fixture(t, []);
  const {
    activeSessionId: sessionId,
    workspaces: [project],
  } = f.controller.snapshot();
  const sourcePath = realpathSync.native(f.workspace);
  const existing = await f.call('create-checkout', {
    workspaceId: project!.id,
    branch: 'feature/active',
    start: 'HEAD',
  });
  assert.equal(existing.ok, true, existing.error);
  const source = existing.data as { id: string; path: string };
  assert.match(basename(source.path), /^checkout-/);
  await writeFile(
    join(source.path, 'tracked.txt'),
    'base in linked checkout\n',
  );
  git(source.path, 'commit', '-a', '-m', 'linked checkout baseline');
  const base = git(source.path, 'rev-parse', 'HEAD');
  git(source.path, 'branch', '-m', 'feature/renamed');
  const staleDestination = await f.call('switch-checkout', {
    checkoutId: source.id,
    expectedPath: sourcePath,
    expectedTargetBranch: 'feature/active',
  });
  assert.equal(staleDestination.ok, false);
  assert.equal(
    staleDestination.error,
    'destination branch changed; reopen the worktree menu',
  );
  assert.equal(
    f.controller.snapshot().sessions.find((item) => item.id === sessionId)
      ?.executionPath,
    sourcePath,
  );
  const switched = await f.call('switch-checkout', {
    checkoutId: source.id,
    expectedPath: sourcePath,
    expectedTargetBranch: 'feature/renamed',
  });
  assert.equal(switched.ok, true, switched.error);
  const availability = await f.call('checkout-move-status');
  assert.deepEqual(availability.data, {});
  const before = git(f.workspace, 'worktree', 'list', '--porcelain');
  const stale = await f.call('switch-checkout', {
    createWorktree: true,
    expectedPath: sourcePath,
  });
  assert.equal(stale.ok, false);
  assert.equal(
    stale.error,
    'execution location changed; reopen the worktree menu',
  );
  assert.equal(git(f.workspace, 'worktree', 'list', '--porcelain'), before);
  const staleBranch = await f.call('switch-checkout', {
    createWorktree: true,
    expectedPath: source.path,
    expectedBranch: 'feature/active',
  });
  assert.equal(staleBranch.ok, false);
  assert.equal(
    staleBranch.error,
    'execution branch changed; reopen the worktree menu',
  );
  assert.equal(git(f.workspace, 'worktree', 'list', '--porcelain'), before);
  await writeFile(
    join(source.path, 'uncommitted.txt'),
    'stays in linked checkout\n',
  );
  const result = await f.call('switch-checkout', {
    createWorktree: true,
    expectedPath: source.path,
    expectedBranch: 'feature/renamed',
  });
  assert.equal(result.ok, true, result.error);
  const target = result.data as { path: string; branch: string };
  assert.match(target.branch, /^circle-feature-renamed-[a-f0-9]{8}$/);
  assert.equal(basename(target.path), target.branch);
  assert.equal(git(target.path, 'rev-parse', 'HEAD'), base);
  assert.equal(existsSync(join(target.path, 'uncommitted.txt')), false);
  assert.equal(
    await readFile(join(source.path, 'uncommitted.txt'), 'utf8'),
    'stays in linked checkout\n',
  );
  const row = f.controller
    .snapshot()
    .sessions.find((item) => item.id === sessionId)!;
  assert.equal(row.executionPath, target.path);
  assert.equal(row.workspaceId, project!.id);
  assert.notEqual(row.executionWorkspaceId, row.workspaceId);
  assert.equal(row.executionWorkspaceId, (result.data as { id: string }).id);
  assert.equal(row.executionWorkspaceTrusted, true);

  const terminal = await f.call(
    'workspace-service',
    {
      service: 'terminal',
      method: 'create',
    },
    sessionId,
  );
  assert.equal(terminal.ok, true, terminal.error);
  const { cwd, id } = terminal.data as { cwd: string; id: string };
  assert.equal(cwd, target.path);
  const withTerminal = await f.call('checkout-move-status');
  assert.deepEqual(withTerminal.data, {
    reason: "stop this session's native resources and tasks before moving it",
  });
  const closed = await f.call(
    'workspace-service',
    {
      service: 'terminal',
      method: 'close',
      params: { id },
    },
    sessionId,
  );
  assert.equal(closed.ok, true, closed.error);
  const archive = await f.call('archive-workspace', {
    workspaceId: project!.id,
    confirmed: true,
  });
  assert.equal(archive.ok, true, archive.error);
  assert.deepEqual(archive.data, { archived: 1 });
  assert.ok(
    f.controller.snapshot().sessions.find((item) => item.id === sessionId)
      ?.archivedAt,
  );
});

test('a detached source uses the short commit shown by the conversation', async (t) => {
  const f = await fixture(t, []);
  const commit = git(f.workspace, 'rev-parse', 'HEAD');
  git(f.workspace, 'switch', '--quiet', '--detach', commit);
  const source = realpathSync.native(f.workspace);
  const before = git(f.workspace, 'worktree', 'list', '--porcelain');
  const stale = await f.call('switch-checkout', {
    createWorktree: true,
    expectedPath: source,
    expectedBranch: 'main',
  });
  assert.equal(stale.ok, false);
  assert.equal(
    stale.error,
    'execution branch changed; reopen the worktree menu',
  );
  assert.equal(git(f.workspace, 'worktree', 'list', '--porcelain'), before);
  const result = await f.call('switch-checkout', {
    createWorktree: true,
    expectedPath: source,
    expectedBranch: commit.slice(0, 7),
  });
  assert.equal(result.ok, true, result.error);
  const target = result.data as { path: string };
  assert.equal(git(target.path, 'rev-parse', 'HEAD'), commit);
});

test('an existing checkout is checked again at move binding and on first send', async (t) => {
  const f = await fixture(t, [assistant('done')]);
  const {
    activeSessionId: sessionId,
    workspaces: [project],
  } = f.controller.snapshot();
  const workspaceId = project!.id;
  const original = realpathSync.native(f.workspace);
  const created = await f.call('create-checkout', {
    workspaceId,
    branch: 'feature/before',
    start: 'HEAD',
  });
  assert.equal(created.ok, true, created.error);
  const checkout = created.data as { id: string; path: string };

  const external = join(f.root, 'outside.txt');
  await writeFile(external, 'external\n');
  await f.controller.grantExternalFile(sessionId, external, 'read');
  const revoke = ExternalFileGrants.prototype.revokeSession;
  let renamed = false;
  t.mock.method(
    ExternalFileGrants.prototype,
    'revokeSession',
    async function (this: ExternalFileGrants, id: string) {
      if (id === sessionId && !renamed) {
        git(checkout.path, 'branch', '-m', 'feature/after');
        renamed = true;
      }
      return revoke.call(this, id);
    },
  );
  const stale = await f.call('switch-checkout', {
    checkoutId: checkout.id,
    expectedTargetBranch: 'feature/before',
  });
  assert.equal(renamed, true);
  assert.equal(stale.ok, false);
  assert.equal(
    stale.error,
    'destination branch changed; reopen the worktree menu',
  );
  assert.equal(
    f.controller.snapshot().sessions.find((item) => item.id === sessionId)
      ?.executionPath,
    original,
  );

  const payload = {
    workspaceId,
    checkoutId: checkout.id,
    text: 'first message',
  };
  const rejected = await f.call('begin-session', {
    ...payload,
    expectedTargetBranch: 'feature/before',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, stale.error);
  assert.equal(f.controller.snapshot().activeSessionId, sessionId);
  assert.equal(f.model.requests.length, 0);

  const started = await f.call('begin-session', {
    ...payload,
    expectedTargetBranch: 'feature/after',
  });
  assert.equal(started.ok, true, started.error);
  const { sessionId: startedId } = started.data as { sessionId: string };
  await f.until(f.idle(startedId));
  assert.equal(
    f.controller.snapshot().sessions.find((item) => item.id === startedId)
      ?.executionPath,
    checkout.path,
  );
  assert.ok(String(f.model.requests[0]!.system).includes(checkout.path));
});

test('failed Git post-checkout cleans a pristine checkout and keeps one the hook changed', async (t) => {
  const f = await fixture(t, []);
  const workspaceId = f.controller.snapshot().workspaces[0]!.id;
  const before = git(f.workspace, 'worktree', 'list', '--porcelain');
  const hook = join(f.workspace, '.git', 'hooks', 'post-checkout');
  const payload = { workspaceId, worktreeBase: 'main', text: 'first message' };
  await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const clean = await f.call('begin-session', payload);
  assert.equal(clean.ok, false);
  assert.equal(git(f.workspace, 'worktree', 'list', '--porcelain'), before);
  assert.equal(git(f.workspace, 'branch', '--list', 'circle-*'), '');

  await writeFile(
    hook,
    '#!/bin/sh\nprintf "saved by hook" > retained.txt\nexit 1\n',
  );
  const dirty = await f.call('begin-session', payload);
  assert.equal(dirty.ok, false);
  const listed = await f.call('checkouts', { workspaceId });
  assert.equal(listed.ok, true, listed.error);
  const [retained] = (
    listed.data as { current: boolean; path: string }[]
  ).filter((checkout) => !checkout.current);
  assert.ok(retained);
  assert.ok(dirty.error?.endsWith(`new worktree kept at ${retained.path}`));
  assert.equal(
    await readFile(join(retained.path, 'retained.txt'), 'utf8'),
    'saved by hook',
  );
  assert.equal(f.model.requests.length, 0);
});
