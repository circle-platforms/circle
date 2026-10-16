import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { cycleRepositoryIdentity } from '../src/workspace/cycle-repository-identity.js';
import { createWorkspaceCyclePorts } from '../src/workspace/cycle-ports.js';
import { GitWorkspaceService } from '../src/workspace/git.js';
import { TaskService } from '../src/workspace/task-service.js';
import type { CycleRecord } from '../src/workspace/delivery-cycle.js';
const exec = promisify(execFile);
// Existing hidden files cannot be opened with 'w' on Windows. Keep the real
// Git-created hidden attribute and edit through an existing read/write handle.
async function rewriteMetadata(path: string, content: string) {
  const file = await open(path, 'r+');
  try {
    await file.truncate(0);
    await file.write(content, 0, 'utf8');
  } finally {
    await file.close();
  }
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cycle-identity-')));
  let tasks: TaskService | undefined;
  t.after(async () => {
    await tasks?.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = join(root, 'source');
  await mkdir(workspace);
  const git = async (cwd: string, ...args: string[]) =>
    (
      await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    ).stdout.trim();
  await git(workspace, 'init', '--initial-branch=main');
  await writeFile(join(workspace, 'readme'), 'base\n');
  await git(workspace, 'add', 'readme');
  await git(
    workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Baseline',
  );
  const target = join(root, 'linked');
  await git(workspace, 'worktree', 'add', '-b', 'codex/identity', target);
  return {
    root,
    workspace,
    target,
    git,
    own: (service: TaskService) => {
      tasks = service;
    },
  };
}

test('fresh repository identity handles real linked worktrees and rejects dangling or malformed metadata', async (t) => {
  const f = await fixture(t);
  const source = await cycleRepositoryIdentity(f.workspace),
    target = await cycleRepositoryIdentity(f.target);
  assert.equal(source.common, target.common);
  assert.equal(target.head, 'ref: refs/heads/codex/identity');
  const marker = join(f.target, '.git');
  await chmod(marker, 0o400);
  assert.equal(
    (await cycleRepositoryIdentity(f.target)).directory,
    target.directory,
  );
  const originalMarker = await readFile(marker, 'utf8');
  // Write permission and Windows' hidden attribute are distinct. Preserve the
  // real hidden file, prove the 'w' restriction, then use its supported handle.
  await chmod(marker, 0o600);
  if (process.platform === 'win32') {
    await exec('attrib.exe', ['+H', marker]);
    await assert.rejects(
      writeFile(marker, 'must not overwrite hidden metadata'),
      { code: 'EPERM' },
    );
    assert.equal(await readFile(marker, 'utf8'), originalMarker);
  }
  await rewriteMetadata(
    marker,
    `gitdir: ${relative(f.target, target.directory)}\r\n`,
  );
  assert.equal(
    (await cycleRepositoryIdentity(f.target)).directory,
    target.directory,
  );
  await rewriteMetadata(marker, originalMarker);
  const commonFile = join(target.directory, 'commondir'),
    original = await readFile(commonFile, 'utf8');
  await writeFile(
    commonFile,
    relative(target.directory, source.common) + '\r\n',
  );
  assert.equal((await cycleRepositoryIdentity(f.target)).common, source.common);
  await writeFile(commonFile, 'missing-common\n');
  await assert.rejects(cycleRepositoryIdentity(f.target), { code: 'ENOENT' });
  await writeFile(commonFile, '../../\nignored\n');
  await assert.rejects(cycleRepositoryIdentity(f.target), /invalid.*commondir/);
  await writeFile(commonFile, original);
  const head = join(target.directory, 'HEAD');
  await writeFile(
    head,
    'ref: refs/heads/codex/identity\nref: refs/heads/foreign\n',
  );
  await assert.rejects(cycleRepositoryIdentity(f.target), /invalid.*HEAD/);
  await rewriteMetadata(marker, 'gitdir: \n');
  await assert.rejects(cycleRepositoryIdentity(f.target), /invalid.*gitdir/);
});

test('metadata inspection fails closed on config I/O and Git environment overrides', async (t) => {
  const f = await fixture(t);
  const identity = await cycleRepositoryIdentity(f.target),
    config = join(identity.common, 'config');
  await rename(config, config + '.retained');
  await mkdir(config);
  await assert.rejects(cycleRepositoryIdentity(f.target), { code: 'EISDIR' });
  await rm(config, { recursive: true });
  await rename(config + '.retained', config);
  for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE']) {
    const previous = process.env[name];
    process.env[name] = f.target;
    try {
      await assert.rejects(
        cycleRepositoryIdentity(f.target),
        /environment overrides/,
      );
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});

test('cycle task polling launches no Git processes but still detects live branch and repository replacement', async (t) => {
  const f = await fixture(t);
  const tasks = new TaskService({
    workspace: f.workspace,
    dataDir: join(f.root, 'tasks'),
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
    autoStart: false,
    emit: () => {},
    createRuntime: () => {
      throw Error('must not run');
    },
  });
  f.own(tasks);
  const ports = createWorkspaceCyclePorts({
    workspace: f.workspace,
    dataDir: join(f.root, 'ports'),
    sessionId: 'owner',
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
    getTaskService: () => tasks,
    withResource: async (_resource, run) => run(),
    verify: async () => [],
  });
  const cycle: CycleRecord = {
    id: 'identity',
    workspace: f.workspace,
    title: 'Implement',
    body: 'Read real code',
    acceptanceCriteria: ['works'],
    state: 'queued',
    attempt: 0,
    taskIds: [],
    failureCounts: {},
    updatedAt: new Date().toISOString(),
  };
  const ids = await ports.tasks.create(
    cycle,
    { kind: 'implementation', prompt: 'Implement' },
    { operationId: 'create' },
  );
  const task = tasks.getTask(ids[0]);
  assert.ok(task);
  // Integration creation is genuine Git. Polling must inspect its fresh files,
  // without executing git or changing the mutation-time snapshot/CAS path.
  let commands = 0;
  const actual = GitWorkspaceService.prototype.git;
  t.mock.method(
    GitWorkspaceService.prototype,
    'git',
    function (
      this: GitWorkspaceService,
      ...args: Parameters<GitWorkspaceService['git']>
    ) {
      commands++;
      return actual.apply(this, args);
    },
  );
  assert.equal(await ports.tasks.status(cycle, ids), 'pending');
  assert.equal(commands, 0);
  // Find the actual owned cycle via git worktree metadata, not another integration.
  const listing = await f.git(f.workspace, 'worktree', 'list', '--porcelain');
  const entries = listing.split('\n\n');
  const own = entries.find((e) => e.includes('branch refs/heads/codex/cycle-'));
  assert.ok(own);
  const ownedPath = own.split('\n')[0].slice('worktree '.length);
  const identity = await cycleRepositoryIdentity(ownedPath),
    head = join(identity.directory, 'HEAD'),
    oldHead = await readFile(head, 'utf8');
  await writeFile(head, 'ref: refs/heads/codex/foreign\n');
  await assert.rejects(ports.tasks.status(cycle, ids), /branch changed/);
  await writeFile(head, (await f.git(f.workspace, 'rev-parse', 'HEAD')) + '\n');
  await assert.rejects(ports.tasks.status(cycle, ids), /branch changed/);
  await writeFile(head, oldHead);
  const foreign = join(f.root, 'foreign');
  await mkdir(foreign);
  await f.git(foreign, 'init', '--initial-branch=main');
  const common = join(identity.directory, 'commondir'),
    oldCommon = await readFile(common, 'utf8');
  await writeFile(common, join(foreign, '.git') + '\n');
  await assert.rejects(ports.tasks.status(cycle, ids), /another repository/);
  await writeFile(common, oldCommon);
  assert.equal(await ports.tasks.status(cycle, ids), 'pending');
  const before = commands;
  await ports.git.snapshot(cycle);
  assert.ok(
    commands > before,
    'mutation-time repository snapshot still executes real Git',
  );
  await f.git(ownedPath, 'config', 'extensions.worktreeConfig', 'true');
  await f.git(ownedPath, 'config', '--worktree', 'core.worktree', foreign);
  assert.equal(
    await realpath(await f.git(ownedPath, 'rev-parse', '--show-toplevel')),
    await realpath(foreign),
  );
  await assert.rejects(ports.git.snapshot(cycle), /worktree root changed/);
});

test('cycle commit reuses locked mutation snapshots and rejects a real edit between stage and commit', async (t) => {
  const f = await fixture(t);
  const tasks = new TaskService({
    workspace: f.workspace,
    dataDir: join(f.root, 'tasks'),
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
    autoStart: false,
    emit: () => {},
    createRuntime: () => {
      throw Error('must not run');
    },
  });
  f.own(tasks);
  const ports = createWorkspaceCyclePorts({
    workspace: f.workspace,
    dataDir: join(f.root, 'ports'),
    sessionId: 'owner',
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
    getTaskService: () => tasks,
    withResource: async (_resource, run) => run(),
    verify: async () => [],
  });
  const cycle: CycleRecord = {
    id: 'commit-cas',
    workspace: f.workspace,
    title: 'Implement',
    body: 'Real CAS',
    acceptanceCriteria: ['works'],
    state: 'queued',
    attempt: 0,
    taskIds: [],
    failureCounts: {},
    updatedAt: new Date().toISOString(),
  };
  await ports.tasks.create(
    cycle,
    { kind: 'implementation', prompt: 'Implement' },
    { operationId: 'create' },
  );
  const listing = await f.git(f.workspace, 'worktree', 'list', '--porcelain');
  const entry = listing
    .split('\n\n')
    .find((e) => e.includes('branch refs/heads/codex/cycle-'));
  assert.ok(entry);
  const path = entry.split('\n')[0].slice('worktree '.length),
    file = join(path, 'readme');
  await writeFile(file, 'accepted manual change\n');
  const before = await ports.git.snapshot(cycle),
    head = await f.git(path, 'rev-parse', 'HEAD');
  const actualGit = GitWorkspaceService.prototype.git;
  let race = true;
  t.mock.method(
    GitWorkspaceService.prototype,
    'git',
    async function (
      this: GitWorkspaceService,
      ...args: Parameters<GitWorkspaceService['git']>
    ) {
      const result = await actualGit.apply(this, args);
      if (race && args[0].join(' ') === 'diff --cached --name-only -z') {
        race = false;
        await writeFile(file, 'external after stage\n');
      }
      return result;
    },
  );
  await assert.rejects(
    ports.git.commit(
      cycle,
      {
        revision: before.revision,
        paths: ['readme'],
        message: 'Must reject stale stage',
      },
      { operationId: 'raced' },
    ),
    /changed/,
  );
  assert.equal(await readFile(file, 'utf8'), 'external after stage\n');
  assert.equal(
    await f.git(path, 'rev-parse', 'HEAD'),
    head,
    'stale revision never commits',
  );
  const next = await ports.git.snapshot(cycle);
  let scans = 0;
  const actualSnapshot = GitWorkspaceService.prototype.snapshot;
  t.mock.method(
    GitWorkspaceService.prototype,
    'snapshot',
    function (this: GitWorkspaceService) {
      scans++;
      return actualSnapshot.call(this);
    },
  );
  const committed = await ports.git.commit(
    cycle,
    {
      revision: next.revision,
      paths: ['readme'],
      message: 'Commit actual external edit',
    },
    { operationId: 'accepted' },
  );
  assert.equal(
    scans,
    5,
    'state plus pre/post stage and pre/post commit; no duplicate post-mutation scans',
  );
  assert.notEqual(committed.head, head);
  assert.equal(committed.head, await f.git(path, 'rev-parse', 'HEAD'));
  assert.equal(
    await f.git(path, 'show', 'HEAD:readme'),
    'external after stage',
  );
  assert.match(
    await f.git(path, 'show', '-s', '--format=%B'),
    /Signed-off-by: Fixture <fixture@example.invalid>/,
  );
});
