import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scratch } from '../../../tests/helpers.js';
import { DeliveryService } from '../src/workspace/delivery.ts';
const exec = promisify(execFile);
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
/** A real repository with a local remote, a human's unsaved and staged edits, and a stateful fake gh. */
async function repository(t: TestContext) {
  const root = await realpath(scratch(t, 'circle-delivery-repository-'));
  const workspace = path.join(root, 'source'),
    remote = path.join(root, 'remote.git');
  await mkdir(workspace);
  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(workspace, 'init', '--initial-branch=main');
  await git(workspace, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(workspace, 'README.md'), 'baseline README\n');
  await writeFile(path.join(workspace, 'staged.txt'), 'baseline staged file\n');
  await git(workspace, 'add', 'README.md', 'staged.txt');
  await git(
    workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Create fixture',
  );
  await git(workspace, 'remote', 'add', 'origin', remote);
  await git(workspace, 'push', '--set-upstream', 'origin', 'main');
  const baseline = await git(workspace, 'rev-parse', 'HEAD');
  await writeFile(
    path.join(workspace, 'README.md'),
    'human unsaved disk edit\n',
  );
  await writeFile(path.join(workspace, 'staged.txt'), 'human staged content\n');
  await git(workspace, 'add', 'staged.txt');
  await writeFile(
    path.join(workspace, 'staged.txt'),
    'human additional working content\n',
  );
  const originalStatus = await git(workspace, 'status', '--porcelain=v1');
  const originalIndex = await readFile(path.join(workspace, '.git', 'index'));
  const ghState = path.join(root, 'fake-gh-state.json'),
    ghPath = path.join(root, 'fake-gh');
  await writeFile(
    ghState,
    JSON.stringify({ created: 0, ready: 0, pr: null, calls: [] }),
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
 out=s.checks??[{name:'remote acceptance',state:'SUCCESS',bucket:'pass',link:'https://github.invalid/fixture/repo/actions/runs/42/job/3'}];
}
else if(a[0]==='pr'&&a[1]==='ready'){pr();if(a.includes('--undo')){s.undos=(s.undos??0)+1;s.pr.isDraft=true;out='draft'}else{s.ready++;s.pr.isDraft=false;if(s.changeDuringReady)s.overrideHead='unverified-head-during-ready';out='ready'}}
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
    baseline,
    originalStatus,
    originalIndex,
    ghState,
    ghPath,
  };
}

test('local gh adapter reports checks and refuses ready on failing CI', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-gh-'));
  try {
    const gh = path.join(root, 'fake-gh');
    const log = path.join(root, 'calls');
    await writeFile(
      gh,
      `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='--version') console.log('gh version 2.83.2');else if(a[0]==='auth')process.exit(0);else if(a[0]==='pr'&&a[1]==='checks')console.log(JSON.stringify([{name:'test',bucket:'fail',state:'FAILURE'}]));else if(a[0]==='pr'&&a[1]==='view')console.log(JSON.stringify({number:1,url:'https://example.invalid/pr/1',headRefOid:'wrong'}));else process.exit(3);`,
    );
    await chmod(gh, 0o755);
    const s = new DeliveryService(root, gh);
    if (process.platform === 'win32')
      s.gh = async (args) =>
        (
          await promisify(execFile)(process.execPath, [gh, ...args], {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, GH_PROMPT_DISABLED: '1' },
          })
        ).stdout;
    await s.git.git(['init']);
    const status = (await s.call('status')) as { authenticated: boolean };
    assert.equal(status.authenticated, true);
    assert.deepEqual(await s.call('checks'), [
      { name: 'test', bucket: 'fail', state: 'FAILURE' },
    ]);
    await assert.rejects(s.call('logs', { runId: '--help' }), /valid run/);
    await assert.rejects(
      s.call('ready', { revision: (await s.git.snapshot()).revision }),
      /head changed/,
    );
    assert.equal((await readFile(log, 'utf8')).includes('"ready"'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a pull request without any checks reads as no checks, while other failures still fail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-gh-no-checks-'));
  try {
    const gh = path.join(root, 'fake-gh');
    const rollup = path.join(root, 'rollup.json');
    await writeFile(
      gh,
      `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);if(a[0]==='pr'&&a[1]==='checks'){console.error("no checks reported on the 'codex/x' branch");process.exit(1)}else if(a[0]==='pr'&&a[1]==='view'&&a[3]==='statusCheckRollup')console.log(fs.readFileSync(${JSON.stringify(rollup)},'utf8'));else process.exit(3);`,
    );
    await chmod(gh, 0o755);
    const s = new DeliveryService(root, gh);
    if (process.platform === 'win32')
      s.gh = async (args) =>
        (
          await promisify(execFile)(process.execPath, [gh, ...args], {
            cwd: root,
            encoding: 'utf8',
          })
        ).stdout;
    await writeFile(rollup, JSON.stringify({ statusCheckRollup: [] }));
    assert.deepEqual(await s.call('checks'), []);
    await writeFile(
      rollup,
      JSON.stringify({ statusCheckRollup: [{ name: 'build' }] }),
    );
    await assert.rejects(s.call('checks'), /no checks reported|Command failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publishing reuses the open pull request, creates none when reconciliation fails, and opens a new draft after the old one closed', async (t) => {
  const f = await repository(t),
    owned = path.join(f.root, 'owned-delivery');
  await git(f.workspace, 'worktree', 'add', '--detach', owned, f.baseline);
  await git(owned, 'switch', '-c', 'codex/published-head');
  const delivery = fixtureDelivery(owned, f.ghPath);
  const run = delivery.git.git.bind(delivery.git);
  let pushes = 0;
  delivery.git.git = async (args, input) => {
    if (args[0] === 'push') pushes++;
    return run(args, input);
  };
  const input = async () => ({
    revision: (await delivery.git.snapshot()).revision,
    title: 'Actual candidate',
    body: 'Publish the reviewed candidate',
  });
  const created = async () =>
    JSON.parse(await readFile(f.ghState, 'utf8')).created as number;
  await delivery.call('publish', await input());
  assert.equal(pushes, 1);
  assert.equal(await created(), 1);
  await delivery.call('publish', { ...(await input()), title: '' });
  assert.equal(pushes, 2);
  assert.equal(
    await created(),
    1,
    'the open pull request for the branch is reused',
  );
  const state = JSON.parse(await readFile(f.ghState, 'utf8'));
  state.pr.state = 'CLOSED';
  state.listFailure = true;
  await writeFile(f.ghState, JSON.stringify(state));
  await assert.rejects(
    delivery.call('publish', await input()),
    /Command failed/,
  );
  assert.equal(
    await created(),
    1,
    'failed reconciliation must not create another PR',
  );
  assert.equal(pushes, 2, 'nothing is pushed before reconciliation');
  state.listFailure = false;
  await writeFile(f.ghState, JSON.stringify(state));
  await delivery.call('publish', await input());
  assert.equal(await created(), 2, 'completed PR must allow a new open draft');
  assert.equal(pushes, 3);
  assert.equal(
    await git(f.workspace, 'status', '--porcelain=v1'),
    f.originalStatus,
  );
  assert.deepEqual(
    await readFile(path.join(f.workspace, '.git', 'index')),
    f.originalIndex,
  );
});

test('requesting review rechecks the candidate after CI and restores draft if the final ready mutation races a push', async (t) => {
  const f = await repository(t),
    owned = path.join(f.root, 'ready-owned');
  await git(f.workspace, 'worktree', 'add', '--detach', owned, f.baseline);
  await git(owned, 'switch', '-c', 'codex/ready-race');
  await git(owned, 'push', '--set-upstream', 'origin', 'codex/ready-race');
  const delivery = fixtureDelivery(owned, f.ghPath);
  const initial = {
    created: 1,
    ready: 0,
    calls: [],
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
      await writeFile(path.join(owned, 'README.md'), 'baseline README\n');
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

test('requesting review treats legitimate skipping as neutral while requiring a real passing check', async (t) => {
  const f = await repository(t),
    owned = path.join(f.root, 'neutral-owned');
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
        calls: [],
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
  const f = await repository(t),
    owned = path.join(f.root, 'portable-gh-owned');
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
    await readFile(path.join(f.workspace, '.git', 'index')),
    f.originalIndex,
  );
});
