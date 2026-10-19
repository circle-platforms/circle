import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { cleanup, scratch } from '../../../tests/helpers.js';
import { DeliveryService } from '../src/workspace/delivery.js';
const runId = 42,
  head = 'a'.repeat(40),
  fullname = 'fixture/project';
const apiRoot = `https://api.github.invalid/repos/${fullname}/actions`;
function job(
  id: number,
  status = 'completed',
  conclusion: string | null = 'success',
) {
  return {
    id,
    run_id: runId,
    run_attempt: 1,
    head_sha: head,
    run_url: `${apiRoot}/runs/${runId}`,
    url: `${apiRoot}/jobs/${id}`,
    name: `job ${id}`,
    status,
    conclusion,
  };
}
async function fixture(
  t: TestContext,
  overrides: Record<string, unknown> = {},
) {
  const root = scratch(t, 'circle-delivery-job-logs-'),
    data = join(root, 'fixture');
  await mkdir(data);
  const statePath = join(data, 'state.json'),
    gh = join(data, 'fake-gh'),
    secret = 'fixture-auth-' + randomUUID();
  const value = {
    calls: [],
    runReads: 0,
    primarySuccess: false,
    run: {
      id: runId,
      run_attempt: 1,
      head_sha: head,
      status: 'in_progress',
      url: `${apiRoot}/runs/${runId}`,
      repository: { full_name: fullname },
    },
    jobs: [job(100, 'in_progress', null), job(101, 'completed', 'failure')],
    ...overrides,
  };
  await writeFile(statePath, JSON.stringify(value));
  await writeFile(
    gh,
    `#!${process.execPath}\n` +
      String.raw`
const fs=require('node:fs');const p=process.argv[1]+'.state';const s=JSON.parse(fs.readFileSync(fs.readFileSync(p,'utf8'),'utf8'));const a=process.argv.slice(2);s.calls.push(a);const save=()=>fs.writeFileSync(fs.readFileSync(p,'utf8'),JSON.stringify(s));
if(a[0]==='run'&&a[1]==='view'){save();if(s.primarySuccess){if(s.bigPrimary){let o='';for(const job of ['build','test'])o+=(job+'\tstep\tearly '+job+'\n'+(job+'\tstep\tnoise\n').repeat(20000)+job+'\tstep\tlast '+job+' '+process.env.GH_TOKEN+'\n');process.stdout.write(o,()=>process.exit(0));return}console.log('FULL_RUN_LOG '+process.env.GH_TOKEN);process.exit(0)}console.error('workflow is not completed '+process.env.GH_TOKEN);process.exit(1)}
if(a[0]==='repo'&&a[1]==='view'){save();console.log(JSON.stringify(s.repo??{nameWithOwner:'fixture/project',url:'https://github.invalid/fixture/project'}));process.exit(0)}
if(a[0]!=='api'||a[1]!=='--hostname'||a[2]!=='github.invalid')throw Error('untrusted API host');
const endpoint=a[3];let out;
if(endpoint==='repos/fixture/project/actions/runs/42'){s.runReads++;out={...s.run};if(s.changeRunAfterLogs&&s.runReads>1)out.run_attempt=2}
else if(endpoint.startsWith('repos/fixture/project/actions/runs/42/attempts/1/jobs?')){const page=Number(new URL('https://fixture.invalid/?'+endpoint.split('?')[1]).searchParams.get('page'));out={total_count:s.jobs.length,jobs:s.jobs.slice((page-1)*100,page*100)}}
else if(endpoint.match(/^repos\/fixture\/project\/actions\/jobs\/\d+\/logs$/)){const id=Number(endpoint.split('/').at(-2));out='ACTUAL_JOB_LOG '+id+' '+process.env.GH_TOKEN+' ghp_012345678901234567890123456789012345\n'+'noise\n'.repeat(s.jobNoise??0)+'assert expected repaired output '+id}
else if(endpoint.match(/^repos\/fixture\/project\/actions\/jobs\/\d+$/)){const id=Number(endpoint.split('/').at(-1));out=s.detail??s.jobs.find(job=>job.id===id)}
else throw Error('unexpected endpoint '+endpoint);
save();console.log(typeof out==='string'?out:JSON.stringify(out));
`,
    { mode: 0o700 },
  );
  await writeFile(gh + '.state', statePath);
  const service = new DeliveryService(root, gh, {
    spawn: () => {
      throw Error('login must not spawn');
    },
    credentialStore: {
      get: async () => secret,
      put: async () => {
        throw Error('must not save credentials');
      },
    },
  });
  if (process.platform === 'win32') {
    // Windows cannot execute a shebang fixture. Keep the same real child argv
    // and credential boundary through Node; packaged gh.exe is tested separately.
    service.gh = async (args) =>
      (
        await promisify(execFile)(process.execPath, [gh, ...args], {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, GH_TOKEN: await service.login?.token() },
        })
      ).stdout;
  }
  cleanup(t, () => service.dispose());
  const state = async () =>
    JSON.parse(await readFile(statePath, 'utf8')) as typeof value;
  const calls = async () => (await state()).calls as string[][];
  return { service, state, calls, secret };
}

test('an incomplete real gh process branch falls back to paginated completed failure logs with verified ownership and no credentials', async (t) => {
  const jobs = Array.from({ length: 100 }, (_, index) => job(1000 + index));
  jobs.push(
    job(1100, 'in_progress', null),
    job(1101, 'completed', 'failure'),
    job(1102, 'completed', 'timed_out'),
  );
  const f = await fixture(t, { jobs });
  const result = (await f.service.call('logs', {
    runId,
    repo: 'attacker/repo',
    url: 'https://attacker.invalid',
    jobId: 999,
  })) as { text: string; source: string; partial: boolean; jobIds: number[] };
  assert.equal(result.source, 'completed-jobs');
  assert.equal(result.partial, true);
  assert.deepEqual(result.jobIds, [1101, 1102]);
  assert.match(result.text, /ACTUAL_JOB_LOG 1101/);
  assert.match(result.text, /ACTUAL_JOB_LOG 1102/);
  assert.match(result.text, /other jobs are still running/);
  assert.equal(JSON.stringify(result).includes(f.secret), false);
  assert.equal(
    result.text.includes('ghp_012345678901234567890123456789012345'),
    false,
  );
  assert.match(result.text, /\[redacted\]/);
  const calls = await f.calls();
  assert.ok(calls.some((args) => args[3]?.includes('page=2')));
  assert.equal(calls.filter((args) => args[3]?.endsWith('/logs')).length, 2);
  assert.ok(calls.every((args) => !JSON.stringify(args).includes('attacker')));
  assert.ok(
    calls
      .filter((args) => args[0] === 'api')
      .every(
        (args) =>
          args[2] === 'github.invalid' &&
          args[3].startsWith('repos/fixture/project/actions/'),
      ),
  );
});

test('successful run logs retain the primary path while redacting the configured credential', async (t) => {
  const f = await fixture(t, { primarySuccess: true });
  const result = (await f.service.call('logs', { runId })) as { text: string };
  assert.match(result.text, /FULL_RUN_LOG \[redacted\]/);
  assert.equal(result.text.includes(f.secret), false);
  assert.equal((await f.calls()).length, 1);
});

test('fallback refuses cross-repository runs and cross-run or stale job records before downloading logs', async (t) => {
  for (const overrides of [
    {
      run: {
        id: 42,
        run_attempt: 1,
        head_sha: head,
        status: 'in_progress',
        url: `${apiRoot}/runs/42`,
        repository: { full_name: 'other/project' },
      },
    },
    { jobs: [{ ...job(101, 'completed', 'failure'), run_id: 99 }] },
    {
      jobs: [
        {
          ...job(101, 'completed', 'failure'),
          run_url:
            'https://api.github.invalid/repos/other/project/actions/runs/42',
        },
      ],
    },
    {
      jobs: [
        {
          ...job(101, 'completed', 'failure'),
          url: 'https://attacker.invalid/repos/fixture/project/actions/jobs/101',
        },
      ],
    },
    { jobs: [{ ...job(101, 'completed', 'failure'), run_attempt: 2 }] },
    {
      detail: { ...job(101, 'completed', 'failure'), head_sha: 'b'.repeat(40) },
    },
  ]) {
    const f = await fixture(t, overrides);
    await assert.rejects(f.service.call('logs', { runId }), /does not belong/);
    assert.equal(
      (await f.calls()).some((args) => args[3]?.endsWith('/logs')),
      false,
    );
  }
});

test('fallback never labels running jobs as completed logs and rejects reruns observed during download', async (t) => {
  const pending = await fixture(t, { jobs: [job(100, 'in_progress', null)] });
  await assert.rejects(
    pending.service.call('logs', { runId }),
    /no completed failed jobs/,
  );
  assert.equal(
    (await pending.calls()).some((args) => args[3]?.endsWith('/logs')),
    false,
  );
  const rerun = await fixture(t, { changeRunAfterLogs: true });
  await assert.rejects(
    rerun.service.call('logs', { runId }),
    /workflow run changed/,
  );
  assert.equal(
    (await rerun.calls()).filter((args) => args[3]?.endsWith('/logs')).length,
    1,
  );
});

test('failure logs keep the tail of each job and never the whole log', async (t) => {
  const primary = await fixture(t, { primarySuccess: true, bigPrimary: true });
  const shown = (await primary.service.call('logs', { runId })) as Record<
    string,
    unknown
  > & { text: string; truncated: boolean };
  assert.equal(shown.truncated, true);
  assert.equal('full' in shown, false);
  assert.ok(shown.text.length < 2 * 33 * 1024, String(shown.text.length));
  for (const job of ['build', 'test']) {
    assert.match(shown.text, new RegExp(`last ${job} \\[redacted\\]`));
    assert.doesNotMatch(shown.text, new RegExp(`early ${job}`));
  }
  assert.equal(shown.text.includes(primary.secret), false);

  const fallback = await fixture(t, { jobNoise: 20_000 });
  const jobs = (await fallback.service.call('logs', { runId })) as {
    text: string;
    truncated: boolean;
  };
  assert.equal(jobs.truncated, true);
  assert.ok(jobs.text.length < 40 * 1024, String(jobs.text.length));
  assert.match(jobs.text, /=== job 101 \(job 101, failure\) ===/);
  assert.match(jobs.text, /assert expected repaired output 101\s*$/);
  assert.doesNotMatch(jobs.text, /ACTUAL_JOB_LOG/);
  assert.equal('full' in jobs, false);
  assert.equal(jobs.text.includes(fallback.secret), false);
});
