// Diagnostic-branch-only preload. Never import this from production entry points.
import childProcess, { type SpawnSyncReturns } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { availableParallelism } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Stage = 'DECODE' | 'LOOKUP' | 'MODULE' | 'DISPOSE' | 'COMPLETE';
const stages: Stage[] = ['DECODE', 'LOOKUP', 'MODULE', 'DISPOSE', 'COMPLETE'];
const prefix =
  "$circleNames = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('";
const separator = "')) | ConvertFrom-Json); $circleProcesses = @(";
const ending =
  '); foreach ($circleProcess in $circleProcesses) { try { ' +
  '$circlePath = $circleProcess.MainModule.FileName; if ($circlePath) { ' +
  '"$($circleProcess.Id) $([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($circlePath)))" ' +
  '} } catch {} finally { $circleProcess.Dispose() } }';
const byName =
  'foreach ($circleName in $circleNames) { [Diagnostics.Process]::GetProcessesByName($circleName) }';
const all = '[Diagnostics.Process]::GetProcesses()';
export const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

// Only the current, complete production body is recognized; unknown scripts pass through.
export function instrumentQuery(
  script: string,
  nonce: string,
): string | undefined {
  if (!/^[a-f0-9]{32}$/.test(nonce) || !script.startsWith(prefix)) return;
  const rest = script.slice(prefix.length);
  const split = rest.indexOf(separator);
  if (split < 0 || !/^[A-Za-z0-9+/=]+$/.test(rest.slice(0, split))) return;
  const lookup = rest.slice(split + separator.length, -ending.length);
  if (!script.endsWith(ending) || (lookup !== byName && lookup !== all)) return;
  // Markers precede original commands. In particular Dispose remains finally's last
  // command, and no marker sits between the lookup assignment and the foreach.
  const mark = (stage: Stage): string =>
    `try { $circleDiagnosticCounts['${stage}'] = 1 + $circleDiagnosticCounts['${stage}']; if ($circleDiagnosticCounts['${stage}'] -le 32) { [Console]::Error.WriteLine('CIRCLE_DIAG_${nonce} ${stage} ' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); [Console]::Error.Flush() } } catch {}; `;
  const lookupMarked =
    lookup === all
      ? `${mark('LOOKUP')}${all}`
      : byName.replace(
          '[Diagnostics.Process]::GetProcessesByName',
          `${mark('LOOKUP')}[Diagnostics.Process]::GetProcessesByName`,
        );
  const body = script
    .replace(lookup, lookupMarked)
    .replace(
      '$circlePath = $circleProcess.MainModule.FileName;',
      `${mark('MODULE')}$circlePath = $circleProcess.MainModule.FileName;`,
    )
    .replace(
      '$circleProcess.Dispose()',
      `${mark('DISPOSE')}$circleProcess.Dispose()`,
    );
  // Save the original final statement's status before any after-query observation.
  return (
    '$circleDiagnosticCounts = @{}; ' +
    mark('DECODE') +
    body +
    `; $circleDiagnosticSuccess = $?; ${mark('COMPLETE')}if ($circleDiagnosticSuccess) { exit 0 } else { exit 1 }`
  );
}

export function extractStages(stderr: string, nonce: string) {
  const counts = Object.fromEntries(
    stages.map((stage) => [stage, 0]),
  ) as Record<Stage, number>;
  const first: Partial<Record<Stage, number>> = {};
  const last: Partial<Record<Stage, number>> = {};
  let lastReached: Stage | 'unknown' = 'unknown';
  let cleaned = '';
  // Split while retaining every non-marker byte, including the original CRLF.
  for (const line of stderr.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const text = line.endsWith('\n')
      ? line.slice(0, -1).replace(/\r$/, '')
      : undefined;
    const match = text?.match(
      new RegExp(
        `^CIRCLE_DIAG_${nonce} (DECODE|LOOKUP|MODULE|DISPOSE|COMPLETE) ([0-9]+)$`,
      ),
    );
    const at = match ? Number(match[2]) : NaN;
    if (!match || !Number.isSafeInteger(at) || at < 0) {
      cleaned += line;
      continue;
    }
    const stage = match[1] as Stage;
    counts[stage]++;
    first[stage] ??= at;
    last[stage] = at;
    lastReached = stage;
  }
  return { cleaned, counts, first, last, lastReached };
}

export interface QueryReport {
  originalQuerySha256: string;
  executedQuerySha256: string;
  elapsedMs: number;
  parentStartUtcMs: number;
  parentEndUtcMs: number;
  status: number | null;
  signal: string | null;
  errorCode: string | 'unknown';
  stdoutBytes: number;
  stdoutSha256: string;
  markerLimitPerStage: number;
  possiblyCappedStages: Stage[];
  clockConsistent: boolean;
  beforeFirstScriptTimestampMs: number | 'unknown';
  afterLastScriptTimestampMs: number | 'unknown';
  counts: Record<Stage, number>;
  first: Partial<Record<Stage, number>>;
  last: Partial<Record<Stage, number>>;
  lastReached: Stage | 'unknown';
}
type Spawn = typeof childProcess.spawnSync;
export function observeSpawnSync(
  native: Spawn,
  report: (value: QueryReport) => void,
): Spawn {
  return ((...input: Parameters<Spawn>) => {
    const [command, args, options] = input;
    if (
      !Array.isArray(args) ||
      args.length !== 4 ||
      args[0] !== '-NoProfile' ||
      args[1] !== '-NonInteractive' ||
      args[2] !== '-Command' ||
      typeof args[3] !== 'string' ||
      !/powershell\.exe$/i.test(command) ||
      options?.encoding !== 'utf8' ||
      options.timeout !== 30_000
    )
      return native(...input);
    const nonce = randomBytes(16).toString('hex');
    const executed = instrumentQuery(args[3], nonce);
    if (!executed) return native(...input);
    const started = performance.now();
    const parentStartUtcMs = Date.now();
    const result = native(
      command,
      [...args.slice(0, -1), executed],
      options,
    ) as SpawnSyncReturns<string>;
    const parentEndUtcMs = Date.now();
    const elapsedMs = performance.now() - started;
    const parsed = extractStages(
      typeof result.stderr === 'string' ? result.stderr : '',
      nonce,
    );
    const firstAt = parsed.first.DECODE;
    const lastAt = parsed.last.COMPLETE;
    const clockConsistent =
      Math.abs(parentEndUtcMs - parentStartUtcMs - elapsedMs) <= 100 &&
      Object.values(parsed.first).every(
        (at) => at >= parentStartUtcMs && at <= parentEndUtcMs,
      ) &&
      Object.values(parsed.last).every(
        (at) => at >= parentStartUtcMs && at <= parentEndUtcMs,
      ) &&
      (firstAt === undefined || lastAt === undefined || lastAt >= firstAt);
    // Report writes and metadata failures cannot replace the original native result.
    try {
      report({
        originalQuerySha256: sha256(args[3]),
        executedQuerySha256: sha256(executed),
        elapsedMs,
        parentStartUtcMs,
        parentEndUtcMs,
        status: result.status,
        signal: result.signal,
        errorCode:
          typeof (result.error as NodeJS.ErrnoException | undefined)?.code ===
          'string'
            ? (result.error as NodeJS.ErrnoException).code!
            : 'unknown',
        stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
        stdoutSha256: sha256(result.stdout ?? ''),
        markerLimitPerStage: 32,
        possiblyCappedStages: stages.filter(
          (stage) => parsed.counts[stage] >= 32,
        ),
        clockConsistent,
        beforeFirstScriptTimestampMs:
          clockConsistent && firstAt !== undefined
            ? firstAt - parentStartUtcMs
            : 'unknown',
        afterLastScriptTimestampMs:
          clockConsistent && lastAt !== undefined
            ? parentEndUtcMs - lastAt
            : 'unknown',
        counts: parsed.counts,
        first: parsed.first,
        last: parsed.last,
        lastReached: parsed.lastReached,
      });
    } catch {
      /* Observation must not change the caller's outcome. */
    }
    const output = Array.isArray(result.output)
      ? result.output.map((part, index) =>
          index === 2 && typeof part === 'string'
            ? extractStages(part, nonce).cleaned
            : part,
        )
      : result.output;
    return {
      ...result,
      stderr:
        typeof result.stderr === 'string' ? parsed.cleaned : result.stderr,
      output,
    };
  }) as Spawn;
}

const installed = Symbol.for('circle.diagnostic.legacy-query-observer');
const globalState = globalThis as typeof globalThis & { [installed]?: boolean };
const folder = process.env.CIRCLE_LEGACY_DIAG_OUTPUT;
if (
  process.platform === 'win32' &&
  process.env.CIRCLE_LEGACY_DIAG_PRELOAD === '1' &&
  folder &&
  !globalState[installed]
) {
  globalState[installed] = true;
  const contextId = randomBytes(12).toString('hex');
  const role = process.argv.some((value) =>
    /(?:^|[\\/])install_manager\.ts$/.test(value),
  )
    ? 'install-manager'
    : basename(process.execPath).toLowerCase() === 'circle.exe'
      ? 'synthetic-held-copy'
      : 'node-context';
  let sequence = 0;
  const write = (value: unknown): void =>
    writeFileSync(
      join(folder, `${contextId}-${sequence++}.json`),
      JSON.stringify(value, null, 2) + '\n',
      { flag: 'wx' },
    );
  try {
    mkdirSync(folder, { recursive: true });
    write({
      kind: 'loaded',
      contextId,
      role,
      availableParallelism: availableParallelism(),
      observerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    });
  } catch {
    /* Do not break the original copied-child handshake or any CLI output. */
  }
  childProcess.spawnSync = observeSpawnSync(childProcess.spawnSync, (value) =>
    write({ kind: 'query', contextId, role, sequence, ...value }),
  );
  syncBuiltinESMExports();
}
