import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { AgentRuntime } from '../../../src/runtime.js';
import { defaultSettings, trustFolder } from '../../../src/settings.js';
import { ScriptedModel } from '../../../src/testing.js';
import type { Message } from '../../../src/types.js';
import { cleanup, scratch } from '../../../tests/helpers.js';
import {
  CollaborationResources,
  type TaskRecord,
} from '../src/workspace/collaboration.js';
import { createWorkspaceCyclePorts } from '../src/workspace/cycle-ports.js';
import {
  DeliveryCycleService,
  type CycleRecord,
} from '../src/workspace/delivery-cycle.js';
import { DeliveryService } from '../src/workspace/delivery.js';
import { GitWorkspaceService } from '../src/workspace/git.js';
import {
  TaskService,
  type TaskServiceOptions,
} from '../src/workspace/task-service.js';
import { createTaskVerifier } from '../src/workspace/task-verification.js';
const exec = promisify(execFile);
const identity = { name: 'Fixture', email: 'fixture@example.invalid' };
const criterion = 'module returns the working greeting';
const message = (
  content: string,
  tool_calls?: Message['tool_calls'],
): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content,
  ...(tool_calls ? { tool_calls } : {}),
});
async function git(workspace: string, ...args: string[]) {
  return (
    await exec('git', ['-C', workspace, ...args], { encoding: 'utf8' })
  ).stdout.trim();
}
function fixtureDelivery(
  workspace: string,
  ghPath: string,
  platform = process.platform,
): DeliveryService {
  const service = new DeliveryService(workspace, ghPath);
  if (platform === 'win32')
    service.gh = async (args) =>
      (
        await exec(process.execPath, [ghPath, ...args], {
          cwd: workspace,
          encoding: 'utf8',
          env: {
            ...process.env,
            GH_PROMPT_DISABLED: '1',
            GH_NO_UPDATE_NOTIFIER: '1',
          },
        })
      ).stdout;
  return service;
}

async function fixture(t: Parameters<typeof scratch>[0]) {
  const root = await realpath(scratch(t, 'circle-cycle-ports-'));
  const workspace = join(root, 'source'),
    remote = join(root, 'remote.git'),
    dataDir = join(root, 'private-data');
  await mkdir(workspace);
  await mkdir(dataDir);
  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(workspace, 'init', '--initial-branch=main');
  await git(workspace, 'config', 'core.autocrlf', 'false');
  await writeFile(
    join(workspace, 'app.cjs'),
    "exports.greeting='missing';exports.readyForCI=false;\n",
  );
  await writeFile(join(workspace, 'README.md'), 'baseline README\n');
  await writeFile(join(workspace, 'staged.txt'), 'baseline staged file\n');
  await writeFile(
    join(workspace, 'package.json'),
    JSON.stringify({
      name: 'cycle-fixture',
      private: true,
      scripts: { test: 'node oracle.cjs' },
    }),
  );
  await writeFile(
    join(workspace, 'oracle.cjs'),
    "require('node:assert/strict').equal(require('./app.cjs').greeting,'hello');console.log('INDEPENDENT_ORACLE_PASSED');\n",
  );
  await git(
    workspace,
    'add',
    'app.cjs',
    'README.md',
    'staged.txt',
    'package.json',
    'oracle.cjs',
  );
  await git(
    workspace,
    '-c',
    `user.name=${identity.name}`,
    '-c',
    `user.email=${identity.email}`,
    'commit',
    '-m',
    'Create fixture',
  );
  await git(workspace, 'remote', 'add', 'origin', remote);
  await git(workspace, 'push', '--set-upstream', 'origin', 'main');
  const baseline = await git(workspace, 'rev-parse', 'HEAD');
  await writeFile(join(workspace, 'README.md'), 'human unsaved disk edit\n');
  await writeFile(join(workspace, 'staged.txt'), 'human staged content\n');
  await git(workspace, 'add', 'staged.txt');
  await writeFile(
    join(workspace, 'staged.txt'),
    'human additional working content\n',
  );
  const originalStatus = await git(workspace, 'status', '--porcelain=v1');
  const originalIndex = await readFile(join(workspace, '.git', 'index'));
  const ghState = join(root, 'fake-gh-state.json'),
    ghPath = join(root, 'fake-gh');
  await writeFile(
    ghState,
    JSON.stringify({
      created: 0,
      ready: 0,
      logs: 0,
      retries: 0,
      holdCI: true,
      pr: null,
      calls: [],
    }),
  );
  await writeFile(
    ghPath,
    `#!${process.execPath}\n` +
      String.raw`
const fs=require('node:fs'),cp=require('node:child_process');
const path=process.argv[1]+'.state';
const statePath=fs.readFileSync(path,'utf8');
const s=JSON.parse(fs.readFileSync(statePath,'utf8')),a=process.argv.slice(2);
s.calls.push(a);
const git=(...args)=>cp.execFileSync('git',args,{cwd:process.cwd(),encoding:'utf8'}).trim();
const branch=git('branch','--show-current'),head=(()=>{try{return git('rev-parse','--verify','--quiet','refs/remotes/origin/'+branch)}catch{return ''}})();
const save=()=>fs.writeFileSync(statePath,JSON.stringify(s));
const pr=()=>{if(!s.pr){save();process.exit(1)};return {...s.pr,headRefOid:s.overrideHead??head,headRefName:s.overrideBranch??branch,state:s.pr.state??'OPEN'}};
let out;
if(a[0]==='auth')out='logged in';
else if(a[0]==='--version')out='gh version 2.83.2 (fixture)';
else if(a[0]==='pr'&&a[1]==='view')out=pr();
else if(a[0]==='pr'&&a[1]==='list'){if(s.listFailure){save();process.exit(7)};out=s.pr&&s.pr.state!=='CLOSED'&&s.pr.state!=='MERGED'?[pr()]:[];}
else if(a[0]==='pr'&&a[1]==='create'){if(!a.includes('--draft'))throw Error('must be draft');s.created++;s.pr={number:7,url:'https://github.invalid/fixture/repo/pull/7',isDraft:true};out=s.pr.url;}
else if(a[0]==='pr'&&a[1]==='checks'){
 if(s.changeDuringChecks==='head')s.overrideHead='unverified-head-during-checks';
 if(s.changeDuringChecks==='branch')s.overrideBranch='codex/other';
 if(s.changeDuringChecks==='number')s.pr.number=99;
 if(s.changeDuringChecks==='local')fs.writeFileSync('README.md','concurrent local change');
 const content=git('show',head+':app.cjs');
 out=s.checks??[{name:'remote acceptance',state:content.includes('readyForCI=true')?'SUCCESS':'FAILURE',bucket:s.holdCI?'pending':s.forcePass||content.includes('readyForCI=true')?'pass':'fail',link:'https://github.invalid/fixture/repo/actions/runs/42/job/3'}];
}
else if(a[0]==='pr'&&a[1]==='ready'){pr();if(a.includes('--undo')){s.undos=(s.undos??0)+1;s.pr.isDraft=true;out='draft'}else{s.ready++;s.pr.isDraft=false;if(s.changeDuringReady)s.overrideHead='unverified-head-during-ready';out='ready'}}
else if(a[0]==='run'&&a[1]==='view'){s.logs++;out='CI_ACTUAL_LOG: remote acceptance requires readyForCI=true';}
else if(a[0]==='run'&&a[1]==='rerun'){s.retries++;out='retry requested';}
else throw Error('unsupported fake gh call '+a.join(' '));
save();console.log(typeof out==='string'?out:JSON.stringify(out));
`,
    { mode: 0o700 },
  );
  await writeFile(ghPath + '.state', ghState);
  return {
    root,
    workspace,
    remote,
    dataDir,
    baseline,
    originalStatus,
    originalIndex,
    ghState,
    ghPath,
  };
}

test('real scripted tasks integrate and repair failing CI on one draft PR without changing a dirty source repository', async (t) => {
  const f = await fixture(t),
    resources = new CollaborationResources(),
    tasksDir = join(f.dataDir, 'tasks');
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: join(f.dataDir, 'verification'),
    runtimeExecutable: process.execPath,
    checks: [{ criterion, script: 'test', oraclePaths: ['oracle.cjs'] }],
    withBuildResource: (run, _signal, ctx) => ctx.withResource('build', run),
  });
  const prompts: string[] = [],
    createdTasks: TaskRecord[] = [];
  const taskOptions: TaskServiceOptions = {
    workspace: f.workspace,
    dataDir: tasksDir,
    identity,
    resources,
    settingsPath: join(f.dataDir, 'settings.json'),
    emit: () => {},
    verify,
    createRuntime: async (task, ctx) => {
      prompts.push(task.spec.prompt);
      createdTasks.push(structuredClone(task));
      const repair = task.spec.prompt.includes('CI_ACTUAL_LOG:');
      const home = join(f.dataDir, 'homes', task.spec.id);
      await mkdir(home, { recursive: true });
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        model: new ScriptedModel([
          {
            message: message('', [
              {
                id: 'write',
                name: 'write_file',
                args: {
                  file_path: 'app.cjs',
                  content: `exports.greeting='hello';exports.readyForCI=${repair};\n`,
                },
              },
            ]),
          },
          { message: message('implemented and verified') },
        ]),
        settings: trustFolder(defaultSettings(), ctx.worktree),
        bundledExtensions: false,
        screenshot: false,
        headless: true,
        approve: async () => 'approve',
      });
    },
  };
  let service = new TaskService(taskOptions);
  cleanup(t, () => service.close());
  const pushedHeads: string[] = [];
  const trackPush = (service: GitWorkspaceService) => {
    const run = service.git.bind(service);
    service.git = async (args, input) => {
      if (args[0] === 'push')
        pushedHeads.push(await git(service.root, 'rev-parse', 'HEAD'));
      return run(args, input);
    };
    return service;
  };
  const deepPorts = join(
    f.dataDir,
    'deep-' + 'd'.repeat(Math.max(1, 180 - f.dataDir.length)),
  );
  assert.ok(
    join(
      deepPorts,
      'cycle-verification',
      's'.repeat(64),
      'u'.repeat(36),
      'index-XXXXXX',
    ).length > 260,
    'fixture retains the failing native path depth',
  );
  const portsOptions = {
    workspace: f.workspace,
    dataDir: deepPorts,
    sessionId: 'trusted-session',
    getTaskService: () => service,
    verify: async (...args: Parameters<typeof verify>) => {
      const [task, ctx] = args;
      assert.ok(
        join(ctx.artifactDirectory, 'index-XXXXXX').length < 240,
        'private temp paths retain native Windows headroom',
      );
      const owner = JSON.parse(
        await readFile(
          join(ctx.artifactDirectory, 'verification.json'),
          'utf8',
        ),
      );
      assert.equal(owner.sessionId, 'trusted-session');
      assert.equal(owner.workspace, ctx.worktree);
      assert.equal(owner.head, ctx.changes.head);
      assert.equal(task.spec.sessionId, owner.sessionId);
      return verify(...args);
    },
    withResource: <T>(
      resource: 'build' | 'ui' | 'browser',
      run: () => Promise<T>,
    ) => resources.withResource(resource, run),
    identity,
    createGit: (path: string) =>
      trackPush(
        new GitWorkspaceService(path, {
          identity,
          signoff: true,
          setUpstream: false,
        }),
      ),
    createDelivery: (path: string) => {
      const service = fixtureDelivery(path, f.ghPath);
      trackPush(service.git);
      return service;
    },
  };
  const ports = createWorkspaceCyclePorts(portsOptions);
  let cycles = await DeliveryCycleService.open({
    dataDir: join(f.dataDir, 'cycles'),
    ports,
  });
  cleanup(t, () => cycles.close());
  let cycle = await cycles.create(
    {
      id: 'web-example',
      workspace: f.workspace,
      title: 'Implement working greeting',
      body: 'Build the greeting and satisfy the project acceptance.',
      acceptanceCriteria: [criterion],
    },
    { operationId: 'create-web' },
  );
  let restarted = false;
  for (let i = 0; i < 250; i++) {
    cycle = await cycles.advance(cycle.id);
    if (!restarted && cycle.state === 'waiting_ci') {
      // Reopen both persisted service owners before CI returns its failure.
      await cycles.close();
      await service.close();
      service = new TaskService(taskOptions);
      const gh = JSON.parse(await readFile(f.ghState, 'utf8'));
      gh.holdCI = false;
      await writeFile(f.ghState, JSON.stringify(gh));
      cycles = await DeliveryCycleService.open({
        dataDir: join(f.dataDir, 'cycles'),
        ports: createWorkspaceCyclePorts(portsOptions),
      });
      restarted = true;
      assert.equal(
        createdTasks.length,
        1,
        'restart must not replay implementation',
      );
    }
    if (cycle.state === 'pending_human_merge' || cycle.state === 'needs_review')
      break;
    await delay(25);
  }
  assert.equal(cycle.state, 'pending_human_merge', JSON.stringify(cycle));
  assert.equal(cycle.attempt, 1);
  assert.equal(restarted, true);
  assert.notEqual(await realpath(cycle.workspace), await realpath(f.workspace));
  assert.equal(
    cycle.lastFailure?.logs,
    'CI_ACTUAL_LOG: remote acceptance requires readyForCI=true\n',
  );
  assert.equal(createdTasks.length, 2);
  assert.ok(
    prompts[1]!.includes(
      'CI_ACTUAL_LOG: remote acceptance requires readyForCI=true',
    ),
  );
  assert.equal(createdTasks[0]!.spec.baseline, f.baseline);
  assert.notEqual(createdTasks[1]!.spec.baseline, f.baseline);
  assert.equal(
    await readFile(join(cycle.workspace, 'app.cjs'), 'utf8'),
    "exports.greeting='hello';exports.readyForCI=true;\n",
  );
  const branch = await git(cycle.workspace, 'branch', '--show-current');
  assert.match(branch, /^codex\/cycle-/);
  assert.equal(
    await git(f.remote, 'rev-parse', `refs/heads/${branch}`),
    cycle.publishedHead,
  );
  assert.equal(await git(f.remote, 'rev-parse', 'refs/heads/main'), f.baseline);
  assert.match(
    await git(cycle.workspace, 'log', '--format=%B', `${f.baseline}..HEAD`),
    /Signed-off-by: Fixture <fixture@example.invalid>/,
  );
  assert.equal(await git(f.workspace, 'rev-parse', 'HEAD'), f.baseline);
  assert.equal(
    await git(f.workspace, 'status', '--porcelain=v1'),
    f.originalStatus,
  );
  assert.deepEqual(
    await readFile(join(f.workspace, '.git', 'index')),
    f.originalIndex,
  );
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'human unsaved disk edit\n',
  );
  assert.equal(
    await readFile(join(f.workspace, 'staged.txt'), 'utf8'),
    'human additional working content\n',
  );
  const gh = JSON.parse(await readFile(f.ghState, 'utf8'));
  assert.equal(gh.created, 1);
  assert.equal(gh.ready, 1);
  assert.equal(gh.logs, 1);
  assert.equal(gh.pr.isDraft, false);
  assert.equal(
    pushedHeads.length,
    2,
    'exactly one actual Git push per implementation/repair attempt',
  );
  assert.equal(new Set(pushedHeads).size, 2);
  assert.ok(
    !gh.calls.some((args: string[]) => args[0] === 'pr' && args[1] === 'merge'),
  );
  const before = await readFile(f.ghState, 'utf8');
  await cycles.advance(cycle.id);
  assert.equal(await readFile(f.ghState, 'utf8'), before);
  await cycles.close();
  cycles = await DeliveryCycleService.open({
    dataDir: join(f.dataDir, 'cycles'),
    ports: createWorkspaceCyclePorts(portsOptions),
  });
  assert.deepEqual(await cycles.advance(cycle.id), cycle);
  assert.equal(await readFile(f.ghState, 'utf8'), before);
  await assert.rejects(
    ports.git.snapshot({ ...cycle, workspace: f.root }),
    /owned integration/,
  );
});

test('cycle adapter refuses unverified candidates, changed ownership and missing integration manifests', async (t) => {
  const f = await fixture(t),
    service = new TaskService({
      workspace: f.workspace,
      dataDir: join(f.dataDir, 'tasks'),
      identity,
      autoStart: false,
      emit: () => {},
      createRuntime: () => {
        throw Error('must not run');
      },
    });
  cleanup(t, () => service.close());
  const ports = createWorkspaceCyclePorts({
    workspace: f.workspace,
    dataDir: join(f.dataDir, 'ports'),
    sessionId: 'trusted-session',
    getTaskService: () => service,
    identity,
    withResource: async (_resource, run) => run(),
    verify: async () => [],
  });
  const cycle: CycleRecord = {
    id: 'unverified',
    workspace: f.workspace,
    title: 'Verify actual code',
    body: 'Implement safely',
    acceptanceCriteria: [criterion],
    state: 'queued',
    attempt: 0,
    taskIds: [],
    failureCounts: {},
    updatedAt: new Date().toISOString(),
  };
  const ids = await ports.tasks.create(
    cycle,
    { kind: 'implementation', prompt: 'Implement' },
    { operationId: 'create-tasks' },
  );
  assert.equal(await ports.tasks.status(cycle, ids), 'pending');
  assert.deepEqual(
    await ports.tasks.merge(cycle, ids, { operationId: 'merge-unverified' }),
    { status: 'needs_review' },
  );
  await assert.rejects(
    ports.tasks.status(cycle, ['another-session-task']),
    /owned candidate/,
  );
  await assert.rejects(
    ports.git.snapshot({ ...cycle, title: 'tampered' }),
    /ownership record mismatch/,
  );
  const integration = (await service.call(
    'trusted-session',
    'createIntegration',
    {},
  )) as { path: string };
  // Corrupt the real cycle manifest, not a different integration's manifest.
  const worktrees = await git(f.workspace, 'worktree', 'list', '--porcelain');
  const canonicalWorktrees = await Promise.all(
    worktrees
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => realpath(line.slice(9))),
  );
  const sourcePath = await realpath(f.workspace);
  const otherIntegrationPath = await realpath(integration.path);
  const cyclePath = canonicalWorktrees.find(
    (candidate) =>
      candidate !== sourcePath && candidate !== otherIntegrationPath,
  );
  assert.ok(cyclePath, 'the cycle owned integration must exist');
  const manifest = join(cyclePath, '..', 'owner.json');
  await rename(manifest, manifest + '.retained');
  await assert.rejects(
    ports.tasks.create(
      cycle,
      { kind: 'repair', prompt: 'Do not recreate missing ownership' },
      { operationId: 'missing-owner' },
    ),
    /ENOENT/,
  );
  assert.equal(
    await git(f.workspace, 'worktree', 'list', '--porcelain'),
    worktrees,
  );
  await rename(manifest + '.retained', manifest);
  const originalBranch = await git(cyclePath, 'branch', '--show-current');
  await git(cyclePath, 'switch', '-c', 'codex/foreign-owner-branch');
  await assert.rejects(ports.tasks.status(cycle, ids), /branch changed/);
  await assert.rejects(ports.git.snapshot(cycle), /branch changed/);
  await git(cyclePath, 'switch', originalBranch);
  assert.equal(
    await git(f.workspace, 'status', '--porcelain=v1'),
    f.originalStatus,
  );
  assert.deepEqual(
    await readFile(join(f.workspace, '.git', 'index')),
    f.originalIndex,
  );
});

test('accepted task patches stop at a changed integration HEAD and manual cycle commits use the trusted signed identity', async (t) => {
  const f = await fixture(t),
    dataDir = join(f.dataDir, 'tasks');
  const service = new TaskService({
    workspace: f.workspace,
    dataDir,
    identity,
    emit: () => {},
    createRuntime: async (task, ctx) => {
      const home = join(f.dataDir, 'homes', task.spec.id);
      await mkdir(home, { recursive: true });
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        model: new ScriptedModel([
          {
            message: message('', [
              {
                id: 'write',
                name: 'write_file',
                args: {
                  file_path: 'app.cjs',
                  content: 'accepted task content\n',
                },
              },
            ]),
          },
          { message: message('done') },
        ]),
        settings: trustFolder(defaultSettings(), ctx.worktree),
        bundledExtensions: false,
        screenshot: false,
        headless: true,
        approve: async () => 'approve',
      });
    },
    verify: async (_task, ctx) => [
      {
        criterion,
        status:
          (await readFile(join(ctx.worktree, 'app.cjs'), 'utf8')) ===
          'accepted task content\n'
            ? 'passed'
            : 'failed',
        source: 'inspection',
        evidence: 'Independent verifier compared the actual file bytes',
      },
    ],
  });
  cleanup(t, () => service.close());
  const options = {
    workspace: f.workspace,
    dataDir: join(f.dataDir, 'ports'),
    sessionId: 'trusted-session',
    getTaskService: () => service,
    identity,
    withResource: async <T>(
      _resource: 'build' | 'ui' | 'browser',
      run: () => Promise<T>,
    ) => run(),
    verify: async () => [],
  };
  const ports = createWorkspaceCyclePorts(options),
    cycle: CycleRecord = {
      id: 'baseline-cas',
      workspace: f.workspace,
      title: 'Do not merge stale patches',
      body: 'Baseline changes need review',
      acceptanceCriteria: [criterion],
      state: 'working',
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
  for (
    let i = 0;
    i < 200 && (await ports.tasks.status(cycle, ids)) === 'pending';
    i++
  )
    await delay(15);
  assert.equal(await ports.tasks.status(cycle, ids), 'passed');
  const worktrees = await git(f.workspace, 'worktree', 'list', '--porcelain');
  const ownedPath = worktrees
    .split('\n\n')
    .find((entry) => entry.includes('branch refs/heads/codex/cycle-'))!
    .split('\n')[0]!
    .slice(9);
  await writeFile(
    join(ownedPath, 'README.md'),
    'manual edit in the integration only\n',
  );
  const current = await ports.git.snapshot(cycle);
  await assert.rejects(
    ports.git.commit(
      cycle,
      {
        revision: 'stale',
        paths: ['README.md'],
        message: 'Preserve manual change',
      },
      { operationId: 'stale' },
    ),
    /changed/,
  );
  await assert.rejects(
    ports.git.commit(
      cycle,
      { revision: current.revision, paths: ['app.cjs'], message: 'Wrong path' },
      { operationId: 'wrong' },
    ),
    /verified changed path/,
  );
  const committed = await ports.git.commit(
    cycle,
    {
      revision: current.revision,
      paths: ['README.md'],
      message: 'Preserve manual change',
    },
    { operationId: 'manual-commit' },
  );
  assert.notEqual(committed.head, f.baseline);
  assert.equal(
    await git(ownedPath, 'show', '-s', '--format=%an <%ae>'),
    'Fixture <fixture@example.invalid>',
  );
  assert.match(
    await git(ownedPath, 'show', '-s', '--format=%B'),
    /Signed-off-by: Fixture <fixture@example.invalid>/,
  );
  assert.deepEqual(
    await ports.tasks.merge(cycle, ids, { operationId: 'stale-merge' }),
    { status: 'needs_review' },
  );
  assert.equal(
    await readFile(join(ownedPath, 'app.cjs'), 'utf8'),
    "exports.greeting='missing';exports.readyForCI=false;\n",
  );
  // A second trusted owner can use the same cycle and operation IDs without sharing tasks/worktrees.
  const other = createWorkspaceCyclePorts({
    ...options,
    sessionId: 'second-trusted-session',
  });
  const otherIds = await other.tasks.create(
    cycle,
    { kind: 'implementation', prompt: 'Independent owner' },
    { operationId: 'create' },
  );
  assert.notDeepEqual(otherIds, ids);
  await assert.rejects(other.tasks.status(cycle, ids), /owned candidate/);
  assert.equal(
    await git(f.workspace, 'status', '--porcelain=v1'),
    f.originalStatus,
  );
  assert.deepEqual(
    await readFile(join(f.workspace, '.git', 'index')),
    f.originalIndex,
  );
});

test('trusted already-pushed publishing verifies the remote HEAD while renderer options cannot skip a push', async (t) => {
  const f = await fixture(t),
    owned = join(f.root, 'owned-delivery');
  await git(f.workspace, 'worktree', 'add', '--detach', owned, f.baseline);
  await git(owned, 'switch', '-c', 'codex/trusted-published-head');
  const delivery = fixtureDelivery(owned, f.ghPath);
  const run = delivery.git.git.bind(delivery.git);
  let pushes = 0;
  delivery.git.git = async (args, input) => {
    if (args[0] === 'push') pushes++;
    return run(args, input);
  };
  const input = async () => {
    const s = await delivery.git.snapshot();
    return {
      revision: s.revision,
      head: s.head,
      title: 'Actual candidate',
      body: 'Publish only the already-pushed candidate',
    };
  };
  await assert.rejects(
    delivery.publishPushed(await input()),
    /remote branch no longer contains/,
  );
  assert.equal(pushes, 0);
  assert.equal(JSON.parse(await readFile(f.ghState, 'utf8')).created, 0);
  await assert.rejects(
    delivery.call('publishPushed', await input()),
    /unknown delivery method/,
  );
  await delivery.git.call('push', { revision: (await input()).revision });
  assert.equal(pushes, 1);
  await delivery.publishPushed(await input());
  assert.equal(pushes, 1, 'trusted publication must not push again');
  await delivery.call('publish', { ...(await input()), skipPush: true });
  assert.equal(pushes, 2, 'renderer-supplied skipPush must have no effect');
  await writeFile(join(owned, 'README.md'), 'uncommitted owned edit\n');
  await assert.rejects(
    delivery.publishPushed(await input()),
    /preserve workspace changes/,
  );
  await assert.rejects(
    delivery.publishPushed({ ...(await input()), revision: 'stale' }),
    /changed/,
  );
  await git(owned, 'add', 'README.md');
  await git(
    owned,
    '-c',
    `user.name=${identity.name}`,
    '-c',
    `user.email=${identity.email}`,
    'commit',
    '-m',
    'Change owned candidate',
  );
  await assert.rejects(
    delivery.publishPushed(await input()),
    /remote branch no longer contains/,
  );
  await delivery.git.call('push', { revision: (await input()).revision });
  await delivery.publishPushed(await input());
  assert.equal(pushes, 3);
  // A stale remote-tracking ref cannot stand in for the server's advertised HEAD.
  await git(
    f.remote,
    'update-ref',
    'refs/heads/codex/trusted-published-head',
    f.baseline,
  );
  await assert.rejects(
    delivery.publishPushed(await input()),
    /remote branch no longer contains/,
  );
  await git(
    f.remote,
    'update-ref',
    'refs/heads/codex/trusted-published-head',
    (await input()).head,
  );
  const state = JSON.parse(await readFile(f.ghState, 'utf8'));
  state.pr.state = 'CLOSED';
  state.listFailure = true;
  await writeFile(f.ghState, JSON.stringify(state));
  await assert.rejects(delivery.publishPushed(await input()), /Command failed/);
  assert.equal(
    JSON.parse(await readFile(f.ghState, 'utf8')).created,
    1,
    'failed reconciliation must not create another PR',
  );
  state.listFailure = false;
  await writeFile(f.ghState, JSON.stringify(state));
  await delivery.publishPushed(await input());
  assert.equal(
    JSON.parse(await readFile(f.ghState, 'utf8')).created,
    2,
    'completed PR must allow a new open draft',
  );
  assert.equal(pushes, 3);
  assert.equal(
    await git(f.workspace, 'status', '--porcelain=v1'),
    f.originalStatus,
  );
  assert.deepEqual(
    await readFile(join(f.workspace, '.git', 'index')),
    f.originalIndex,
  );
});

test('requesting review rechecks the candidate after CI and restores draft if the final ready mutation races a push', async (t) => {
  const f = await fixture(t),
    owned = join(f.root, 'ready-owned');
  await git(f.workspace, 'worktree', 'add', '--detach', owned, f.baseline);
  await git(owned, 'switch', '-c', 'codex/ready-race');
  await git(owned, 'push', '--set-upstream', 'origin', 'codex/ready-race');
  const delivery = fixtureDelivery(owned, f.ghPath);
  const initial = {
    created: 1,
    ready: 0,
    logs: 0,
    retries: 0,
    calls: [],
    holdCI: false,
    forcePass: true,
    pr: {
      number: 7,
      url: 'https://github.invalid/fixture/repo/pull/7',
      isDraft: true,
    },
  };
  for (const changeDuringChecks of ['head', 'branch', 'number', 'local']) {
    await writeFile(
      f.ghState,
      JSON.stringify({ ...initial, changeDuringChecks }),
    );
    const snapshot = await delivery.git.snapshot();
    await assert.rejects(
      delivery.call('ready', { revision: snapshot.revision }),
      /changed while reading checks/,
    );
    const state = JSON.parse(await readFile(f.ghState, 'utf8'));
    assert.equal(
      state.ready,
      0,
      changeDuringChecks + ' must not mark an unchecked candidate ready',
    );
    assert.equal(state.pr.isDraft, true);
    if (changeDuringChecks === 'local')
      await writeFile(join(owned, 'README.md'), 'baseline README\n');
  }
  assert.equal(
    (await delivery.git.snapshot()).entries.length,
    0,
    'restoring the fixture bytes must leave a clean candidate',
  );
  await writeFile(
    f.ghState,
    JSON.stringify({ ...initial, changeDuringReady: true }),
  );
  await assert.rejects(
    delivery.call('ready', {
      revision: (await delivery.git.snapshot()).revision,
    }),
    /draft status restored/,
  );
  let state = JSON.parse(await readFile(f.ghState, 'utf8'));
  assert.equal(state.ready, 1);
  assert.equal(state.undos, 1);
  assert.equal(state.pr.isDraft, true);
  assert.deepEqual(
    state.calls.filter(
      (args: string[]) => args[0] === 'pr' && args[1] === 'ready',
    ),
    [
      ['pr', 'ready', '7'],
      ['pr', 'ready', '7', '--undo'],
    ],
  );
  await writeFile(f.ghState, JSON.stringify(initial));
  await delivery.call('ready', {
    revision: (await delivery.git.snapshot()).revision,
  });
  state = JSON.parse(await readFile(f.ghState, 'utf8'));
  assert.equal(state.ready, 1);
  assert.equal(state.pr.isDraft, false);
  await delivery.call('ready', {
    revision: (await delivery.git.snapshot()).revision,
  });
  state = JSON.parse(await readFile(f.ghState, 'utf8'));
  assert.equal(
    state.ready,
    1,
    'an already-ready verified candidate is idempotent',
  );
});

test('cycle verification rejects empty evidence and contradictory command success claims', async (t) => {
  const f = await fixture(t),
    service = new TaskService({
      workspace: f.workspace,
      dataDir: join(f.dataDir, 'tasks'),
      identity,
      autoStart: false,
      emit: () => {},
      createRuntime: () => {
        throw Error('must not run');
      },
    });
  cleanup(t, () => service.close());
  const base = {
    workspace: f.workspace,
    dataDir: join(f.dataDir, 'ports'),
    sessionId: 'trusted-session',
    getTaskService: () => service,
    identity,
    withResource: async <T>(
      _resource: 'build' | 'ui' | 'browser',
      run: () => Promise<T>,
    ) => run(),
  };
  const cycle: CycleRecord = {
    id: 'contradictory-evidence',
    workspace: f.workspace,
    title: 'Require real evidence',
    body: 'Do not trust status alone',
    acceptanceCriteria: [criterion],
    state: 'working',
    attempt: 0,
    taskIds: [],
    failureCounts: {},
    updatedAt: new Date().toISOString(),
  };
  await createWorkspaceCyclePorts({
    ...base,
    verify: async () => [],
  }).tasks.create(
    cycle,
    { kind: 'implementation', prompt: 'Implement' },
    { operationId: 'create' },
  );
  for (const check of [
    {
      criterion,
      status: 'passed' as const,
      source: 'inspection' as const,
      evidence: '   ',
    },
    {
      criterion,
      status: 'passed' as const,
      source: 'command' as const,
      evidence: 'actual command failed',
      command: 'node oracle.cjs',
      exitCode: 1,
    },
    {
      criterion,
      status: 'passed' as const,
      source: 'command' as const,
      evidence: 'command identity was not recorded',
      exitCode: 0,
    },
  ]) {
    const result = await createWorkspaceCyclePorts({
      ...base,
      verify: async () => [check],
    }).verify(cycle);
    assert.equal(result.passed, false);
    assert.equal(result.evidence[0].status, 'needs_review');
    assert.match(result.evidence[0].detail, /acceptance requires/);
  }
});

test('requesting review treats legitimate skipping as neutral while requiring a real passing check', async (t) => {
  const f = await fixture(t),
    owned = join(f.root, 'neutral-owned');
  await git(f.workspace, 'worktree', 'add', '--detach', owned, f.baseline);
  await git(owned, 'switch', '-c', 'codex/neutral-checks');
  await git(owned, 'push', '--set-upstream', 'origin', 'codex/neutral-checks');
  const delivery = fixtureDelivery(owned, f.ghPath);
  for (const buckets of [
    ['pass', 'skipping'],
    ['skipping'],
    [],
    ['pass', 'pending'],
    ['pass', 'fail'],
    ['pass', 'cancel'],
    ['pass', 'new-unknown-state'],
  ]) {
    await writeFile(
      f.ghState,
      JSON.stringify({
        created: 1,
        ready: 0,
        logs: 0,
        retries: 0,
        calls: [],
        holdCI: false,
        checks: buckets.map((bucket, index) => ({
          bucket,
          name: 'check ' + index,
        })),
        pr: {
          number: 7,
          url: 'https://github.invalid/fixture/repo/pull/7',
          isDraft: true,
        },
      }),
    );
    const request = delivery.call('ready', {
      revision: (await delivery.git.snapshot()).revision,
    });
    if (buckets[0] === 'pass' && buckets[1] === 'skipping') await request;
    else await assert.rejects(request, /CI needs a passing check/);
    const state = JSON.parse(await readFile(f.ghState, 'utf8'));
    assert.equal(
      state.ready,
      buckets[0] === 'pass' && buckets[1] === 'skipping' ? 1 : 0,
      JSON.stringify(buckets),
    );
  }
});

test('the Windows fake-gh route runs a real Node subprocess and preserves literal PR arguments', async (t) => {
  const f = await fixture(t),
    owned = join(f.root, 'portable-gh-owned');
  await git(f.workspace, 'worktree', 'add', '--detach', owned, f.baseline);
  await git(owned, 'switch', '-c', 'codex/windows-gh-fixture');
  const delivery = fixtureDelivery(owned, f.ghPath, 'win32');
  const state = (await delivery.call('status')) as {
    authenticated: boolean;
    version: string;
  };
  assert.equal(state.authenticated, true);
  assert.match(state.version, /gh version 2\.83\.2/);
  const title = 'Literal "title" $() and spaces',
    body = 'first line\nsecond line with spaces and quotes \'"';
  await delivery.call('publish', {
    revision: (await delivery.git.snapshot()).revision,
    title,
    body,
  });
  const record = JSON.parse(await readFile(f.ghState, 'utf8'));
  assert.equal(record.created, 1);
  const create = record.calls.find(
    (args: string[]) => args[0] === 'pr' && args[1] === 'create',
  );
  assert.ok(create);
  assert.equal(create[create.indexOf('--title') + 1], title);
  assert.equal(create[create.indexOf('--body') + 1], body);
  assert.equal(
    await git(f.workspace, 'status', '--porcelain=v1'),
    f.originalStatus,
  );
  assert.deepEqual(
    await readFile(join(f.workspace, '.git', 'index')),
    f.originalIndex,
  );
});
