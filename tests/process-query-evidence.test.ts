import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runningFrom } from '../src/install_processes.js';
import { WindowsProcessQueryObservation } from '../src/windows_process_query.js';
import { scratch } from './helpers.js';

// An installed version on Windows whose runtime the test says is held.
function fixture(t: TestContext) {
  const base = scratch(t, 'circle-query-evidence-');
  const version = join(base, 'versions', '1.0.0');
  const node = join(version, 'runtime', 'node.exe');
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, 'synthetic executable; never started');
  return { base, node, folders: [version] };
}
type Result = Parameters<typeof runningFrom>[2] extends infer R
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
    runningFrom(
      own.folders,
      'win32',
      (_command, _args, timeout) => {
        calls++;
        assert.equal(timeout, 30_000);
        return result;
      },
      (path) => (path === own.node ? 'EBUSY' : undefined),
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
  const { node, error, observation, evidence } = failed(t, {
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
    `${node} is in use, and the running programs could not be listed (no answer in 30 s)`,
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
    assert.equal(summary.includes(node), false);
  }
  assert.equal('stdout' in evidence, false);
  assert.equal('stderr' in evidence, false);
});

test('query evidence preserves the original nonzero exit error and its CRLF text', (t) => {
  const reason = 'Get-CimInstance : Access denied\r\nOriginal error detail';
  const stderr = reason + '\r\n';
  const { node, error, evidence } = failed(t, {
    status: 1,
    pid: 123,
    signal: null,
    stdout: '',
    stderr,
    error: undefined,
  });
  assert.equal(
    error.message,
    `${node} is in use, and the running programs could not be listed (${reason})`,
  );
  assert.equal(evidence.status, 1);
  assert.equal(evidence.signal, null);
  assert.equal(evidence.stdoutCodeUnits, 0);
  assert.equal(evidence.stdoutLineCount, 0);
  assert.equal(evidence.stderrCodeUnits, stderr.length);
  assert.equal(evidence.stderrLineCount, 2);
});

test('omitted runner fields remain unknown rather than inferred', (t) => {
  const { node, error, observation, evidence } = failed(t, {
    status: null,
    stdout: undefined as unknown as string,
    stderr: undefined as unknown as string,
    error: Object.assign(Error('synthetic query could not start'), {
      code: 'ENOENT',
    }),
  });
  assert.equal(
    error.message,
    `${node} is in use, and the running programs could not be listed (synthetic query could not start)`,
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
  const pids = runningFrom(
    own.folders,
    'win32',
    (command, args, timeout) => {
      calls.push({ command, args, timeout });
      return {
        status: 0,
        stdout: `${matchingPid} ${Buffer.from(own.node).toString('base64')}\r\n`,
        stderr: '',
        error: undefined,
      };
    },
    (path) => (path === own.node ? 'EBUSY' : undefined),
  );
  assert.deepEqual(pids, [matchingPid]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, process.execPath);
  assert.match(calls[0]!.args[0]!, /windows_process_native\.[jt]s$/);
  assert.equal(calls[0]!.timeout, 30_000);
});
