import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { emptyUsage } from '../../../src/types.ts';
import {
  defaultSettings,
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
    assistant('where', 'execute', { command: 'pwd' }),
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
  const refused = await f.call('switch-checkout', { checkoutId: target.id });
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /stop this session before moving it/);
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
