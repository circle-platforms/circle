// A session lease is stale 30 seconds after its owner's last heartbeat
// (SESSION_LEASE_STALE_MS in src/session_lock.ts). A runtime started sooner
// finds the sessions of the one that died still held, and opens a new session
// instead of the user's. So a restart waits this long after the exit.
export const RUNTIME_RESTART_DELAY_MS = 31_000;
// After an automatic restart, another unexpected exit within this window is
// not restarted automatically: a runtime that keeps dying is left stopped.
export const RUNTIME_RESTART_WINDOW_MS = 10 * 60_000;

/** Why the runtime's utility process ended, from its exit code and the end of its stderr. */
export type RuntimeExitReason = 'out-of-memory' | 'crashed' | 'exited';
export interface RuntimeExit {
  reason: RuntimeExitReason;
  /** The code as reported: decimal, and hexadecimal for a Windows status. */
  code: string;
  /** English, for the log and for commands that were waiting on the runtime. */
  message: string;
  /** What the code means, when Circle knows. */
  detail?: string;
}

// Windows reports a DWORD; Electron hands it over as an unsigned number. A
// status Chromium's crash handling raises is in this table.
const WINDOWS_CODES: Record<number, [RuntimeExitReason, string]> = {
  0xe0000008: ['out-of-memory', "Chromium's out-of-memory exception"],
  0xc0000017: ['out-of-memory', 'STATUS_NO_MEMORY'],
  0xc0000005: ['crashed', 'STATUS_ACCESS_VIOLATION'],
  0xc00000fd: ['crashed', 'STATUS_STACK_OVERFLOW'],
  0xc0000409: ['crashed', 'STATUS_STACK_BUFFER_OVERRUN (fail fast)'],
  0x80000003: ['crashed', 'STATUS_BREAKPOINT (deliberate crash)'],
  // crashpad/util/win/termination_codes.h. Electron installs crashpad's
  // exception filter in every child; without crashReporter.start() no handler
  // is connected, so any fatal error (an access violation, V8 running out of
  // heap) ends the process with one of these and the original status is lost.
  0xffff7001: ['crashed', 'crashpad: the crash handler did not respond'],
  0xffff7002: ['crashed', 'crashpad: the crash snapshot failed'],
  0xffff7003: [
    'crashed',
    'crashpad: a crash dump was requested but no crash handler is connected; the original error is not in the code',
  ],
};
// What V8, Node and Electron write to stderr when the heap is exhausted.
const OUT_OF_MEMORY =
  /JavaScript heap out of memory|OOM error in V8|Fatal process out of memory|Reached heap limit|Allocation failed - process out of memory/;

export function describeRuntimeExit(
  code: number | null | undefined,
  stderr = '',
): RuntimeExit {
  const number = typeof code === 'number' && Number.isFinite(code) ? code : NaN;
  const unsigned = Number.isNaN(number) ? undefined : number >>> 0;
  const windows = unsigned === undefined ? undefined : WINDOWS_CODES[unsigned];
  const shown =
    unsigned === undefined
      ? 'unknown'
      : unsigned > 0xffff
        ? `${unsigned} (0x${unsigned.toString(16).toUpperCase().padStart(8, '0')})`
        : String(number);
  const reason: RuntimeExitReason = OUT_OF_MEMORY.test(stderr)
    ? 'out-of-memory'
    : (windows?.[0] ?? 'exited');
  const message =
    reason === 'out-of-memory'
      ? `Circle runtime ran out of memory (${shown})`
      : reason === 'crashed'
        ? `Circle runtime crashed (${shown})`
        : `Circle runtime exited (${shown})`;
  return {
    reason,
    code: shown,
    message,
    ...(windows ? { detail: windows[1] } : {}),
  };
}

/** Values that look like credentials do not reach the log. */
export function redactRuntimeOutput(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(
      /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abp])[-_][A-Za-z0-9_-]{8,}/g,
      '[redacted]',
    )
    .replace(
      /((?:api[_-]?key|authorization|token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1[redacted]',
    );
}
