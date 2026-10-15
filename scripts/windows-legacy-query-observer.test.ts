import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runningCopies } from '../src/legacy_install.js';
import {
  extractStages,
  instrumentQuery,
  observeSpawnSync,
  sha256,
  type QueryReport,
} from './windows-legacy-query-observer.js';

function originalQuery(all = false): string {
  const base = mkdtempSync(join(tmpdir(), 'qo-'));
  const folder = join(base, 'version');
  const program = join(folder, 'circle.exe');
  if (!all) {
    mkdirSync(folder);
    writeFileSync(program, 'synthetic');
  }
  let query = '';
  try {
    runningCopies(
      [
        {
          kind: 'installer',
          prefix: base,
          versions: [folder],
          links: [],
          leftovers: [],
        },
      ],
      { platform: 'win32', home: base, path: '' },
      (_command, args) => {
        query = args.at(-1)!;
        return {
          status: 0,
          stdout: `23 ${Buffer.from(program).toString('base64')}\r\n`,
          stderr: '',
          error: undefined,
        };
      },
      () => 'EBUSY',
    );
    assert.ok(query);
    return query;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
const nonce = '1234567890abcdef1234567890abcdef';
const nativeResult = (stderr = ''): SpawnSyncReturns<string> => ({
  pid: 0,
  status: 0,
  signal: null,
  stdout: 'original protocol',
  stderr,
  output: [null, 'original protocol', stderr],
});
const args = (query: string) => [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  query,
];

test('both actual production query variants retain every original statement after removing only diagnostic insertions', () => {
  for (const all of [false, true]) {
    const original = originalQuery(all);
    const instrumented = instrumentQuery(original, nonce)!;
    assert.ok(instrumented);
    const marker =
      /try \{ \$circleDiagnosticCounts\['(?:DECODE|LOOKUP|MODULE|DISPOSE|COMPLETE)'\] = 1 \+ \$circleDiagnosticCounts\['(?:DECODE|LOOKUP|MODULE|DISPOSE|COMPLETE)'\]; if \(\$circleDiagnosticCounts\['(?:DECODE|LOOKUP|MODULE|DISPOSE|COMPLETE)'\] -le 32\) \{ \[Console\]::Error.WriteLine\('CIRCLE_DIAG_[a-f0-9]{32} (?:DECODE|LOOKUP|MODULE|DISPOSE|COMPLETE) ' \+ \[DateTimeOffset\]::UtcNow.ToUnixTimeMilliseconds\(\)\); \[Console\]::Error.Flush\(\) \} \} catch \{\}; /g;
    const stripped = instrumented
      .replace(marker, '')
      .replace(/^\$circleDiagnosticCounts = @\{\}; /, '')
      .replace(
        /; \$circleDiagnosticSuccess = \$\?; if \(\$circleDiagnosticSuccess\) \{ exit 0 \} else \{ exit 1 \}$/,
        '',
      );
    assert.equal(stripped, original);
    assert.match(
      instrumented,
      /\$circleProcess.Dispose\(\) \} \}; \$circleDiagnosticSuccess = \$\?;/,
    );
    assert.ok(!instrumented.includes('} catch { try'));
  }
});

test('one matched spawn preserves timeout/options, stdout, status, signal and error identity and strips only own complete marker lines', () => {
  const query = originalQuery();
  const options = Object.freeze({
    encoding: 'utf8' as const,
    timeout: 30_000,
    windowsHide: false,
  });
  const requested = Object.freeze(args(query));
  const error = Object.assign(new Error('synthetic'), { code: 'ETIMEDOUT' });
  let calls = 0;
  let original: SpawnSyncReturns<string>;
  const reports: QueryReport[] = [];
  const observed = observeSpawnSync(
    ((command: string, executed: string[], received: unknown) => {
      calls++;
      assert.equal(command, 'powershell.exe');
      assert.equal(received, options);
      const own = /CIRCLE_DIAG_([a-f0-9]{32})/.exec(executed[3]!)![1];
      original = {
        ...nativeResult(
          `keep\r\nCIRCLE_DIAG_${own} MODULE ${Date.now()}\r\ntail`,
        ),
        status: null,
        signal: 'SIGTERM',
        error,
      };
      return original;
    }) as typeof spawnSync,
    (report) => reports.push(report),
  );
  const result = observed('powershell.exe', requested, options);
  assert.equal(calls, 1);
  assert.deepEqual(requested, args(query));
  assert.equal(result.stdout, 'original protocol');
  assert.equal(result.stderr, 'keep\r\ntail');
  assert.equal(result.output[2], 'keep\r\ntail');
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.error, error);
  assert.match(original!.stderr, /CIRCLE_DIAG_/);
  assert.equal(reports[0]!.originalQuerySha256, sha256(query));
  assert.equal(reports[0]!.stdoutSha256, sha256('original protocol'));
  assert.equal(JSON.stringify(reports).includes('original protocol'), false);
  assert.equal(reports[0]!.lastReached, 'MODULE');
});

test('unknown scripts, different budgets and encodings are passed through with original references and no report', () => {
  for (const [query, options] of [
    ['unknown', { encoding: 'utf8', timeout: 30_000 }],
    [originalQuery(), { encoding: 'utf8', timeout: 30_001 }],
    [originalQuery(), { encoding: 'buffer', timeout: 30_000 }],
  ] as const) {
    const input = args(query);
    const result = nativeResult();
    let calls = 0;
    const observed = observeSpawnSync(
      ((command: string, actualArgs: unknown, actualOptions: unknown) => {
        calls++;
        assert.equal(command, 'powershell.exe');
        assert.equal(actualArgs, input);
        assert.equal(actualOptions, options);
        return result;
      }) as typeof spawnSync,
      () => assert.fail('unmatched query was reported'),
    );
    assert.equal(
      observed(
        'powershell.exe',
        input,
        options as { encoding: 'utf8'; timeout: number },
      ),
      result,
    );
    assert.equal(calls, 1);
  }
});

test('malformed, foreign or partial marker lines remain byte for byte in stderr', () => {
  const malformed = `CIRCLE_DIAG_${nonce} MODULE 7\r\r\nCIRCLE_DIAG_${nonce} MODULE -1\nCIRCLE_DIAG_${nonce} OTHER 3\nCIRCLE_DIAG_${'f'.repeat(32)} MODULE 3\nCIRCLE_DIAG_${nonce} MODULE 8`;
  const parsed = extractStages(malformed, nonce);
  assert.equal(parsed.cleaned, malformed);
  assert.equal(parsed.lastReached, 'unknown');
  assert.deepEqual(parsed.first, {});
});

test('native throws and observation write failures retain the original outcome', () => {
  const error = new Error('native original');
  const nativeThrow = observeSpawnSync(
    (() => {
      throw error;
    }) as typeof spawnSync,
    () => assert.fail('no native result'),
  );
  assert.throws(
    () =>
      nativeThrow('powershell.exe', args(originalQuery()), {
        encoding: 'utf8',
        timeout: 30_000,
      }),
    (actual) => actual === error,
  );
  const result = nativeResult('plain stderr');
  const writeThrow = observeSpawnSync(
    (() => result) as unknown as typeof spawnSync,
    () => {
      throw new Error('disk');
    },
  );
  const actual = writeThrow('powershell.exe', args(originalQuery()), {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(actual.stdout, result.stdout);
  assert.equal(actual.stderr, result.stderr);
  assert.equal(actual.status, result.status);
});

test('invalid nonce and modified production command are not instrumented', () => {
  const query = originalQuery();
  assert.equal(instrumentQuery(query, 'not-hex'), undefined);
  assert.equal(
    instrumentQuery(query.replace('catch {}', 'catch { throw }'), nonce),
    undefined,
  );
});

test('an unspawned null-output native result retains its original error and null streams', () => {
  const error = Object.assign(new Error('unspawned'), { code: 'ENOENT' });
  const result = {
    status: null,
    signal: null,
    stdout: null,
    stderr: null,
    output: null,
    error,
  };
  const observed = observeSpawnSync(
    (() => result) as unknown as typeof spawnSync,
    () => {},
  );
  const actual = observed('powershell.exe', args(originalQuery()), {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(actual.error, error);
  assert.equal(actual.stdout, null);
  assert.equal(actual.stderr, null);
  assert.equal(actual.output, null);
});
