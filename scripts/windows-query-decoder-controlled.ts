// Manual Windows-only controlled dependency fixture; never a production entry point.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsProcessQuery as before } from './fixtures/windows-query-before-decoder.js';
import { windowsProcessQuery as candidate } from '../src/windows_process_query.js';

const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
const output = process.env.CIRCLE_QUERY_CONTROL_OUTPUT;
if (!output) throw new Error('controlled output folder is required');
if (process.platform !== 'win32')
  throw new Error('controlled fixture requires Windows');
mkdirSync(output, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
const names = [
  'circle',
  'circle nonexistent 用户 image',
  "circle nonexistent quote' image",
  'circle nonexistent $ image',
];
const oldQuery = before(names, false, '1'.repeat(32));
const newQuery = candidate(names, false, '2'.repeat(32));
assert.match(oldQuery.script, /ConvertFrom-Json/);
assert.doesNotMatch(
  newQuery.script,
  /ConvertFrom-Json/,
  'supply the reviewed candidate source before running this draft',
);
// Test-only witness: compare exact names without invoking either JSON cmdlet.
// It is inserted after the decoder and before the unmodified process lookup.
const encodedExpected = Buffer.from(names.join('\0'), 'utf8').toString(
  'base64',
);
const witness = `$circleControlNames = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]::Join([string][char]0, [string[]]$circleNames))); if ($circleControlNames -ne '${encodedExpected}') { throw 'CIRCLE_CONTROL_NAMES_MISMATCH' }; [Console]::Error.WriteLine('CIRCLE_CONTROL_NAMES_EXACT'); [Console]::Error.Flush(); `;
const controlled = (script: string) => {
  const token = '$circleProcesses = @(';
  assert.equal(
    script.split(token).length,
    2,
    'one exact decoder/lookup boundary',
  );
  return controlledPrefix + script.replace(token, witness + token);
};
const payloadCases = [
  [],
  [''],
  ['', '', ''],
  ['', 'circle', ''],
  ['用户', '😀', ' spaces ', 'quote\'"$;[]'],
];
const payloadBody = payloadCases
  .map((values, index) => {
    const script = candidate(values, false, '3'.repeat(32)).script;
    const start = script.indexOf('$circleNames = ');
    const end = script.indexOf(';', start);
    assert.ok(start >= 0 && end > start);
    const assignment = script.slice(start, end + 1);
    assert.doesNotMatch(assignment, /ConvertFrom-Json/);
    return (
      assignment +
      ` if (-not ($circleNames -is [array])) { throw 'CIRCLE_CONTROL_NOT_ARRAY_${index}' }; [Console]::Out.WriteLine('CASE ${index} LENGTH ' + $circleNames.Length); for ($circleControlIndex = 0; $circleControlIndex -lt $circleNames.Length; $circleControlIndex++) { if (-not ($circleNames[$circleControlIndex] -is [string])) { throw 'CIRCLE_CONTROL_NOT_STRING_${index}' }; [Console]::Out.WriteLine('CASE ${index} ITEM ' + $circleControlIndex + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($circleNames[$circleControlIndex]))) }; `
    );
  })
  .join('');
const controlledPrefix =
  "function ConvertFrom-Json { [Console]::Error.WriteLine('CIRCLE_CONTROL_JSON_CALLED'); [Console]::Error.Flush(); [Console]::Error.WriteLine('CIRCLE_CONTROL_JSON_UNAVAILABLE'); [Console]::Error.Flush(); throw 'CIRCLE_CONTROL_DEPENDENCY_DISABLED' }; [Console]::Out.WriteLine('CIRCLE_CONTROL_PS_MAJOR ' + $PSVersionTable.PSVersion.Major); [Console]::Out.Flush(); ";
const contexts = [
  {
    label: 'before',
    production: oldQuery.script,
    executed: controlled(oldQuery.script),
  },
  {
    label: 'candidate',
    production: newQuery.script,
    executed: controlled(newQuery.script),
  },
  {
    label: 'payload',
    production: payloadBody,
    executed: controlledPrefix + payloadBody,
  },
];
const base = mkdtempSync(join(tmpdir(), 'cqc-'));
const home = join(base, 'home');
mkdirSync(home);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CIRCLE_HOME: home,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: base,
  TMP: base,
  TEMP: base,
};
delete env.NODE_OPTIONS;
delete env.NODE_TEST_CONTEXT;
let child: ReturnType<typeof spawn> | undefined;
let primary: unknown;
let ownedClosed: Promise<void> | undefined;
let ownedExit:
  | { code: number | null; signal: NodeJS.Signals | null; closedUtcMs: number }
  | undefined;
const waitForOwnedClose = async (timeoutMs: number): Promise<boolean> => {
  if (ownedExit) return true;
  if (!ownedClosed) return !child;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ownedClosed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
const exactLineCount = (text: string, expected: string): number =>
  text.split(/\r?\n/).filter((line) => line === expected).length;
const results: { label: string; result: SpawnSyncReturns<string> }[] = [];
try {
  const folder = join(base, 'versions', '0.5.0', 'circle');
  mkdirSync(folder, { recursive: true });
  const program = join(folder, 'circle.exe');
  cpSync(process.execPath, program);
  child = spawn(
    program,
    [
      '-e',
      "process.stdout.write('R'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
    ],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  ownedClosed = new Promise<void>((resolve) => {
    child!.once('close', (code, signal) => {
      ownedExit = { code, signal, closedUtcMs: Date.now() };
      resolve();
    });
  });
  await once(child, 'spawn');
  const [ready] = await once(child.stdout!, 'data', {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(ready.toString(), 'R');
  const pid = child.pid;
  assert.ok(pid);
  save('owned-ready.json', {
    pid,
    ready: 'R',
    executableSha256: hash(readFileSync(program)),
  });
  const canonicalProgram = realpathSync.native(program).toLowerCase();
  const ps = join(
    process.env.SystemRoot || 'C:\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  save('frozen-plan.json', {
    platform: process.platform,
    node: process.version,
    attempts: { before: 1, candidate: 1, payload: 1 },
    order: ['before', 'candidate', 'payload'],
    queryTimeoutMs: 30_000,
    readyTimeoutMs: 15_000,
    backend: 'unchanged Diagnostics.Process.GetProcessesByName',
    names,
    beforeSourceSha256: hash(
      readFileSync(
        new URL('./fixtures/windows-query-before-decoder.ts', import.meta.url),
      ),
    ),
    candidateSourceSha256: hash(
      readFileSync(new URL('../src/windows_process_query.ts', import.meta.url)),
    ),
    sourceBefore: '67d1304a6e686b0f4cb4c0995b43538815eccbae',
    queryMode: 'known names only',
    payloadCases,
    control:
      'same held image, exact names, home and temp; two independent PS5 processes; no stress or timing-equivalence claim',
  });
  for (const { label, production, executed: script } of contexts) {
    assert.equal(child.exitCode, null, 'owned held image remains alive');
    assert.equal(
      child.signalCode,
      null,
      'owned held image has not received an exit signal',
    );
    writeFileSync(join(output, `${label}.production.ps1`), production, {
      flag: 'wx',
    });
    writeFileSync(join(output, `${label}.controlled.ps1`), script, {
      flag: 'wx',
    });
    const startedUtcMs = Date.now();
    const startedMono = performance.now();
    const result = spawnSync(
      ps,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 30_000, env },
    );
    const closedUtcMs = Date.now();
    const elapsedMs = performance.now() - startedMono;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    writeFileSync(join(output, `${label}.stdout.raw`), stdout, { flag: 'wx' });
    writeFileSync(join(output, `${label}.stderr.raw`), stderr, { flag: 'wx' });
    // Durable native outcome before parsing either query result.
    save(`${label}.native-close.json`, {
      label,
      status: result.status,
      signal: result.signal,
      pid: result.pid,
      startedUtcMs,
      closedUtcMs,
      elapsedMs,
      error: result.error
        ? {
            name: result.error.name,
            message: result.error.message,
            code: (result.error as NodeJS.ErrnoException).code,
            stack: result.error.stack,
          }
        : null,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stdoutSha256: hash(stdout),
      stderrSha256: hash(stderr),
      productionScriptSha256: hash(production),
      controlledScriptSha256: hash(script),
    });
    results.push({ label, result });
  }
  // All three native-close receipts/raw streams already exist; expected red is a PID mismatch.
  const parsed = results.slice(0, 2).map(({ label, result }) => {
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const entries = stdout.split(/\r?\n/).flatMap((line) => {
      const match = /^(\d+) ([A-Za-z0-9+/=]+)$/.exec(line.trim());
      return match
        ? [
            {
              pid: Number(match[1]),
              program: Buffer.from(match[2]!, 'base64').toString('utf8'),
            },
          ]
        : [];
    });
    const matches = entries.filter((entry) => {
      if (entry.pid !== pid) return false;
      try {
        return (
          realpathSync.native(entry.program).toLowerCase() === canonicalProgram
        );
      } catch {
        return false;
      }
    });
    return {
      label,
      psMajor5Lines: exactLineCount(stdout, 'CIRCLE_CONTROL_PS_MAJOR 5'),
      controlledJsonCalledLines: exactLineCount(
        stderr,
        'CIRCLE_CONTROL_JSON_CALLED',
      ),
      controlledJsonUnavailableLines: exactLineCount(
        stderr,
        'CIRCLE_CONTROL_JSON_UNAVAILABLE',
      ),
      exactNamesWitnessLines: exactLineCount(
        stderr,
        'CIRCLE_CONTROL_NAMES_EXACT',
      ),
      exactOwnedPidMatches: matches.length,
      nativeStatus: result.status,
      nativeErrorCode:
        (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
      nativeSignal: result.signal,
    };
  });
  save('parsed-observations.json', parsed);
  const old = parsed[0]!;
  const next = parsed[1]!;
  assert.equal(old.psMajor5Lines, 1);
  assert.equal(next.psMajor5Lines, 1);
  assert.equal(old.controlledJsonCalledLines, 1);
  assert.equal(old.controlledJsonUnavailableLines, 1);
  assert.equal(old.exactNamesWitnessLines, 0);
  assert.equal(
    old.nativeErrorCode,
    null,
    'the expected old rejection is not a native spawn timeout',
  );
  assert.equal(old.nativeSignal, null);
  assert.ok(old.nativeStatus === 0 || old.nativeStatus === 1);
  assert.equal(
    old.exactOwnedPidMatches,
    0,
    'old body fails the exact owned-PID contract with the controlled JSON cmdlet',
  );
  assert.equal(next.controlledJsonCalledLines, 0);
  assert.equal(next.controlledJsonUnavailableLines, 0);
  assert.equal(next.exactNamesWitnessLines, 1);
  assert.equal(next.exactOwnedPidMatches, 1);
  assert.equal(next.nativeStatus, 0);
  assert.equal(next.nativeErrorCode, null);
  assert.equal(next.nativeSignal, null);
  const payload = results[2]!.result;
  assert.equal(payload.status, 0);
  assert.equal(payload.error, undefined);
  assert.equal(payload.signal, null);
  assert.equal(exactLineCount(payload.stdout, 'CIRCLE_CONTROL_PS_MAJOR 5'), 1);
  assert.equal(exactLineCount(payload.stderr, 'CIRCLE_CONTROL_JSON_CALLED'), 0);
  assert.equal(
    exactLineCount(payload.stderr, 'CIRCLE_CONTROL_JSON_UNAVAILABLE'),
    0,
  );
  const payloadLines = payload.stdout.split(/\r?\n/);
  const decodedCases = payloadCases.map((values, index) => {
    assert.equal(
      payloadLines.filter(
        (line) => line === `CASE ${index} LENGTH ${values.length}`,
      ).length,
      1,
    );
    const itemPattern = new RegExp(
      `^CASE ${index} ITEM ([0-9]+) ([A-Za-z0-9+/=]*)$`,
    );
    const items = payloadLines.flatMap((line) => {
      const match = itemPattern.exec(line);
      return match
        ? [
            {
              index: Number(match[1]),
              value: Buffer.from(match[2]!, 'base64').toString('utf8'),
            },
          ]
        : [];
    });
    assert.deepEqual(
      items,
      values.map((value, itemIndex) => ({ index: itemIndex, value })),
    );
    return { index, values, exact: true };
  });
  save('payload-acceptance.json', decodedCases);
  save('acceptance.json', {
    oldRed: { controlledDependencyInvoked: true, exactOwnedPidMatches: 0 },
    candidateGreen: { namesExact: true, exactOwnedPidMatches: 1, status: 0 },
    attempts: 3,
    payloadCasesExact: decodedCases.length,
    queryTimeoutMs: 30_000,
    retries: 0,
    causeOfHistorical115: 'unknown',
    limits: [
      'controlled dependency-unavailable reproduction, not historical30s-cause proof',
      'witness affects both controlled bodies; no performance claim',
      'separate PS process per body, same held fixture and temp context',
    ],
  });
} catch (error) {
  primary = error;
  console.error(error);
  save('primary-error.json', {
    name: error instanceof Error ? error.name : 'unknown',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = 1;
} finally {
  const errors: string[] = [];
  let gracefulWaitTimedOut = false;
  let killAttempted = false;
  let killAccepted: boolean | null = null;
  if (child && !ownedExit) {
    try {
      child.stdin?.end();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (!(await waitForOwnedClose(15_000))) {
      gracefulWaitTimedOut = true;
      errors.push(
        'Owned child close was not observed within the graceful 15 second wait',
      );
      if (child.exitCode === null && child.signalCode === null) {
        killAttempted = true;
        try {
          killAccepted = child.kill();
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
        if (killAccepted !== true)
          errors.push('Owned child did not accept termination');
      }
      if (!(await waitForOwnedClose(15_000)))
        errors.push(
          'Owned child close was not observed after the bounded termination wait',
        );
    }
  }
  const safeToRemoveScratch = !child || ownedExit !== undefined;
  let scratchRemoved = false;
  if (safeToRemoveScratch) {
    try {
      rmSync(base, { recursive: true, force: true });
      scratchRemoved = true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    errors.push('Scratch retained because owned child exit was not observed');
  }
  save('cleanup.json', {
    primaryPresent: primary !== undefined,
    errors,
    gracefulWaitTimedOut,
    killAttempted,
    killAccepted,
    ownedCloseObserved: ownedExit !== undefined,
    ownedExit: ownedExit ?? null,
    scratchRemoved,
    scratchRetained: !scratchRemoved,
  });
  if (errors.length) process.exitCode = 1;
}
