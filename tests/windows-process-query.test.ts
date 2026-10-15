import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { runningCopies, type InstallerCopy } from '../src/legacy_install.js';
import {
  readWindowsQueryMarkers,
  windowsProcessQuery,
  WindowsProcessQueryObservation,
} from '../src/windows_process_query.js';

function heldCopy(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'wq-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const version = join(base, 'version');
  mkdirSync(version);
  const program = join(version, 'circle.exe');
  writeFileSync(program, 'synthetic held image');
  const copy: InstallerCopy = {
    kind: 'installer',
    prefix: base,
    versions: [version],
    links: [],
    leftovers: [],
  };
  return {
    copy,
    program,
    where: { platform: 'win32' as const, home: base, path: '' },
  };
}

test('a timed out Windows query keeps its original error message and attaches the last captured stage', (t) => {
  const { copy, program, where } = heldCopy(t);
  const nativeError = Object.assign(new Error('native timeout'), {
    code: 'ETIMEDOUT',
  });
  let calls = 0;
  assert.throws(
    () =>
      runningCopies(
        [copy],
        where,
        (_command, args, timeout) => {
          calls++;
          assert.equal(timeout, 30_000);
          const nonce =
            /CIRCLE_QUERY_([a-f0-9]{32})/.exec(args.at(-1)!)?.[1] ??
            'f'.repeat(32);
          return {
            status: null,
            stdout: '',
            stderr: `CIRCLE_QUERY_${nonce} LOOKUP\r\n`,
            error: nativeError,
          };
        },
        () => 'EBUSY',
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `${program} is in use, and the running programs could not be listed (no answer in 30 s)`,
      );
      assert.ok(
        error.cause instanceof Error,
        'the timeout carries a visible diagnostic cause',
      );
      assert.match(error.cause.message, /last captured stage: LOOKUP/);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(nativeError.message, 'native timeout');
});

const nonce = '1234567890abcdef1234567890abcdef';
const marker = (stage: string, own = nonce) =>
  `CIRCLE_QUERY_${own} ${stage}\r\n`;

test('a query with no complete marker reports unknown rather than a startup cause', () => {
  const markers = readWindowsQueryMarkers('original\r\ntail', nonce);
  assert.equal(markers.cleaned, 'original\r\ntail');
  assert.equal(markers.lastCapturedStage, 'unknown');
  assert.deepEqual(markers.counts, {
    DECODE: 0,
    LOOKUP: 0,
    MODULE: 0,
    DISPOSE: 0,
    COMPLETE: 0,
  });
  const observation = new WindowsProcessQueryObservation(markers, 30_010.4, {
    status: null,
  });
  assert.match(observation.message, /last captured stage: unknown/);
  assert.equal(observation.details.errorCode, 'unknown');
  assert.equal(observation.details.elapsedMs, 30_010);
});

test('captured boundaries and capped stages are reported without claiming a stalled operation', () => {
  const markers = readWindowsQueryMarkers(
    marker('DECODE') +
      marker('LOOKUP') +
      marker('MODULE').repeat(32) +
      marker('DISPOSE').repeat(32),
    nonce,
  );
  assert.equal(markers.lastCapturedStage, 'DISPOSE');
  assert.deepEqual(markers.possiblyCappedStages, ['MODULE', 'DISPOSE']);
  assert.equal(markers.counts.COMPLETE, 0);
  assert.equal(markers.cleaned, '');
  const observation = new WindowsProcessQueryObservation(markers, 30_000, {
    status: null,
  });
  assert.match(observation.message, /possibly capped stages: MODULE,DISPOSE/);
  assert.match(observation.message, /not the stalled operation/);
  const complete = readWindowsQueryMarkers(
    marker('DECODE') + marker('COMPLETE'),
    nonce,
  );
  assert.equal(complete.lastCapturedStage, 'COMPLETE');
  const failedAfterComplete = new WindowsProcessQueryObservation(complete, 9, {
    status: 7,
  });
  assert.equal(failedAfterComplete.details.status, 7);
  assert.match(failedAfterComplete.message, /last captured stage: COMPLETE/);
});

test('only own complete valid lines are stripped and all other stderr characters survive', () => {
  const untouched =
    marker('LOOKUP', 'f'.repeat(32)) +
    `CIRCLE_QUERY_${nonce} MODULE \r\n` +
    `CIRCLE_QUERY_${nonce} MODULE\r\r\n` +
    `CIRCLE_QUERY_${nonce} OTHER\n` +
    `CIRCLE_QUERY_${nonce} DISPOSE`;
  const markers = readWindowsQueryMarkers(
    'before\r\n' + marker('LOOKUP') + untouched,
    nonce,
  );
  assert.equal(markers.cleaned, 'before\r\n' + untouched);
  assert.deepEqual(markers.counts, {
    DECODE: 0,
    LOOKUP: 1,
    MODULE: 0,
    DISPOSE: 0,
    COMPLETE: 0,
  });
  assert.equal(markers.lastCapturedStage, 'LOOKUP');
});

test('both query bodies preserve original statements and immediately save the final status', () => {
  for (const all of [false, true]) {
    const names = ['circle', '用户 image'];
    const { script } = windowsProcessQuery(names, all, nonce);
    const stripped = script
      .replace(
        /try \{ \$circleQueryCounts\['(?:DECODE|LOOKUP|MODULE|DISPOSE|COMPLETE)'\] = 1 \+ \$circleQueryCounts\['(?:DECODE|LOOKUP|MODULE|DISPOSE|COMPLETE)'\]; if \(\$circleQueryCounts\['(?:DECODE|LOOKUP|MODULE|DISPOSE|COMPLETE)'\] -le 32\) \{ \[Console\]::Error.WriteLine\('CIRCLE_QUERY_[a-f0-9]{32} (?:DECODE|LOOKUP|MODULE|DISPOSE|COMPLETE)'\); \[Console\]::Error.Flush\(\) \} \} catch \{\}; /g,
        '',
      )
      .replace(/^\$circleQueryCounts = @\{\}; /, '')
      .replace(
        /; \$circleQuerySuccess = \$\?; if \(\$circleQuerySuccess\) \{ exit 0 \} else \{ exit 1 \}$/,
        '',
      );
    const encoded = Buffer.from(JSON.stringify(names)).toString('base64');
    const lookup = all
      ? '[Diagnostics.Process]::GetProcesses()'
      : 'foreach ($circleName in $circleNames) { [Diagnostics.Process]::GetProcessesByName($circleName) }';
    assert.equal(
      stripped,
      `$circleNames = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json); ` +
        `$circleProcesses = @(${lookup}); ` +
        'foreach ($circleProcess in $circleProcesses) { try { ' +
        '$circlePath = $circleProcess.MainModule.FileName; if ($circlePath) { ' +
        '"$($circleProcess.Id) $([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($circlePath)))" ' +
        '} } catch {} finally { $circleProcess.Dispose() } }',
    );
    assert.match(
      script,
      /\$circleProcess.Dispose\(\) \} \}; \$circleQuerySuccess = \$\?;/,
    );
    assert.ok(
      script.indexOf('COMPLETE') > script.indexOf('$circleQuerySuccess = $?'),
    );
  }
});

test('nonzero exits preserve non-marker stderr in the primary message and leave the native result unchanged', (t) => {
  const { copy, program, where } = heldCopy(t);
  let native: {
    status: number;
    stdout: string;
    stderr: string;
    error: undefined;
  };
  assert.throws(
    () =>
      runningCopies(
        [copy],
        where,
        (_command, args, timeout) => {
          assert.equal(timeout, 30_000);
          const own = /CIRCLE_QUERY_([a-f0-9]{32})/.exec(args.at(-1)!)![1];
          native = {
            status: 7,
            stdout: '',
            stderr: marker('MODULE', own) + 'Access denied\r\n',
            error: undefined,
          };
          return native;
        },
        () => 'EBUSY',
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `${program} is in use, and the running programs could not be listed (Access denied)`,
      );
      assert.ok(error.cause instanceof WindowsProcessQueryObservation);
      assert.equal(error.cause.details.status, 7);
      assert.equal(error.cause.details.lastCapturedStage, 'MODULE');
      return true;
    },
  );
  assert.equal(native!.status, 7);
  assert.match(
    native!.stderr,
    /^CIRCLE_QUERY_[a-f0-9]{32} MODULE\r\nAccess denied\r\n$/,
  );
});

test('known PIDs still block installation even when the native query times out after producing them', (t) => {
  const { copy, program, where } = heldCopy(t);
  const nativeError = Object.assign(new Error('original native error'), {
    code: 'ETIMEDOUT',
  });
  const stdout = `41 ${Buffer.from(program).toString('base64')}\r\n`;
  let calls = 0;
  let reports = 0;
  const native = {
    status: null,
    stdout,
    stderr: 'original stderr',
    error: nativeError,
  };
  assert.deepEqual(
    runningCopies(
      [copy],
      where,
      (_command, _args, timeout) => {
        calls++;
        assert.equal(timeout, 30_000);
        return native;
      },
      () => 'EBUSY',
      () => {
        reports++;
      },
    ),
    [41],
  );
  assert.equal(calls, 1);
  assert.equal(reports, 0, 'an identified PID must remain silent');
  assert.deepEqual(native, {
    status: null,
    stdout,
    stderr: 'original stderr',
    error: nativeError,
  });
  assert.equal(native.error, nativeError);
});

test('an unheld program does not start a query', (t) => {
  const { copy, where } = heldCopy(t);
  let reports = 0;
  assert.deepEqual(
    runningCopies(
      [copy],
      where,
      () => assert.fail('unexpected query'),
      () => undefined,
      () => {
        reports++;
      },
    ),
    [],
  );
  assert.equal(reports, 0, 'an unheld program must remain silent');
});

test('the safe observation excludes raw streams and unexpected native codes', () => {
  const observation = new WindowsProcessQueryObservation(
    readWindowsQueryMarkers('private stream\r\n' + marker('LOOKUP'), nonce),
    3.8,
    {
      status: null,
      error: Object.assign(new Error('private error'), {
        code: 'private\nvalue',
      }),
    },
  );
  assert.equal(observation.details.errorCode, 'unknown');
  assert.doesNotMatch(observation.message, /private/);
});

test('a failing diagnostic sink cannot replace the original query failure', (t) => {
  const { copy, program, where } = heldCopy(t);
  const reports: string[] = [];
  const nativeError = Object.assign(new Error('original native error'), {
    code: 'EACCES',
  });
  assert.throws(
    () =>
      runningCopies(
        [copy],
        where,
        () => ({
          status: null,
          stdout: '',
          stderr: 'original native stderr',
          error: nativeError,
        }),
        () => 'EBUSY',
        (summary) => {
          reports.push(summary);
          throw new Error('diagnostic sink failure');
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `${program} is in use, and the running programs could not be listed (original native error)`,
      );
      assert.ok(error.cause instanceof WindowsProcessQueryObservation);
      assert.equal(error.cause.details.errorCode, 'EACCES');
      assert.equal(
        error.stack!.includes('    at Windows process query observation'),
        false,
      );
      return true;
    },
  );
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /last captured stage: unknown/);
  assert.equal(nativeError.message, 'original native error');
});

test('the actual TAP reporter shows a direct caller failure observation while retaining its primary error', (t) => {
  const { copy, program, where } = heldCopy(t);
  const primary = `${program} is in use, and the running programs could not be listed (no answer in 30 s)`;
  const windowsPrimary =
    'C:\\synthetic\\versions\\1.7.0\\circle.exe is in use, and the running programs could not be listed (no answer in 30 s)';
  const fixture = join(where.home, 'failure.test.mjs');
  const source = pathToFileURL(
    join(import.meta.dirname, '..', 'src', 'legacy_install.ts'),
  ).href;
  writeFileSync(
    fixture,
    `import { test } from 'node:test'; import { runningCopies } from ${JSON.stringify(source)};\n` +
      `test('direct timeout', () => runningCopies(${JSON.stringify([copy])}, ${JSON.stringify(where)}, (_command, args) => {\n` +
      `const nonce = /CIRCLE_QUERY_([a-f0-9]{32})/.exec(args.at(-1))[1];\n` +
      `return { status: null, stdout: '', stderr: 'CIRCLE_QUERY_' + nonce + ' LOOKUP\\r\\n', error: Object.assign(new Error('native timeout'), { code: 'ETIMEDOUT' }) };\n` +
      `}, () => 'EBUSY'));\n` +
      `test('synthetic Windows primary', () => { throw new Error(${JSON.stringify(windowsPrimary)}); });\n`,
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CIRCLE_HOME: where.home,
  };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-reporter=tap', fixture],
    { encoding: 'utf8', env: environment, timeout: 10_000 },
  );
  const actual = result.stderr + result.stdout;
  assert.equal(result.status, 1, actual);
  assert.match(result.stdout, /^# tests 2\r?$/m, actual);
  assert.match(result.stdout, /^# fail 2\r?$/m, actual);
  const errorFields = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('  error: '));
  const errorField = (message: string) =>
    `  error: ${inspect(message, { colors: false, breakLength: Infinity })}`;
  assert.deepEqual(
    errorFields,
    [primary, windowsPrimary].map(errorField),
    actual,
  );
  for (const message of [primary, windowsPrimary]) {
    assert.equal(
      errorFields.includes(errorField(message.slice(1))),
      false,
      actual,
    );
    assert.equal(
      errorFields.includes(errorField(message.replace('30 s', '31 s'))),
      false,
      actual,
    );
  }
  assert.match(result.stdout, /last captured stage: LOOKUP/, actual);
  assert.match(
    result.stdout,
    /captured counts: DECODE=0,LOOKUP=1,MODULE=0,DISPOSE=0,COMPLETE=0/,
    actual,
  );
});
