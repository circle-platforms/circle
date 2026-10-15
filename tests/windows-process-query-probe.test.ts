import test from 'node:test';
import assert from 'node:assert/strict';
import type childProcess from 'node:child_process';
import {
  instrumentSpawnSync,
  type ProcessQueryProbeReport,
} from '../scripts/windows-process-query-probe.js';

const command =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const pipeline =
  'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ExecutablePath | ' +
  'Where-Object { $_.ExecutablePath } | ForEach-Object { "$($_.ProcessId) ' +
  '$([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.ExecutablePath)))" }';
const args = ['-NoProfile', '-NonInteractive', '-Command', pipeline];
const options = { encoding: 'utf8' as const, timeout: 30_000 };

function markers(script: string) {
  const matches = [
    ...script.matchAll(/WriteLine\('(CIRCLE_QUERY_PROBE_[^']+)'\)/g),
  ];
  assert.equal(matches.length, 2);
  const metric =
    /WriteLine\('(CIRCLE_QUERY_PROBE_[^']+_PIPELINE_MS) ' \+ /.exec(script);
  assert.ok(metric);
  return {
    entered: matches[0]![1]!,
    completed: matches[1]![1]!,
    metric: metric[1]!,
  };
}
function result(stderr = '') {
  return {
    pid: 12345,
    output: [null, '7 synthetic-base64\r\n', stderr],
    stdout: '7 synthetic-base64\r\n',
    stderr,
    status: 0,
    signal: null,
  };
}
function runner(
  run: (...parameters: unknown[]) => unknown,
): typeof childProcess.spawnSync {
  return run as typeof childProcess.spawnSync;
}

test('the opt-in probe preserves one query call, its original pipeline and its deadline', () => {
  let calls = 0;
  const reports: ProcessQueryProbeReport[] = [];
  const originalArgs = [...args];
  const run = instrumentSpawnSync(
    runner((actualCommand, actualArgs, actualOptions) => {
      calls++;
      assert.equal(actualCommand, command);
      assert.equal(actualOptions, options);
      assert.notEqual(actualArgs, args);
      const actual = actualArgs as string[];
      assert.deepEqual(actual.slice(0, 3), args.slice(0, 3));
      const script = actual[3]!;
      const { entered, completed, metric } = markers(script);
      assert.equal(script.split(pipeline).length, 2);
      assert.match(script, /\n\$circleQueryProbeSuccess_[a-z0-9_]+ = \$\?;\n/);
      assert.ok(script.indexOf(entered) < script.indexOf(pipeline));
      const saved = script.indexOf(' = $?;');
      assert.ok(saved > script.indexOf(pipeline));
      assert.ok(saved < script.indexOf(completed));
      assert.ok(
        script.indexOf('[Diagnostics.Stopwatch]::StartNew()') <
          script.indexOf(pipeline),
      );
      assert.ok(saved < script.indexOf('.Stop()'));
      assert.ok(saved < script.indexOf('.ElapsedMilliseconds'));
      assert.ok(script.indexOf(metric) < script.indexOf(completed));
      assert.match(
        script,
        /try \{ \$circleQueryProbeClock_[a-z0-9_]+ = \$null; \$circleQueryProbeClock_[a-z0-9_]+ = \[Diagnostics.Stopwatch\]::StartNew\(\) \} catch \{\};\n/,
      );
      assert.match(
        script,
        /try \{ if \(\$null -ne \$circleQueryProbeClock_[a-z0-9_]+\) \{ .*\.Stop\(\); .*\.ElapsedMilliseconds\.ToString\(\[Globalization.CultureInfo\]::InvariantCulture\)\); \[Console\]::Error.Flush\(\) \} \} catch \{\};\n/,
      );
      assert.match(
        script,
        /if \(\$circleQueryProbeSuccess_[a-z0-9_]+\) \{ exit 0 \} else \{ exit 1 \}$/,
      );
      assert.equal(
        script
          .slice(script.indexOf(pipeline) + pipeline.length, saved)
          .trim()
          .startsWith('$circleQueryProbeSuccess_'),
        true,
      );
      return result(`${entered}\r\n${metric} 0\r\n${completed}\r\n`);
    }),
    (entry) => reports.push(entry),
  );
  const actual = run(command, args, options);
  assert.equal(calls, 1);
  assert.deepEqual(args, originalArgs);
  assert.equal(actual.stderr, '');
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.lookupKind, 'cim-all');
  assert.equal(reports[0]!.scriptEnteredObserved, true);
  assert.equal(reports[0]!.pipelineCompletedObserved, true);
  assert.equal(reports[0]!.pipelineElapsedMs, 0);
  assert.equal(reports[0]!.parentPid, process.pid);
  assert.equal(reports[0]!.helperReportedPid, 12345);
  assert.ok(Object.isFrozen(reports[0]));
});

test('only complete own marker lines are stripped without altering errors, CRLF or result fields', () => {
  const error = Object.assign(new Error('synthetic timeout'), {
    code: 'ETIMEDOUT',
  });
  let raw: ReturnType<typeof result> & { error: Error };
  let entry: ProcessQueryProbeReport | undefined;
  const run = instrumentSpawnSync(
    runner((_command, actualArgs) => {
      const { entered, completed, metric } = markers(
        (actualArgs as string[])[3]!,
      );
      raw = {
        ...result(
          `${entered}\r\nfirst error\r\n${metric} 17\r\n${completed}\nsecond error\r\n`,
        ),
        status: null as never,
        signal: 'SIGTERM' as never,
        error,
      };
      return raw;
    }),
    (report) => {
      entry = report;
    },
  );
  const actual = run(command, args, options);
  assert.equal(actual.stderr, 'first error\r\nsecond error\r\n');
  assert.equal(actual.stdout, raw!.stdout);
  assert.deepEqual(actual.output, [null, raw!.stdout, actual.stderr]);
  assert.equal(raw!.output[2], raw!.stderr);
  assert.equal(actual.error, error);
  assert.equal(actual.status, null);
  assert.equal(actual.signal, 'SIGTERM');
  assert.equal(entry!.errorCode, 'ETIMEDOUT');
  assert.equal(entry!.stderrCodeUnits, raw!.stderr.length);
  assert.equal(entry!.pipelineElapsedMs, 17);
});

test('command echoes and incomplete marker fragments do not establish script execution', () => {
  let raw: ReturnType<typeof result>;
  let evidence: ProcessQueryProbeReport | undefined;
  let metricText = (metric: string) => `parser echoed '${metric} 5'\r\n`;
  const run = instrumentSpawnSync(
    runner((_command, actualArgs) => {
      const { entered, completed, metric } = markers(
        (actualArgs as string[])[3]!,
      );
      raw = result(
        `parser echoed '${entered}'\r\n${metricText(metric)}${completed}`,
      );
      return raw;
    }),
    (entry) => {
      evidence = entry;
    },
  );
  for (const text of [
    metricText,
    (metric: string) => `${metric} -1\r\n`,
    (metric: string) => `${metric} 1.5\r\n`,
    (metric: string) => `${metric} 9007199254740992\r\n`,
    (metric: string) => `${metric} invalid\r\n`,
    (metric: string) => `${metric} 5`,
    () => '',
  ]) {
    metricText = text;
    assert.equal(run(command, args, options), raw!);
    assert.equal(evidence!.scriptEnteredObserved, false);
    assert.equal(evidence!.pipelineCompletedObserved, false);
    assert.equal(evidence!.pipelineElapsedMs, 'unknown');
  }
});

test('non-PowerShell commands, absent command scripts and other encodings pass through untouched', () => {
  const inputs: unknown[][] = [
    ['node.exe', args, options],
    [command, ['-NoProfile'], options],
    [command, args, { encoding: 'utf16le', timeout: 30_000 }],
    [command, args, { timeout: 30_000 }],
    [command, { encoding: 'utf8', timeout: 30_000 }],
    [command, ['-Command', 'Write-Output "unrelated command"'], options],
  ];
  let calls = 0;
  let expected: unknown[];
  const output = result('untouched');
  const run = instrumentSpawnSync(
    runner((...actual) => {
      calls++;
      assert.deepEqual(actual, expected);
      return output;
    }),
    () => assert.fail('a nonmatching call must not report'),
  );
  for (const input of inputs) {
    expected = input;
    assert.equal(Reflect.apply(run, undefined, input), output);
  }
  assert.equal(calls, inputs.length);
});

test('native query classification and safe reports disclose no paths, script or raw streams', () => {
  const reports: ProcessQueryProbeReport[] = [];
  const secret = 'synthetic-private-path-and-stream';
  let calls = 0;
  const run = instrumentSpawnSync(
    runner(() => ({
      ...result(secret),
      stdout: secret,
      pid: calls++ === 0 ? 0 : undefined,
    })),
    (entry) => reports.push(entry),
  );
  for (const script of [
    '[Diagnostics.Process]::GetProcessesByName($circleName)',
    '[Diagnostics.Process]::GetProcesses()',
  ])
    run(command, ['-Command', `${script}; # ${secret}`], options);
  assert.deepEqual(
    reports.map((entry) => entry.lookupKind),
    ['native-names', 'native-all'],
  );
  assert.deepEqual(
    reports.map((entry) => entry.sequence),
    [1, 2],
  );
  assert.deepEqual(
    reports.map((entry) => entry.helperReportedPid),
    [0, 'unknown'],
  );
  assert.ok(reports.every((entry) => entry.pipelineElapsedMs === 'unknown'));
  assert.equal(JSON.stringify(reports).includes(secret), false);
  assert.equal(JSON.stringify(reports).includes(command), false);
});

test('a failed reporter cannot replace the original query result or thrown error', () => {
  const output = result('synthetic failure');
  const run = instrumentSpawnSync(
    runner(() => output),
    () => {
      throw Error('reporter failed');
    },
  );
  assert.equal(run(command, args, options), output);
  const error = Error('original invocation failed');
  const throws = instrumentSpawnSync(
    runner(() => {
      throw error;
    }),
    () => {
      throw Error('reporter failed');
    },
  );
  assert.throws(
    () => throws(command, args, options),
    (actual) => actual === error,
  );
});
