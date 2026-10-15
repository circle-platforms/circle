// One frozen, synthetic two-context experiment; not an installer entry point.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  findPythonCopies,
  runningCopies,
  type Surroundings,
} from '../src/legacy_install.js';
import { observeSpawnSync, sha256 } from './windows-legacy-query-observer.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.CIRCLE_LEGACY_DIAG_OUTPUT;
if (!output) throw new Error('diagnostic output is required');
mkdirSync(output, { recursive: true });
const save = (name: string, value: unknown): void =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });

async function isolated(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'cq-'));
  let child: ReturnType<typeof spawn> | undefined;
  let hadPrimary = false;
  let phase = 'setup';
  try {
    const prefix = join(base, 'copy');
    const version = join(prefix, 'versions', '0.5.0');
    const folder = join(version, 'circle');
    mkdirSync(folder, { recursive: true });
    const frozen = join(folder, 'circle.exe');
    cpSync(process.execPath, frozen);
    symlinkSync(version, join(prefix, 'current'), 'junction');
    child = spawn(
      frozen,
      [
        '-e',
        "process.stdout.write('R'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
      ],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, CIRCLE_LEGACY_DIAG_PRELOAD: '0' },
      },
    );
    await once(child, 'spawn');
    const [ready] = await once(child.stdout!, 'data', {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(
      ready.toString(),
      'R',
      'the owned copied program reached its code',
    );
    const where: Surroundings = {
      platform: 'win32',
      home: join(base, 'home'),
      localAppData: join(base, 'appdata'),
      path: join(prefix, 'current', 'circle'),
    };
    let calls = 0;
    const observed = observeSpawnSync(spawnSync, (value) =>
      save('isolated-query.json', value),
    );
    phase = 'query';
    const result = runningCopies(
      findPythonCopies(where),
      where,
      (command, args, timeout) => {
        calls++;
        return observed(command, args, { encoding: 'utf8', timeout });
      },
    );
    phase = 'assertions';
    assert.equal(calls, 1, 'exactly one real query in this isolated fixture');
    assert.deepEqual(result, [child.pid]);
    save('isolated-assertions.json', {
      ready: true,
      queryCalls: calls,
      ownedProgramMatched: true,
    });
  } catch (primary) {
    hadPrimary = true;
    // The original query/setup/assertion error is durable in the parent's raw
    // stderr before cleanup can fail. Do not replace it with a cleanup error.
    console.error(`ISOLATED_PRIMARY_PHASE ${phase}`);
    console.error(primary);
    throw primary;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        if (!child.kill())
          throw new Error('owned child did not accept termination');
        await closed;
      }
    } catch (secondary) {
      cleanupErrors.push(secondary);
    }
    try {
      rmSync(base, { recursive: true, force: true });
    } catch (secondary) {
      cleanupErrors.push(secondary);
    }
    if (cleanupErrors.length) {
      console.error('ISOLATED_CLEANUP_FAILED');
      if (!hadPrimary)
        throw new AggregateError(cleanupErrors, 'isolated cleanup failed');
    }
  }
}

async function collect(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'cd-'));
  const preload = pathToFileURL(
    join(root, 'scripts', 'windows-legacy-query-observer.ts'),
  ).href;
  const originalInputs = [
    'src/legacy_install.ts',
    'src/install_manager.ts',
    'tests/legacy-install.test.ts',
    'package.json',
    'package-lock.json',
    'scripts/windows-legacy-query-observer.ts',
  ];
  save('frozen-plan.json', {
    contexts: ['full-check', 'isolated-held-copy'],
    observerUnitStage: 'after both query contexts, once',
    attemptsPerContext: 1,
    queryTimeoutMs: 30_000,
    readyTimeoutMs: 15_000,
    originalManagerTimeoutMs: 60_000,
    nativePlatform: process.platform,
    node: process.version,
    source: Object.fromEntries(
      originalInputs.map((name) => [
        name,
        sha256(readFileSync(join(root, name))),
      ]),
    ),
    limits: [
      'stage markers mean reached, not success',
      'lookup includes native internal work',
      'preload also loads in inherited synthetic child contexts',
      'no retry or fallback',
    ],
  });
  const results: {
    context: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnError: boolean;
  }[] = [];
  // Full FIRST: isolated lookup must not prewarm the full-suite context.
  for (const context of ['full-check', 'isolated-held-copy', 'observer-unit']) {
    const folder = join(output!, context);
    const temp = join(base, context);
    mkdirSync(folder, { recursive: true });
    mkdirSync(temp, { recursive: true });
    const stdout = join(folder, 'stdout.raw');
    const stderr = join(folder, 'stderr.raw');
    const out = openSync(stdout, 'wx');
    const err = openSync(stderr, 'wx');
    const home = join(temp, 'home');
    mkdirSync(home);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CIRCLE_HOME: home,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      CIRCLE_LEGACY_DIAG_OUTPUT: folder,
      CIRCLE_LEGACY_DIAG_PRELOAD: context === 'full-check' ? '1' : '0',
      NODE_OPTIONS:
        context === 'full-check'
          ? `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`.trim()
          : process.env.NODE_OPTIONS,
    };
    const started = Date.now();
    const child =
      context === 'full-check'
        ? spawn(
            process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
            ['/d', '/s', '/c', 'npm.cmd run check'],
            { cwd: root, env, stdio: ['ignore', out, err] },
          )
        : context === 'isolated-held-copy'
          ? spawn(
              process.execPath,
              ['--import', 'tsx', fileURLToPath(import.meta.url), 'isolated'],
              { cwd: root, env, stdio: ['ignore', out, err] },
            )
          : spawn(
              process.execPath,
              [
                '--import',
                'tsx',
                '--test',
                join(root, 'scripts', 'windows-legacy-query-observer.test.ts'),
              ],
              { cwd: root, env, stdio: ['ignore', out, err] },
            );
    let spawnError = false;
    child.once('error', () => {
      spawnError = true;
    });
    const [code, signal] = await new Promise<
      [number | null, NodeJS.Signals | null]
    >((resolve) =>
      child.once('close', (code, signal) => resolve([code, signal])),
    );
    closeSync(out);
    closeSync(err);
    // Synchronous native receipt FIRST. No TAP/report parsing occurs above this point.
    const receipt = {
      context,
      code,
      signal,
      spawnError,
      startedUtcMs: started,
      closedUtcMs: Date.now(),
      stdoutSha256: sha256(readFileSync(stdout)),
      stderrSha256: sha256(readFileSync(stderr)),
    };
    writeFileSync(
      join(folder, 'native-close.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      { flag: 'wx' },
    );
    results.push(receipt);
    console.log(JSON.stringify({ context, code, signal, spawnError }));
  }
  // Parse diagnostic evidence only after BOTH original native results are durable.
  let evidenceValid = true;
  const fullQueries: unknown[] = [];
  const fullFolder = join(output!, 'full-check');
  for (const name of readdirSync(fullFolder).filter(
    (name) => name.endsWith('.json') && name !== 'native-close.json',
  )) {
    try {
      const value = JSON.parse(readFileSync(join(fullFolder, name), 'utf8'));
      if (value.kind === 'query') fullQueries.push(value);
    } catch {
      evidenceValid = false;
    }
  }
  if (!fullQueries.length) evidenceValid = false;
  try {
    JSON.parse(
      readFileSync(
        join(output!, 'isolated-held-copy', 'isolated-query.json'),
        'utf8',
      ),
    );
  } catch {
    evidenceValid = false;
  }
  save('summary.json', {
    results,
    evidenceValid,
    fullVisibleFileReports: fullQueries.length,
    evidenceFiles: readdirSync(output!),
    observationOnly: true,
    causeOf115: 'unknown',
  });
  if (
    !evidenceValid ||
    results.some((result) => result.code !== 0 || result.spawnError)
  )
    process.exitCode = 1;
  rmSync(base, { recursive: true, force: true });
}

if (process.platform !== 'win32') {
  console.error('UNSUPPORTED_PLATFORM');
  process.exitCode = 1;
} else if (process.argv.at(-1) === 'isolated') {
  await isolated();
} else {
  await collect();
}
