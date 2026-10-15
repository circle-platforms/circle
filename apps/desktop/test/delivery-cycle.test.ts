import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  DeliveryCycleService,
  type CyclePorts,
  type CycleRecord,
} from '../src/workspace/delivery-cycle.ts';
const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'circle-delivery-cycle-'));

  const workspace = join(root, 'project'),
    dataDir = join(root, 'data'),
    origin = join(root, 'origin.git');
  await mkdir(workspace);
  await mkdir(dataDir);
  const git = async (...args: string[]) =>
    (await exec('git', ['-C', workspace, ...args])).stdout.trim();
  await exec('git', ['init', '--bare', origin]);
  await git('init', '--initial-branch=main');
  await writeFile(join(workspace, 'app.txt'), 'baseline\n');
  await git('add', 'app.txt');
  const commit = () =>
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Update fixture',
    );
  await commit();
  await git('checkout', '-b', 'codex/delivery-fixture');
  await git('remote', 'add', 'origin', origin);
  const fake = join(root, 'fake-gh.cjs'),
    fakeState = join(root, 'fake-gh-state.json');
  await writeFile(
    fakeState,
    JSON.stringify({ ci: 'fail', pr: false, draft: true, calls: [] }),
  );
  await writeFile(
    fake,
    `const fs=require('node:fs');const p=${JSON.stringify(fakeState)};const s=JSON.parse(fs.readFileSync(p));const a=process.argv.slice(2);s.calls.push(a);if(a[0]==='publish'){if(!s.pr)s.created=(s.created||0)+1;s.pr=true;console.log(JSON.stringify({url:'https://github.com/fixture/project/pull/1',number:1}));}else if(a[0]==='checks')console.log(JSON.stringify(s.ci==='empty'?[]:[{name:'fixture-ci',bucket:s.ci,runId:1}]));else if(a[0]==='logs')console.log('assertion failed: expected fixed output');else if(a[0]==='ready'){if(s.ci!=='pass')process.exit(2);s.draft=false;}else if(a[0]!=='retry')process.exit(3);fs.writeFileSync(p,JSON.stringify(s));`,
  );
  const gh = async (...args: string[]) =>
    (await exec(process.execPath, [fake, ...args])).stdout.trim();
  const effects = { commit: 0, push: 0, repair: 0, diagnosis: 0 };
  let alwaysFail = false,
    verified = true,
    stale = false;
  const ports: CyclePorts = {
    tasks: {
      async create(cycle, request) {
        if (request.kind === 'diagnosis') {
          effects.diagnosis++;
          return ['diagnosis'];
        }
        if (request.kind === 'repair') {
          effects.repair++;
          const state = JSON.parse(await readFile(fakeState, 'utf8'));
          state.ci = alwaysFail ? 'fail' : 'pass';
          await writeFile(fakeState, JSON.stringify(state));
        }
        await writeFile(
          join(workspace, 'app.txt'),
          `${request.kind} ${cycle.attempt}\n`,
        );
        return [`task-${cycle.attempt}`];
      },
      async status() {
        return 'passed';
      },
      async merge() {
        return { status: 'merged' };
      },
    },
    async verify(cycle) {
      const content = await readFile(join(workspace, 'app.txt'), 'utf8');
      return {
        passed: verified && content !== 'baseline\n',
        head: await git('rev-parse', 'HEAD'),
        paths: ['app.txt'],
        evidence: cycle.acceptanceCriteria.map((criterion) => ({
          criterion,
          status: 'passed',
          source: 'inspection',
          detail: `actual app.txt content: ${content}`,
        })),
      };
    },
    git: {
      async snapshot() {
        const head = await git('rev-parse', 'HEAD'),
          diff = await git('diff', '--binary'),
          status = await git('status', '--porcelain');
        return {
          head,
          branch: await git('branch', '--show-current'),
          dirty: Boolean(status),
          revision: createHash('sha256')
            .update(head + diff + status)
            .digest('hex'),
        };
      },
      async commit(_cycle, input) {
        effects.commit++;
        await git('add', '--', ...input.paths);
        await commit();
        return { head: await git('rev-parse', 'HEAD') };
      },
      async push() {
        effects.push++;
        await git('push', '--set-upstream', 'origin', 'codex/delivery-fixture');
      },
    },
    delivery: {
      async publish(_cycle, input) {
        return { ...JSON.parse(await gh('publish')), head: input.head };
      },
      async checks() {
        return {
          head: stale ? 'different-head' : await git('rev-parse', 'HEAD'),
          checks: JSON.parse(await gh('checks')),
        };
      },
      async logs() {
        return gh('logs');
      },
      async retry() {
        await gh('retry');
      },
      async ready() {
        await gh('ready');
      },
    },
  };
  const cycle = await DeliveryCycleService.open({ dataDir, ports });
  t.after(async () => {
    await cycle.close();
    await rm(root, { recursive: true, force: true });
  });
  const spec = {
    id: 'web',
    workspace,
    title: 'Implement fixture',
    body: 'Update app file',
    acceptanceCriteria: ['app file updated'],
  };
  return {
    cycle,
    spec,
    dataDir,
    ports,
    git,
    origin,
    effects,
    fakeState,
    setAlwaysFail: () => (alwaysFail = true),
    setUnverified: () => (verified = false),
    setStale: () => (stale = true),
  };
}

test('real Git and stateful fakegh drive failed CI to repair, new push and human review without duplicate effects', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.cycle.create(f.spec, { operationId: '' }),
    /valid operation id/,
  );
  await f.cycle.create(f.spec, { operationId: 'create' });
  assert.equal((await f.cycle.advance('web')).state, 'repairing');
  const first = await f.git('rev-parse', 'HEAD');
  assert.equal((await f.cycle.advance('web')).state, 'pending_human_merge');
  const final = await f.git('rev-parse', 'HEAD');
  assert.notEqual(first, final);
  const remote = (
    await exec('git', [
      '--git-dir',
      f.origin,
      'rev-parse',
      'refs/heads/codex/delivery-fixture',
    ])
  ).stdout.trim();
  assert.equal(final, remote);
  assert.deepEqual(f.effects, { commit: 2, push: 2, repair: 1, diagnosis: 0 });
  await Promise.all([f.cycle.advance('web'), f.cycle.advance('web')]);
  assert.deepEqual(f.effects, { commit: 2, push: 2, repair: 1, diagnosis: 0 });
  const state = JSON.parse(await readFile(f.fakeState, 'utf8'));
  assert.equal(state.draft, false);
  assert.equal(state.created, 1);
  assert.equal(
    state.calls.filter((call: string[]) => call[0] === 'ready').length,
    1,
  );
  assert.ok(state.calls.every((call: string[]) => !call.includes('merge')));
});

test('third identical CI failure dispatches independent diagnosis and pauses only its cycle', async (t) => {
  const f = await fixture(t);
  f.setAlwaysFail();
  await f.cycle.create(f.spec, { operationId: 'create' });
  await f.cycle.advance('web');
  await f.cycle.advance('web');
  assert.equal((await f.cycle.advance('web')).state, 'needs_review');
  assert.equal(f.effects.repair, 2);
  assert.equal(f.effects.diagnosis, 1);
  await f.cycle.advance('web');
  assert.equal(f.effects.diagnosis, 1);
  const other = { ...f.spec, id: 'unrelated' };
  await f.cycle.create(other, { operationId: 'other' });
  assert.equal(f.cycle.snapshot('unrelated').state, 'queued');
});

test('independent acceptance is mandatory and stale CI cannot request review', async (t) => {
  const f = await fixture(t);
  f.setUnverified();
  await f.cycle.create(f.spec, { operationId: 'create' });
  assert.equal((await f.cycle.advance('web')).state, 'needs_review');
  assert.equal(f.effects.commit, 0);
  assert.equal(f.effects.push, 0);
  const g = await fixture(t);
  g.setStale();
  await g.cycle.create(g.spec, { operationId: 'g' });
  assert.equal((await g.cycle.advance('web')).state, 'needs_review');
  const state = JSON.parse(await readFile(g.fakeState, 'utf8'));
  assert.ok(state.calls.every((call: string[]) => call[0] !== 'ready'));
});

test('empty CI never becomes ready and explicit retries are idempotent', async (t) => {
  const f = await fixture(t);
  const state = JSON.parse(await readFile(f.fakeState, 'utf8'));
  state.ci = 'empty';
  await writeFile(f.fakeState, JSON.stringify(state));
  await f.cycle.create(f.spec, { operationId: 'create' });
  assert.equal((await f.cycle.advance('web')).state, 'waiting_ci');
  await Promise.all([
    f.cycle.retryCI('web', 1, { operationId: 'retry' }),
    f.cycle.retryCI('web', 1, { operationId: 'retry' }),
  ]);
  const result = JSON.parse(await readFile(f.fakeState, 'utf8'));
  assert.equal(
    result.calls.filter((call: string[]) => call[0] === 'retry').length,
    1,
  );
  assert.equal(result.draft, true);
});

test('restart marks unfinished side effects unknown and does not replay commit push or PR', async (t) => {
  const f = await fixture(t);
  await f.cycle.create(f.spec, { operationId: 'create' });
  await f.cycle.close();
  const file = join(f.dataDir, 'delivery-cycles.json');
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  ledger.operations.push({
    id: 'web:push:0',
    cycleId: 'web',
    kind: 'push',
    state: 'running',
    inputHash: 'unknown',
  });
  await writeFile(file, JSON.stringify(ledger));
  const recovered = await DeliveryCycleService.open({
    dataDir: f.dataDir,
    ports: f.ports,
  });
  assert.equal(recovered.snapshot('web').state, 'needs_review');
  await recovered.advance('web');
  assert.deepEqual(f.effects, { commit: 0, push: 0, repair: 0, diagnosis: 0 });
  await assert.rejects(
    DeliveryCycleService.open({ dataDir: f.dataDir, ports: f.ports }),
    /already has an owner/,
  );
  await recovered.close();
});
