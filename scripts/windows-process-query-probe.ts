// Opt-in preload for one Windows process-query observation. It does not retry the query.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { win32 } from 'node:path';

type RequestedLookupKind =
  'cim-all' | 'native-names' | 'native-all' | 'unknown';
type ProbeOptions = Readonly<{
  queryScript?: string;
  forbidCim?: boolean;
  windowsHide?: boolean;
}>;

export type ProcessQueryProbeReport = Readonly<{
  parentPid: number;
  sequence: number;
  helperReportedPid: number | 'unknown';
  status: number | null | 'unknown';
  signal: string | null | 'unknown';
  errorCode: string | 'unknown';
  elapsedMs: number;
  pipelineElapsedMs: number | 'unknown';
  parentStartedUtcMs: number | 'unknown';
  parentCompletedUtcMs: number | 'unknown';
  scriptEnteredUtcMs: number | 'unknown';
  scriptCompletedUtcMs: number | 'unknown';
  beforeFirstScriptTimestampMs: number | 'unknown';
  afterLastScriptTimestampMs: number | 'unknown';
  phaseClockCheck: 'passed' | 'unknown';
  stdoutCodeUnits: number;
  stderrCodeUnits: number;
  scriptEnteredObserved: boolean;
  pipelineCompletedObserved: boolean;
  requestedLookupKind: RequestedLookupKind;
  lookupKind: RequestedLookupKind | 'win32-image';
  queryTransformed: boolean;
  originalQuerySha256: string;
  effectiveQuerySha256: string;
  executedScriptSha256: string;
  requestedWindowsHide: boolean | 'default';
  effectiveWindowsHide: boolean;
}>;

function cleanMarkers(
  stderr: string,
  entered: string,
  completed: string,
  metric: string,
  enteredUtc: string,
  completedUtc: string,
) {
  let start = 0;
  let cleaned = '';
  let scriptEnteredObserved = false;
  let pipelineCompletedObserved = false;
  let pipelineElapsedMs: number | 'unknown' = 'unknown';
  let metricCount = 0;
  const utc = new Map<string, { count: number; value: number | 'unknown' }>([
    [enteredUtc, { count: 0, value: 'unknown' }],
    [completedUtc, { count: 0, value: 'unknown' }],
  ]);
  while (start < stderr.length) {
    const end = stderr.indexOf('\n', start);
    if (end === -1) {
      const tail = stderr.slice(start);
      for (const [name, entry] of utc)
        if (tail === name || tail.startsWith(`${name} `)) entry.count++;
      cleaned += tail;
      break;
    }
    const raw = stderr.slice(start, end + 1);
    const line = raw.slice(0, raw.endsWith('\r\n') ? -2 : -1);
    const utcName = [...utc.keys()].find(
      (name) => line === name || line.startsWith(`${name} `),
    );
    if (utcName) {
      const entry = utc.get(utcName)!;
      entry.count++;
      const value = line.slice(utcName.length + 1);
      const parsed = /^\d+(?![\s\S])/.test(value) ? Number(value) : NaN;
      if (Number.isSafeInteger(parsed) && parsed >= 0) entry.value = parsed;
      else {
        entry.value = 'unknown';
        cleaned += raw;
      }
    } else if (line === entered) scriptEnteredObserved = true;
    else if (line === completed) pipelineCompletedObserved = true;
    else {
      const value = line.startsWith(`${metric} `)
        ? line.slice(metric.length + 1)
        : '';
      const elapsed = /^\d+(?![\s\S])/.test(value) ? Number(value) : NaN;
      if (Number.isSafeInteger(elapsed) && elapsed >= 0) {
        metricCount++;
        pipelineElapsedMs = metricCount === 1 ? elapsed : 'unknown';
      } else cleaned += raw;
    }
    start = end + 1;
  }
  return {
    cleaned,
    scriptEnteredObserved,
    pipelineCompletedObserved,
    pipelineElapsedMs,
    scriptEnteredUtcMs:
      utc.get(enteredUtc)!.count === 1 ? utc.get(enteredUtc)!.value : 'unknown',
    scriptCompletedUtcMs:
      utc.get(completedUtc)!.count === 1
        ? utc.get(completedUtc)!.value
        : 'unknown',
  };
}

export function instrumentSpawnSync(
  original: typeof childProcess.spawnSync,
  report: (evidence: ProcessQueryProbeReport) => void,
  probeOptions: ProbeOptions = {},
): typeof childProcess.spawnSync {
  const nonce = randomUUID().replaceAll('-', '');
  let sequence = 0;
  return ((...parameters: unknown[]) => {
    const [command, args, options] = parameters;
    if (
      typeof command !== 'string' ||
      win32.basename(command).toLowerCase() !== 'powershell.exe' ||
      !Array.isArray(args) ||
      !options ||
      typeof options !== 'object' ||
      !('encoding' in options) ||
      options.encoding !== 'utf8'
    )
      return Reflect.apply(original, childProcess, parameters);
    const commandIndex = args.findIndex(
      (arg) => typeof arg === 'string' && arg.toLowerCase() === '-command',
    );
    const script = args[commandIndex + 1];
    if (commandIndex === -1 || typeof script !== 'string')
      return Reflect.apply(original, childProcess, parameters);
    const requestedLookupKind =
      /Get-CimInstance\s+-ClassName\s+Win32_Process\b/i.test(script)
        ? 'cim-all'
        : /\[Diagnostics\.Process\]::GetProcessesByName\(/i.test(script)
          ? 'native-names'
          : /\[Diagnostics\.Process\]::GetProcesses\(\)/i.test(script)
            ? 'native-all'
            : 'unknown';
    if (requestedLookupKind === 'unknown')
      return Reflect.apply(original, childProcess, parameters);

    const candidateSelected = probeOptions.queryScript !== undefined;
    const effectiveScript = candidateSelected
      ? (probeOptions.forbidCim
          ? "function Get-CimInstance { throw 'CIM is unavailable in this synthetic probe' };\n"
          : '') + probeOptions.queryScript
      : script;
    const requestedWindowsHide =
      'windowsHide' in options && typeof options.windowsHide === 'boolean'
        ? options.windowsHide
        : 'default';
    const effectiveOptions =
      probeOptions.windowsHide === undefined
        ? options
        : { ...options, windowsHide: probeOptions.windowsHide };
    const current = ++sequence;
    const entered = `CIRCLE_QUERY_PROBE_${nonce}_${current}_ENTERED`;
    const completed = `CIRCLE_QUERY_PROBE_${nonce}_${current}_COMPLETED`;
    const metric = `CIRCLE_QUERY_PROBE_${nonce}_${current}_PIPELINE_MS`;
    const enteredUtc = `${entered}_UTC_MS`;
    const completedUtc = `${completed}_UTC_MS`;
    const success = `$circleQueryProbeSuccess_${nonce}_${current}`;
    const clock = `$circleQueryProbeClock_${nonce}_${current}`;
    const mark = (marker: string) =>
      `try { [Console]::Error.WriteLine('${marker}'); [Console]::Error.Flush() } catch {}`;
    const markUtc = (marker: string) =>
      `try { [Console]::Error.WriteLine('${marker} ' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString([Globalization.CultureInfo]::InvariantCulture)); [Console]::Error.Flush() } catch {}`;
    const instrumentedArgs = [...args];
    const executedScript =
      `${markUtc(enteredUtc)};\n${mark(entered)};\n` +
      `try { ${clock} = $null; ${clock} = [Diagnostics.Stopwatch]::StartNew() } catch {};\n` +
      `${effectiveScript}\n${success} = $?;\n` +
      `try { if ($null -ne ${clock}) { ${clock}.Stop(); ` +
      `[Console]::Error.WriteLine('${metric} ' + ${clock}.ElapsedMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture)); ` +
      `[Console]::Error.Flush() } } catch {};\n` +
      `${mark(completed)};\n${markUtc(completedUtc)};\n` +
      `if (${success}) { exit 0 } else { exit 1 }`;
    instrumentedArgs[commandIndex + 1] = executedScript;
    const parentStarted = Date.now();
    const started = performance.now();
    const result = Reflect.apply(original, childProcess, [
      command,
      instrumentedArgs,
      effectiveOptions,
    ]) as ReturnType<typeof childProcess.spawnSync>;
    const monotonicElapsedMs = performance.now() - started;
    const elapsedMs = Math.max(0, Math.round(monotonicElapsedMs));
    const parentCompleted = Date.now();
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const markers = cleanMarkers(
      stderr,
      entered,
      completed,
      metric,
      enteredUtc,
      completedUtc,
    );
    const { scriptEnteredUtcMs, scriptCompletedUtcMs } = markers;
    const safeUtc = (value: number) =>
      Number.isSafeInteger(value) && value >= 0;
    // These intervals include timestamp evaluation/marker work and scheduling.
    // The 100ms check rejects obvious clock inconsistency, not every clock adjustment.
    const phaseConsistent =
      Number.isFinite(monotonicElapsedMs) &&
      monotonicElapsedMs >= 0 &&
      safeUtc(parentStarted) &&
      safeUtc(parentCompleted) &&
      typeof scriptEnteredUtcMs === 'number' &&
      typeof scriptCompletedUtcMs === 'number' &&
      parentStarted <= scriptEnteredUtcMs &&
      scriptEnteredUtcMs <= scriptCompletedUtcMs &&
      scriptCompletedUtcMs <= parentCompleted &&
      Math.abs(parentCompleted - parentStarted - elapsedMs) <= 100 &&
      (typeof markers.pipelineElapsedMs !== 'number' ||
        markers.pipelineElapsedMs <=
          scriptCompletedUtcMs - scriptEnteredUtcMs + 100);
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    try {
      report(
        Object.freeze({
          parentPid: process.pid,
          sequence: current,
          helperReportedPid: Number.isSafeInteger(result.pid)
            ? result.pid
            : 'unknown',
          status:
            result.status === null || Number.isSafeInteger(result.status)
              ? result.status
              : 'unknown',
          signal:
            result.signal === null
              ? null
              : typeof result.signal === 'string' &&
                  /^SIG[A-Z0-9]{1,20}$/.test(result.signal)
                ? result.signal
                : 'unknown',
          errorCode:
            typeof errorCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(errorCode)
              ? errorCode
              : 'unknown',
          elapsedMs,
          parentStartedUtcMs: safeUtc(parentStarted)
            ? parentStarted
            : 'unknown',
          parentCompletedUtcMs: safeUtc(parentCompleted)
            ? parentCompleted
            : 'unknown',
          scriptEnteredUtcMs,
          scriptCompletedUtcMs,
          beforeFirstScriptTimestampMs: phaseConsistent
            ? scriptEnteredUtcMs - parentStarted
            : 'unknown',
          afterLastScriptTimestampMs: phaseConsistent
            ? parentCompleted - scriptCompletedUtcMs
            : 'unknown',
          phaseClockCheck: phaseConsistent ? 'passed' : 'unknown',
          pipelineElapsedMs: markers.pipelineElapsedMs,
          stdoutCodeUnits: stdout.length,
          stderrCodeUnits: stderr.length,
          scriptEnteredObserved: markers.scriptEnteredObserved,
          pipelineCompletedObserved: markers.pipelineCompletedObserved,
          requestedLookupKind,
          lookupKind: candidateSelected ? 'win32-image' : requestedLookupKind,
          queryTransformed: effectiveScript !== script,
          originalQuerySha256: createHash('sha256')
            .update(script)
            .digest('hex'),
          effectiveQuerySha256: createHash('sha256')
            .update(effectiveScript)
            .digest('hex'),
          executedScriptSha256: createHash('sha256')
            .update(executedScript)
            .digest('hex'),
          requestedWindowsHide,
          effectiveWindowsHide:
            probeOptions.windowsHide ?? requestedWindowsHide === true,
        }),
      );
    } catch {
      // An observation must never replace the original query outcome.
    }
    if (typeof result.stderr !== 'string' || markers.cleaned === stderr)
      return result;
    const output = [...result.output];
    if (typeof output[2] === 'string')
      output[2] = cleanMarkers(
        output[2],
        entered,
        completed,
        metric,
        enteredUtc,
        completedUtc,
      ).cleaned;
    return { ...result, output, stderr: markers.cleaned };
  }) as typeof childProcess.spawnSync;
}

const installed = Symbol.for('circle.windows-query-probe.installed');
if (
  process.platform === 'win32' &&
  process.env.CIRCLE_QUERY_PROBE === '1' &&
  !Reflect.get(childProcess.spawnSync, installed)
) {
  let probeOptions: ProbeOptions =
    process.env.CIRCLE_QUERY_PROBE_HIDE_WINDOWS === '1'
      ? { windowsHide: true }
      : {};
  if (process.env.CIRCLE_QUERY_PROBE_NATIVE === '1') {
    const candidate = await import(
      new URL('../src/windows_native_process_query.ts', import.meta.url).href
    );
    if (typeof candidate.WINDOWS_NATIVE_PROCESS_QUERY !== 'string')
      throw new TypeError(
        'The native process query probe script must be a string',
      );
    probeOptions = {
      ...probeOptions,
      queryScript: candidate.WINDOWS_NATIVE_PROCESS_QUERY,
      forbidCim: true,
    };
  }
  childProcess.spawnSync = instrumentSpawnSync(
    childProcess.spawnSync,
    (entry) => {
      process.stderr.write(`CIRCLE_QUERY_PROBE ${JSON.stringify(entry)}\n`);
    },
    probeOptions,
  );
  Reflect.set(childProcess.spawnSync, installed, true);
  syncBuiltinESMExports();
}
