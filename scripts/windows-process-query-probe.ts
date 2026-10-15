// Opt-in preload for one Windows process-query observation. It does not retry the query.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';

export type ProcessQueryProbeReport = Readonly<{
  parentPid: number;
  sequence: number;
  helperReportedPid: number | 'unknown';
  status: number | null | 'unknown';
  signal: string | null | 'unknown';
  errorCode: string | 'unknown';
  elapsedMs: number;
  stdoutCodeUnits: number;
  stderrCodeUnits: number;
  scriptEnteredObserved: boolean;
  pipelineCompletedObserved: boolean;
  lookupKind: 'cim-all' | 'native-names' | 'native-all' | 'unknown';
}>;

function cleanMarkers(stderr: string, entered: string, completed: string) {
  let start = 0;
  let cleaned = '';
  let scriptEnteredObserved = false;
  let pipelineCompletedObserved = false;
  while (start < stderr.length) {
    const end = stderr.indexOf('\n', start);
    if (end === -1) {
      cleaned += stderr.slice(start);
      break;
    }
    const raw = stderr.slice(start, end + 1);
    const line = raw.slice(0, raw.endsWith('\r\n') ? -2 : -1);
    if (line === entered) scriptEnteredObserved = true;
    else if (line === completed) pipelineCompletedObserved = true;
    else cleaned += raw;
    start = end + 1;
  }
  return { cleaned, scriptEnteredObserved, pipelineCompletedObserved };
}

export function instrumentSpawnSync(
  original: typeof childProcess.spawnSync,
  report: (evidence: ProcessQueryProbeReport) => void,
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
    const lookupKind = /Get-CimInstance\s+-ClassName\s+Win32_Process\b/i.test(
      script,
    )
      ? 'cim-all'
      : /\[Diagnostics\.Process\]::GetProcessesByName\(/i.test(script)
        ? 'native-names'
        : /\[Diagnostics\.Process\]::GetProcesses\(\)/i.test(script)
          ? 'native-all'
          : 'unknown';
    if (lookupKind === 'unknown')
      return Reflect.apply(original, childProcess, parameters);

    const current = ++sequence;
    const entered = `CIRCLE_QUERY_PROBE_${nonce}_${current}_ENTERED`;
    const completed = `CIRCLE_QUERY_PROBE_${nonce}_${current}_COMPLETED`;
    const success = `$circleQueryProbeSuccess_${nonce}_${current}`;
    const mark = (marker: string) =>
      `try { [Console]::Error.WriteLine('${marker}'); [Console]::Error.Flush() } catch {}`;
    const instrumentedArgs = [...args];
    instrumentedArgs[commandIndex + 1] =
      `${mark(entered)};\n${script}\n` +
      `${success} = $?;\n${mark(completed)};\n` +
      `if (${success}) { exit 0 } else { exit 1 }`;
    const started = performance.now();
    const result = Reflect.apply(original, childProcess, [
      command,
      instrumentedArgs,
      options,
    ]) as ReturnType<typeof childProcess.spawnSync>;
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const markers = cleanMarkers(stderr, entered, completed);
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
          elapsedMs: Math.max(0, Math.round(performance.now() - started)),
          stdoutCodeUnits: stdout.length,
          stderrCodeUnits: stderr.length,
          scriptEnteredObserved: markers.scriptEnteredObserved,
          pipelineCompletedObserved: markers.pipelineCompletedObserved,
          lookupKind,
        }),
      );
    } catch {
      // An observation must never replace the original query outcome.
    }
    if (typeof result.stderr !== 'string' || markers.cleaned === stderr)
      return result;
    const output = [...result.output];
    if (typeof output[2] === 'string')
      output[2] = cleanMarkers(output[2], entered, completed).cleaned;
    return { ...result, output, stderr: markers.cleaned };
  }) as typeof childProcess.spawnSync;
}

const installed = Symbol.for('circle.windows-query-probe.installed');
if (
  process.platform === 'win32' &&
  process.env.CIRCLE_QUERY_PROBE === '1' &&
  !Reflect.get(childProcess.spawnSync, installed)
) {
  childProcess.spawnSync = instrumentSpawnSync(
    childProcess.spawnSync,
    (entry) => {
      process.stderr.write(`CIRCLE_QUERY_PROBE ${JSON.stringify(entry)}\n`);
    },
  );
  Reflect.set(childProcess.spawnSync, installed, true);
  syncBuiltinESMExports();
}
