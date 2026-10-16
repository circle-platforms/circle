import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as legacy from '../src/legacy_install.js';
import { WindowsProcessQueryObservation } from '../src/windows_process_query.js';
import { scratch } from './helpers.js';

function fixture(t: TestContext) {
  const base = scratch(t, 'circle-query-evidence-');
  const version = join(base, 'versions', '0.5.0');
  const frozen = join(version, 'circle', 'circle.exe');
  mkdirSync(dirname(frozen), { recursive: true });
  writeFileSync(frozen, 'synthetic executable; never started');
  const copies: legacy.PythonCopy[] = [
    {
      kind: 'installer',
      prefix: base,
      versions: [version],
      links: [],
      leftovers: [],
    },
  ];
  const where: legacy.Surroundings = {
    platform: 'win32',
    home: join(base, 'home'),
    path: '',
  };
  return { base, frozen, copies, where };
}
type Result = Parameters<typeof legacy.runningCopies>[2] extends infer R
  ? R extends (...args: never[]) => infer T
    ? T
    : never
  : never;
function failed(t: TestContext, result: Result) {
  const own = fixture(t);
  let calls = 0;
  const reports: string[] = [];
  let failure: unknown;
  try {
    legacy.runningCopies(
      own.copies,
      own.where,
      (_command, _args, timeout) => {
        calls++;
        assert.equal(timeout, 30_000);
        return result;
      },
      (path) => (path === own.frozen ? 'EBUSY' : undefined),
      (summary) => reports.push(summary),
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.equal(calls, 1);
  assert.ok(failure.cause instanceof WindowsProcessQueryObservation);
  assert.deepEqual(reports, [failure.cause.message]);
  return {
    ...own,
    error: failure,
    observation: failure.cause,
    evidence: failure.cause.details,
  };
}

test('a timed out process query retains a bounded safe summary without machine paths or inferred phases', (t) => {
  const unrelated = 'C:\\unrelated-private-process\\program.exe';
  const stdout = `7 ${Buffer.from(unrelated).toString('base64')}\r\nnot a process\r\n`;
  const stderr = 'synthetic query diagnostic\r\n';
  const { frozen, error, observation, evidence } = failed(t, {
    status: null,
    pid: 444,
    signal: 'SIGTERM',
    stdout,
    stderr,
    error: Object.assign(Error('synthetic query timed out'), {
      code: 'ETIMEDOUT',
    }),
  });
  assert.equal(
    error.message,
    `${frozen} is in use, and the running programs could not be listed (no answer in 30 s)`,
  );
  assert.equal(evidence.reportedPid, 444);
  assert.equal(evidence.status, null);
  assert.equal(evidence.signal, 'SIGTERM');
  assert.equal(evidence.errorCode, 'ETIMEDOUT');
  assert.equal(evidence.stdoutCodeUnits, stdout.length);
  assert.equal(evidence.stderrCodeUnits, stderr.length);
  assert.equal(evidence.stdoutLineCount, 2);
  assert.equal(evidence.stderrLineCount, 1);
  assert.ok(evidence.elapsedMs >= 0);
  assert.equal('scriptEnteredObserved' in evidence, false);
  assert.equal('pipelineCompletedObserved' in evidence, false);
  assert.match(
    observation.message,
    new RegExp(
      `signal: SIGTERM; reported pid: 444; stdout: ${stdout.length} code units in 2 lines; stderr: ${stderr.length} code units in 1 lines`,
    ),
  );
  for (const summary of [observation.message, JSON.stringify(evidence)]) {
    assert.equal(summary.includes(unrelated), false);
    assert.equal(
      summary.includes(Buffer.from(unrelated).toString('base64')),
      false,
    );
    assert.equal(summary.includes('synthetic query diagnostic'), false);
    assert.equal(summary.includes(frozen), false);
  }
  assert.equal('stdout' in evidence, false);
  assert.equal('stderr' in evidence, false);
});

test('query evidence preserves the original nonzero exit error and its CRLF text', (t) => {
  const reason = 'Get-CimInstance : Access denied\r\nOriginal error detail';
  const stderr = reason + '\r\n';
  const { frozen, error, evidence } = failed(t, {
    status: 1,
    pid: 123,
    signal: null,
    stdout: '',
    stderr,
    error: undefined,
  });
  assert.equal(
    error.message,
    `${frozen} is in use, and the running programs could not be listed (${reason})`,
  );
  assert.equal(evidence.status, 1);
  assert.equal(evidence.signal, null);
  assert.equal(evidence.stdoutCodeUnits, 0);
  assert.equal(evidence.stdoutLineCount, 0);
  assert.equal(evidence.stderrCodeUnits, stderr.length);
  assert.equal(evidence.stderrLineCount, 2);
});

test('omitted runner fields remain unknown rather than inferred', (t) => {
  const { frozen, error, observation, evidence } = failed(t, {
    status: null,
    stdout: undefined as unknown as string,
    stderr: undefined as unknown as string,
    error: Object.assign(Error('synthetic query could not start'), {
      code: 'ENOENT',
    }),
  });
  assert.equal(
    error.message,
    `${frozen} is in use, and the running programs could not be listed (synthetic query could not start)`,
  );
  assert.equal(evidence.reportedPid, 'unknown');
  assert.equal(evidence.signal, 'unknown');
  assert.equal(evidence.errorCode, 'ENOENT');
  assert.equal(evidence.stdoutCodeUnits, 'unknown');
  assert.equal(evidence.stderrLineCount, 'unknown');
  assert.match(
    observation.message,
    /signal: unknown; reported pid: unknown; stdout: unknown code units in unknown lines/,
  );
});

test('a zero reported PID remains a reported value while unexpected codes and signals stay unknown', (t) => {
  const { evidence, observation } = failed(t, {
    status: null,
    pid: 0,
    signal: 'private\nsignal' as NodeJS.Signals,
    stdout: '',
    stderr: '',
    error: Object.assign(Error('synthetic query failed'), {
      code: 'E'.repeat(100),
    }),
  });
  assert.equal(evidence.reportedPid, 0);
  assert.equal('childStarted' in evidence, false);
  assert.equal(evidence.errorCode, 'unknown');
  assert.equal(evidence.signal, 'unknown');
  assert.doesNotMatch(observation.message, /private|EEEE/);
});

test('process query evidence preserves the single call, budget and PID decision', (t) => {
  const own = fixture(t);
  const matchingPid = process.pid + 1;
  const calls: { command: string; args: string[]; timeout?: number }[] = [];
  const pids = legacy.runningCopies(
    own.copies,
    own.where,
    (command, args, timeout) => {
      calls.push({ command, args, timeout });
      return {
        status: 0,
        stdout: `${matchingPid} ${Buffer.from(own.frozen).toString('base64')}\r\n`,
        stderr: '',
        error: undefined,
      };
    },
    (path) => (path === own.frozen ? 'EBUSY' : undefined),
  );
  assert.deepEqual(pids, [matchingPid]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, process.execPath);
  assert.match(calls[0]!.args[0]!, /windows_process_native\.[jt]s$/);
  assert.equal(calls[0]!.timeout, 30_000);
});

test('the installer consumer discloses only its safe query evidence and exits before any installation action', (t) => {
  const own = fixture(t);
  const record = join(own.base, 'actions.json');
  const hook = join(own.base, 'hooks.mjs');
  const realLegacy = new URL('../src/legacy_install.ts', import.meta.url).href;
  const legacyModule = `
    import * as actual from ${JSON.stringify(realLegacy)};
    const deny=(name)=>{globalThis.queryFixtureActions.push(name);throw Error('installation action must not run');};
    export const surroundings=()=>({platform:'win32',home:process.env.CIRCLE_HOME,path:''});
    export const findPythonCopies=()=>${JSON.stringify(own.copies)};
    export const chooseLocation=()=>deny('chooseLocation');
    export const removePythonCopies=()=>deny('removePythonCopies');
    export const runningCopies=(copies,where)=>actual.runningCopies(copies,where,()=>({
      status:null,pid:4321,signal:'SIGTERM',stdout:'',stderr:'',
      error:Object.assign(Error('synthetic query timeout'),{code:'ETIMEDOUT'}),
    }),path=>path===${JSON.stringify(own.frozen)}?'EBUSY':undefined);
  `;
  const layoutModule = `
    const deny=name=>{globalThis.queryFixtureActions.push(name);throw Error('installation action must not run');};
    export const DEFAULT_REPO='fixture/circle';
    export const validRepo=()=>true;
    export const stageRelease=()=>deny('stageRelease');
    export const activeVersion=()=>deny('activeVersion');
    export const pointToRelease=()=>deny('pointToRelease');
    export const pruneVersions=()=>deny('pruneVersions');
  `;
  writeFileSync(
    hook,
    `
    import {registerHooks} from 'node:module';
    import {writeFileSync} from 'node:fs';
    globalThis.queryFixtureActions=[];
    process.once('exit',()=>writeFileSync(${JSON.stringify(record)},JSON.stringify(globalThis.queryFixtureActions)));
    registerHooks({resolve(specifier,context,nextResolve){
      const source=specifier==='./legacy_install.js'?${JSON.stringify(legacyModule)}:specifier==='./install_layout.js'?${JSON.stringify(layoutModule)}:undefined;
      if(source!==undefined)return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
      return nextResolve(specifier,context);
    }});
  `,
  );
  const home = join(own.base, 'home');
  mkdirSync(home);
  const bin = join(own.base, 'empty-path');
  mkdirSync(bin);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      pathToFileURL(hook).href,
      fileURLToPath(new URL('../src/install_manager.ts', import.meta.url)),
      join(own.base, 'synthetic-release-never-staged'),
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CIRCLE_HOME: home,
        PATH: bin,
        Path: bin,
      },
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), []);
  assert.match(result.stderr, /Nothing was changed/);
  const prefix = '[circle-install] Windows process query observation: ';
  const lines = result.stderr.split(/\r?\n/);
  const line = lines.find((line) => line.startsWith(prefix));
  assert.ok(line, result.stderr);
  assert.ok(
    lines.indexOf(line) <
      lines.findIndex((line) => /Nothing was changed/.test(line)),
    result.stderr,
  );
  assert.match(
    line,
    /; error code: ETIMEDOUT; signal: SIGTERM; reported pid: 4321;/,
  );
  assert.match(line, /stdout: 0 code units in 0 lines; stderr: 0 code units/);
  assert.equal(line.includes(own.frozen), false);
});
