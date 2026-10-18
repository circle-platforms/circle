import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** A Windows shell Circle started: its PID, and when it started and was seen to end (ms). */
export interface ShellLifetime {
  pid: number;
  started: number;
  ended: number;
}
/** The few Windows process calls the sweep needs; tests give their own. */
export interface WindowsChildrenApi {
  /** Every process now: its PID, the PID of the process that started it, and its image name. */
  processes(): { pid: number; parent: number; name: string }[];
  /** When a process started, in ms since 1970, or undefined when it cannot be read. */
  started(pid: number): number | undefined;
}
// A process's recorded start can lag the clock Circle reads by a timer tick.
const TICK = 100;
// Windows starts a console host for a console program that has no console to inherit, as a
// child of that program. It belongs to the console, not to the command, and ends by itself
// once no program uses that console.
const CONSOLE_HOST = 'conhost.exe';

/**
 * The programs a Windows shell started that outlived it. `taskkill /T` ends the tree as it is
 * when taskkill looks at it, so a program the shell starts just after that keeps running, with
 * the ended shell's PID as its parent. Only processes that started while the shell ran count,
 * so a process whose parent merely reused that PID later is never one.
 */
export function strandedChildren(
  api: WindowsChildrenApi,
  shell: ShellLifetime,
): number[] {
  return api
    .processes()
    .filter(
      (entry) =>
        entry.parent === shell.pid &&
        entry.pid !== shell.pid &&
        entry.name.toLowerCase() !== CONSOLE_HOST,
    )
    .flatMap((entry) => {
      const started = api.started(entry.pid);
      return started !== undefined &&
        started >= shell.started - TICK &&
        started <= shell.ended
        ? [entry.pid]
        : [];
    });
}

export async function loadChildrenApi(): Promise<WindowsChildrenApi> {
  const { default: koffi } = await import('koffi');
  const kernel = koffi.load(
    join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'kernel32.dll'),
  );
  const type = koffi.struct('CircleChildEntry32W', {
    dwSize: 'uint32_t',
    cntUsage: 'uint32_t',
    th32ProcessID: 'uint32_t',
    th32DefaultHeapID: 'uintptr_t',
    th32ModuleID: 'uint32_t',
    cntThreads: 'uint32_t',
    th32ParentProcessID: 'uint32_t',
    pcPriClassBase: 'int32_t',
    dwFlags: 'uint32_t',
    szExeFile: koffi.array('uint16_t', 260),
  });
  const pidOffset = koffi.offsetof(type, 'th32ProcessID');
  const nameOffset = koffi.offsetof(type, 'szExeFile');
  const parentOffset = koffi.offsetof(type, 'th32ParentProcessID');
  const snapshot = kernel.func(
    'void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)',
  );
  const first = kernel.func(
    'int __stdcall Process32FirstW(void *snapshot, void *entry)',
  );
  const next = kernel.func(
    'int __stdcall Process32NextW(void *snapshot, void *entry)',
  );
  const open = kernel.func(
    'void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)',
  );
  const times = kernel.func(
    'int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)',
  );
  const close = kernel.func('int __stdcall CloseHandle(void *handle)');
  const valid = (handle: unknown): handle is bigint =>
    typeof handle === 'bigint' &&
    handle !== 0n &&
    BigInt.asIntN(64, handle) !== -1n;
  return {
    processes: () => {
      const handle: unknown = snapshot(2, 0);
      if (!valid(handle)) return [];
      const entry = Buffer.alloc(koffi.sizeof(type));
      entry.writeUInt32LE(entry.length);
      const found: { pid: number; parent: number; name: string }[] = [];
      try {
        for (let more = first(handle, entry); more; more = next(handle, entry))
          found.push({
            pid: entry.readUInt32LE(pidOffset),
            parent: entry.readUInt32LE(parentOffset),
            name: entry
              .subarray(nameOffset, nameOffset + 520)
              .toString('utf16le')
              .split('\0', 1)[0]!,
          });
      } finally {
        close(handle);
      }
      return found;
    },
    started: (pid) => {
      // PROCESS_QUERY_LIMITED_INFORMATION
      const handle: unknown = open(0x1000, 0, pid);
      if (!valid(handle)) return undefined;
      try {
        const [creation, exit, kernelTime, user] = [0, 0, 0, 0].map(() =>
          Buffer.alloc(8),
        );
        if (!times(handle, creation, exit, kernelTime, user)) return undefined;
        // FILETIME: 100 ns since 1601.
        return Number(
          (creation!.readBigUInt64LE(0) - 116444736000000000n) / 10000n,
        );
      } finally {
        close(handle);
      }
    },
  };
}

const taskkill = (pid: number): Promise<void> =>
  new Promise((resolve) =>
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve()),
  );

/** Ends what a stopped Windows shell left running. Returns the PIDs it ended. */
export async function endStranded(
  shell: ShellLifetime,
  load: () => Promise<WindowsChildrenApi> = loadChildrenApi,
  kill: (pid: number) => Promise<void> = taskkill,
): Promise<number[]> {
  const pids = strandedChildren(await load(), shell);
  for (const pid of pids) await kill(pid);
  return pids;
}
