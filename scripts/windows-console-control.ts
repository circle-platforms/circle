// Run after the full check: compiling this helper beforehand could warm PowerShell.
// A console association or WS_VISIBLE style does not establish what a person can see.
import { spawnSync } from 'node:child_process';
import { win32, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTROL = `Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CircleConsoleControl
{
    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);
    public static string Read()
    {
        IntPtr window = GetConsoleWindow();
        bool associated = window != IntPtr.Zero;
        bool visible = associated && IsWindowVisible(window);
        return (associated ? "true" : "false") + " " + (visible ? "true" : "false");
    }
}
'@
[Console]::Out.WriteLine([CircleConsoleControl]::Read())`;

export interface ConsoleControlReport {
  windowsHide: boolean;
  hasConsole: boolean | 'unknown';
  visibleStyle: boolean | 'unknown';
  validShape: boolean;
  status: number | null | 'unknown';
  signal: string | null | 'unknown';
  errorCode: string | 'unknown';
  elapsedMs: number;
}

function code(error: unknown): string {
  const value =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value)
    ? value
    : 'unknown';
}

export function runConsoleControls(run: typeof spawnSync = spawnSync): {
  reports: ConsoleControlReport[];
  exitCode: 0 | 1;
} {
  const command = win32.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const args = ['-NoProfile', '-NonInteractive', '-Command', CONTROL];
  const reports: ConsoleControlReport[] = [];
  let failed = false;
  for (const windowsHide of [false, true]) {
    const started = performance.now();
    let result: ReturnType<typeof spawnSync> | undefined;
    let invocationFailed = false;
    let invocationError: unknown;
    try {
      result = run(command, args, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        windowsHide,
      });
    } catch (error) {
      invocationFailed = true;
      invocationError = error;
    }
    const shape =
      typeof result?.stdout === 'string'
        ? /^(true|false) (true|false)(?:\r?\n)?(?![\s\S])/.exec(result.stdout)
        : null;
    const validShape =
      shape !== null && !(shape[1] === 'false' && shape[2] === 'true');
    if (
      invocationFailed ||
      !validShape ||
      result?.status !== 0 ||
      result.signal !== null ||
      result.error
    )
      failed = true;
    reports.push({
      windowsHide,
      hasConsole: validShape ? shape![1] === 'true' : 'unknown',
      visibleStyle: validShape ? shape![2] === 'true' : 'unknown',
      validShape,
      status:
        result?.status === null || Number.isSafeInteger(result?.status)
          ? result!.status
          : 'unknown',
      signal:
        result?.signal === null
          ? null
          : typeof result?.signal === 'string' &&
              /^SIG[A-Z0-9]{1,20}$/.test(result.signal)
            ? result.signal
            : 'unknown',
      errorCode: code(invocationFailed ? invocationError : result?.error),
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    });
  }
  return { reports, exitCode: failed ? 1 : 0 };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.platform !== 'win32') {
    process.stderr.write(
      'CIRCLE_CONSOLE_CONTROL {"errorCode":"UNSUPPORTED_PLATFORM"}\n',
    );
    process.exitCode = 1;
  } else {
    const result = runConsoleControls();
    for (const report of result.reports)
      process.stdout.write(
        `CIRCLE_CONSOLE_CONTROL ${JSON.stringify(report)}\n`,
      );
    process.exitCode = result.exitCode;
  }
}
