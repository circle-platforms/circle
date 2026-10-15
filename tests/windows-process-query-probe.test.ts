import test from 'node:test';
import assert from 'node:assert/strict';
import type childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
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
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

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
  let executedScript = '';
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
      executedScript = script;
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
  assert.equal(reports[0]!.requestedLookupKind, 'cim-all');
  assert.equal(reports[0]!.queryTransformed, false);
  assert.equal(reports[0]!.originalQuerySha256, hash(pipeline));
  assert.equal(reports[0]!.effectiveQuerySha256, hash(pipeline));
  assert.equal(reports[0]!.executedScriptSha256, hash(executedScript));
  assert.equal(reports[0]!.requestedWindowsHide, 'default');
  assert.equal(reports[0]!.effectiveWindowsHide, false);
  assert.equal(reports[0]!.scriptEnteredObserved, true);
  assert.equal(reports[0]!.pipelineCompletedObserved, true);
  assert.equal(reports[0]!.pipelineElapsedMs, 0);
  assert.equal(reports[0]!.parentPid, process.pid);
  assert.equal(reports[0]!.helperReportedPid, 12345);
  assert.ok(Object.isFrozen(reports[0]));
});

test('a hide-window experiment changes only the recognized query option and keeps the CIM body', () => {
  const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];
  Object.freeze(stdio);
  const env = Object.freeze({ SYNTHETIC_QUERY_PROBE: '1' });
  for (const windowsHide of [true, false]) {
    const originalOptions = Object.freeze({
      ...options,
      stdio,
      env,
      windowsHide: !windowsHide,
      maxBuffer: 4_194_304,
    });
    const originalArgs = Object.freeze([...args]);
    let calls = 0;
    let entry: ProcessQueryProbeReport | undefined;
    let expectedArgs: readonly string[] = originalArgs;
    const output = result();
    const run = instrumentSpawnSync(
      runner((actualCommand, actualArgs, actualOptions) => {
        calls++;
        assert.equal(actualCommand, command);
        if (expectedArgs === originalArgs) {
          assert.notEqual(actualOptions, originalOptions);
          assert.deepEqual(actualOptions, { ...originalOptions, windowsHide });
          const copied = actualOptions as typeof originalOptions;
          assert.equal(copied.stdio, stdio);
          assert.equal(copied.env, env);
          assert.equal(copied.timeout, 30_000);
          assert.notEqual(actualArgs, originalArgs);
          const actual = actualArgs as string[];
          assert.deepEqual(actual.slice(0, 3), args.slice(0, 3));
          assert.equal(actual[3]!.split(pipeline).length, 2);
          assert.equal(actual[3]!.includes('function Get-CimInstance'), false);
        } else {
          assert.equal(actualArgs, expectedArgs);
          assert.equal(actualOptions, originalOptions);
        }
        return output;
      }),
      (report) => {
        entry = report;
      },
      { windowsHide },
    );
    assert.equal(run(command, originalArgs, originalOptions), output);
    assert.equal(calls, 1);
    assert.deepEqual(originalArgs, args);
    assert.equal(originalOptions.windowsHide, !windowsHide);
    assert.equal(entry!.requestedWindowsHide, !windowsHide);
    assert.equal(entry!.effectiveWindowsHide, windowsHide);
    assert.equal(entry!.queryTransformed, false);
    assert.equal(entry!.lookupKind, 'cim-all');
    assert.equal(entry!.originalQuerySha256, hash(pipeline));
    assert.equal(entry!.effectiveQuerySha256, hash(pipeline));
    expectedArgs = ['-Command', 'Write-Output "unrelated command"'];
    entry = undefined;
    assert.equal(run(command, expectedArgs, originalOptions), output);
    assert.equal(calls, 2);
    assert.equal(entry, undefined);
  }
});

test('default probing preserves an explicit hide-window option and the original options object', () => {
  for (const windowsHide of [true, false]) {
    const originalOptions = Object.freeze({ ...options, windowsHide });
    let entry: ProcessQueryProbeReport | undefined;
    let calls = 0;
    const output = result();
    const run = instrumentSpawnSync(
      runner((_command, _args, actualOptions) => {
        calls++;
        assert.equal(actualOptions, originalOptions);
        return output;
      }),
      (report) => {
        entry = report;
      },
    );
    assert.equal(run(command, args, originalOptions), output);
    assert.equal(calls, 1);
    assert.equal(entry!.requestedWindowsHide, windowsHide);
    assert.equal(entry!.effectiveWindowsHide, windowsHide);
  }
});

test('a candidate replaces one recognized query without changing its call, arguments or deadline', () => {
  const query = '[SyntheticWindowsImageQuery]::WriteProcesses()';
  const forbidden =
    "function Get-CimInstance { throw 'CIM is unavailable in this synthetic probe' };\n";
  const effective = forbidden + query;
  const queryArgs = Object.freeze([...args]);
  const queryOptions = Object.freeze({ ...options });
  const reports: ProcessQueryProbeReport[] = [];
  let calls = 0;
  let executed = '';
  const output = {
    ...result('original error\r\n'),
    status: 1,
    error: Object.assign(new Error('original query failure'), {
      code: 'EQUERY',
    }),
  };
  const run = instrumentSpawnSync(
    runner((actualCommand, actualArgs, actualOptions) => {
      calls++;
      assert.equal(actualCommand, command);
      assert.equal(actualOptions, queryOptions);
      assert.equal(queryOptions.timeout, 30_000);
      const actual = actualArgs as string[];
      assert.notEqual(actual, queryArgs);
      assert.deepEqual(actual.slice(0, 3), args.slice(0, 3));
      executed = actual[3]!;
      assert.equal(executed.includes(pipeline), false);
      assert.equal(executed.split(query).length, 2);
      assert.equal(executed.split(forbidden).length, 2);
      assert.ok(
        executed.indexOf('[Diagnostics.Stopwatch]::StartNew()') <
          executed.indexOf(effective),
      );
      assert.match(
        executed,
        /\[SyntheticWindowsImageQuery\]::WriteProcesses\(\)\n\$circleQueryProbeSuccess_[a-z0-9_]+ = \$\?;\n/,
      );
      const saved = executed.indexOf(' = $?;');
      assert.ok(saved < executed.indexOf('.Stop()'));
      assert.match(
        executed,
        /if \(\$circleQueryProbeSuccess_[a-z0-9_]+\) \{ exit 0 \} else \{ exit 1 \}$/,
      );
      return output;
    }),
    (entry) => reports.push(entry),
    { queryScript: query, forbidCim: true },
  );
  assert.equal(run(command, queryArgs, queryOptions), output);
  assert.equal(calls, 1);
  assert.deepEqual(queryArgs, args);
  assert.deepEqual(queryOptions, options);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.requestedLookupKind, 'cim-all');
  assert.equal(reports[0]!.lookupKind, 'win32-image');
  assert.equal(reports[0]!.queryTransformed, true);
  assert.equal(reports[0]!.originalQuerySha256, hash(pipeline));
  assert.equal(reports[0]!.effectiveQuerySha256, hash(effective));
  assert.equal(reports[0]!.executedScriptSha256, hash(executed));
  assert.equal(reports[0]!.status, 1);
  assert.equal(reports[0]!.errorCode, 'EQUERY');
  assert.equal(JSON.stringify(reports).includes(query), false);
  assert.equal(JSON.stringify(reports).includes(pipeline), false);
  assert.equal(JSON.stringify(reports).includes('original error'), false);
});

test('CIM blocking is candidate-only and an unknown command is never replaced', () => {
  for (const probeOptions of [
    { forbidCim: true },
    { queryScript: '[SyntheticWindowsImageQuery]::WriteProcesses()' },
  ]) {
    let calls = 0;
    let expectedArgs: string[] = args;
    let entry: ProcessQueryProbeReport | undefined;
    const output = result();
    const run = instrumentSpawnSync(
      runner((_command, actualArgs, actualOptions) => {
        calls++;
        assert.equal(actualOptions, options);
        const actual = actualArgs as string[];
        if (expectedArgs === args) {
          assert.equal(actual[3]!.includes('function Get-CimInstance'), false);
          assert.equal(
            actual[3]!.includes(probeOptions.queryScript ?? pipeline),
            true,
          );
        } else assert.equal(actualArgs, expectedArgs);
        return output;
      }),
      (report) => {
        entry = report;
      },
      probeOptions,
    );
    assert.equal(run(command, args, options), output);
    assert.equal(
      entry!.queryTransformed,
      probeOptions.queryScript !== undefined,
    );
    entry = undefined;
    expectedArgs = ['-Command', 'Write-Output "unrelated command"'];
    assert.equal(run(command, expectedArgs, options), output);
    assert.equal(entry, undefined);
    assert.equal(calls, 2);
  }
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
    (metric: string) => `${metric} 5\r\r\n`,
    (metric: string) => `${metric} 5\u2028\n`,
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

test('UTC phase markers split only consistent same-host observations and preserve the query outcome', (t) => {
  const wall = [1_000, 2_000];
  const mono = [0, 1_000];
  t.mock.method(Date, 'now', () => wall.shift()!);
  t.mock.method(performance, 'now', () => mono.shift()!);
  let entry: ProcessQueryProbeReport | undefined;
  let calls = 0;
  const originalOptions = Object.freeze({ ...options });
  const run = instrumentSpawnSync(
    runner((actualCommand, actualArgs, actualOptions) => {
      calls++;
      assert.equal(actualCommand, command);
      assert.equal(actualOptions, originalOptions);
      const script = (actualArgs as string[])[3]!;
      const { entered, completed, metric } = markers(script);
      const firstUtc = `${entered}_UTC_MS`;
      const lastUtc = `${completed}_UTC_MS`;
      assert.ok(script.indexOf(firstUtc) < script.indexOf(entered + "');"));
      assert.ok(script.indexOf(lastUtc) > script.indexOf(completed + "');"));
      assert.equal(script.split(pipeline).length, 2);
      assert.match(script, /\n\$circleQueryProbeSuccess_[a-z0-9_]+ = \$\?;\n/);
      return result(
        `${firstUtc} 1100\r\n${entered}\r\n${metric} 600\r\n${completed}\r\n${lastUtc} 1800\r\n`,
      );
    }),
    (report) => {
      entry = report;
    },
  );
  const actual = run(command, args, originalOptions);
  assert.equal(calls, 1);
  assert.equal(actual.status, 0);
  assert.equal(actual.signal, null);
  assert.equal(actual.stderr, '');
  assert.equal(entry!.elapsedMs, 1_000);
  assert.equal(entry!.parentStartedUtcMs, 1_000);
  assert.equal(entry!.parentCompletedUtcMs, 2_000);
  assert.equal(entry!.scriptEnteredUtcMs, 1_100);
  assert.equal(entry!.scriptCompletedUtcMs, 1_800);
  assert.equal(entry!.pipelineElapsedMs, 600);
  assert.equal(entry!.beforeFirstScriptTimestampMs, 100);
  assert.equal(entry!.afterLastScriptTimestampMs, 200);
  assert.equal(entry!.phaseClockCheck, 'passed');
  assert.equal(entry!.originalQuerySha256, hash(pipeline));
  assert.equal(entry!.effectiveQuerySha256, hash(pipeline));
  assert.equal(entry!.queryTransformed, false);
});

test('missing duplicate malformed or inconsistent clocks leave phase durations unknown without changing failures', (t) => {
  let wall: number[] = [];
  let mono: number[] = [];
  t.mock.method(Date, 'now', () => wall.shift()!);
  t.mock.method(performance, 'now', () => mono.shift()!);
  const variants = [
    { name: 'missing entry', entry: '' },
    { name: 'missing completion', completion: '' },
    { name: 'duplicate entry', entry: '{E} 1100\n{E} 1100\n' },
    { name: 'duplicate completion', completion: '{C} 1800\n{C} 1800\n' },
    { name: 'malformed entry', entry: '{E} invalid\n' },
    { name: 'double CR entry', entry: '{E} 1100\r\r\n', retain: true },
    {
      name: 'Unicode line terminator entry',
      entry: '{E} 1100\u2028\n',
      retain: true,
    },
    { name: 'negative entry', entry: '{E} -1\n' },
    { name: 'fractional entry', entry: '{E} 1100.5\n' },
    { name: 'unsafe entry', entry: '{E} 9007199254740992\n' },
    { name: 'half completion', completion: '{C} 1800' },
    { name: 'complete plus half completion', completion: '{C} 1800\n{C} 1800' },
    {
      name: 'reversed script clocks',
      entry: '{E} 1900\n',
      completion: '{C} 1800\n',
    },
    { name: 'outside parent', entry: '{E} 999\n' },
    { name: 'parent clock reversed', parentEnd: 900 },
    { name: 'wall monotonic jump', parentEnd: 2_101 },
    { name: 'invalid parent clock', parentEnd: NaN },
    { name: 'backward monotonic clock', monoEnd: -1 },
    { name: 'pipeline contradicts UTC', pipelineMs: 801 },
  ];
  for (const variant of variants) {
    wall = [1_000, variant.parentEnd ?? 2_000];
    mono = [0, variant.monoEnd ?? 1_000];
    let entry: ProcessQueryProbeReport | undefined;
    let calls = 0;
    let retained = '';
    const error = Object.assign(Error('synthetic original error'), {
      code: 'ETIMEDOUT',
    });
    const run = instrumentSpawnSync(
      runner((_command, actualArgs, actualOptions) => {
        calls++;
        assert.equal(actualOptions, options);
        const script = (actualArgs as string[])[3]!;
        const { entered, completed, metric } = markers(script);
        if (variant.retain)
          retained = variant.entry!.replaceAll('{E}', `${entered}_UTC_MS`);
        const text =
          `${variant.entry ?? '{E} 1100\n'}${entered}\n${metric} ${variant.pipelineMs ?? 600}\n${completed}\n${variant.completion ?? '{C} 1800\n'}`
            .replaceAll('{E}', `${entered}_UTC_MS`)
            .replaceAll('{C}', `${completed}_UTC_MS`);
        return { ...result(text), status: null, signal: 'SIGTERM', error };
      }),
      (report) => {
        entry = report;
      },
    );
    const actual = run(command, args, options);
    assert.equal(calls, 1, variant.name);
    assert.equal(actual.error, error, variant.name);
    assert.equal(actual.status, null, variant.name);
    assert.equal(actual.signal, 'SIGTERM', variant.name);
    if (variant.retain)
      assert.ok(actual.stderr!.includes(retained), variant.name);
    assert.equal(entry!.phaseClockCheck, 'unknown', variant.name);
    assert.equal(entry!.beforeFirstScriptTimestampMs, 'unknown', variant.name);
    assert.equal(entry!.afterLastScriptTimestampMs, 'unknown', variant.name);
    assert.equal(entry!.originalQuerySha256, hash(pipeline), variant.name);
    assert.equal(entry!.effectiveQuerySha256, hash(pipeline), variant.name);
  }
});
