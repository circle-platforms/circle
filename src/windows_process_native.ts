import { writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NativeProcessEntry {
  pid: number;
  name: string;
}
export interface WindowsProcessApi {
  version?: string;
  snapshot(): bigint;
  first(snapshot: bigint): NativeProcessEntry | undefined;
  next(snapshot: bigint): NativeProcessEntry | undefined;
  open(pid: number): bigint;
  image(process: bigint): string;
  close(handle: bigint): void;
}
export class WindowsProcessApiError extends Error {
  readonly stage: string;
  readonly code: number | undefined;
  constructor(stage: string, code?: number) {
    super(
      `Windows process query failed at ${stage} (code ${code ?? 'unknown'})`,
    );
    this.stage = stage;
    this.code = code;
  }
}
type Stage = 'LOOKUP' | 'MODULE' | 'DISPOSE';

export function enumerateWindowsProcesses(
  api: WindowsProcessApi,
  names: string[],
  all: boolean,
  mark: (stage: Stage) => void = () => {},
  onEntry: (entry: { pid: number; path: string }) => void = () => {},
) {
  const entries: { pid: number; path: string }[] = [];
  const emit = (stage: Stage) => {
    try {
      mark(stage);
    } catch {
      /* Observation cannot replace a query or cleanup. */
    }
  };
  const issues: { stage: string; code?: number }[] = [];
  let issueCount = 0;
  const note = (error: unknown) => {
    issueCount++;
    if (issues.length < 32)
      issues.push(
        error instanceof WindowsProcessApiError
          ? { stage: error.stage, code: error.code }
          : { stage: 'unknown' },
      );
  };
  const close = (handle: bigint) => {
    emit('DISPOSE');
    try {
      api.close(handle);
    } catch (error) {
      note(error);
    }
  };
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  let snapshot: bigint | undefined;
  try {
    emit('LOOKUP');
    const handle = api.snapshot();
    if (handle === 0n || BigInt.asIntN(64, handle) === -1n)
      throw new WindowsProcessApiError('snapshot');
    snapshot = handle;
    for (
      let entry = api.first(snapshot);
      entry !== undefined;
      entry = api.next(snapshot)
    ) {
      if (!all && !wanted.has(entry.name.replace(/\.exe$/i, '').toLowerCase()))
        continue;
      let process: bigint | undefined;
      try {
        const handle = api.open(entry.pid);
        if (handle === 0n || BigInt.asIntN(64, handle) === -1n)
          throw new WindowsProcessApiError('open');
        process = handle;
        emit('MODULE');
        const path = api.image(process);
        if (!path || path.includes('\0'))
          throw new WindowsProcessApiError('image');
        const verified = { pid: entry.pid, path };
        entries.push(verified);
        onEntry(verified);
      } catch (error) {
        note(error);
      } finally {
        if (process !== undefined) close(process);
      }
    }
  } catch (error) {
    note(error);
  } finally {
    if (snapshot !== undefined) close(snapshot);
  }
  return { entries, issues, issueCount, complete: issueCount === 0 };
}

export async function loadWindowsProcessApi(): Promise<WindowsProcessApi> {
  if (process.platform !== 'win32')
    throw new WindowsProcessApiError('platform');
  const { default: koffi } = await import('koffi').catch(() => {
    throw new WindowsProcessApiError('dependency');
  });
  const library = koffi.load(
    join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'kernel32.dll'),
  );
  const type = koffi.struct('CircleProcessEntry32W', {
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
  const entry = Buffer.alloc(koffi.sizeof(type));
  if (
    (process.arch === 'x64' || process.arch === 'arm64') &&
    entry.length !== 568
  )
    throw new WindowsProcessApiError('abi');
  const pidOffset = koffi.offsetof(type, 'th32ProcessID');
  const nameOffset = koffi.offsetof(type, 'szExeFile');
  const snapshot = library.func(
    'void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)',
  );
  const first = library.func(
    'int __stdcall Process32FirstW(void *snapshot, void *entry)',
  );
  const next = library.func(
    'int __stdcall Process32NextW(void *snapshot, void *entry)',
  );
  const open = library.func(
    'void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)',
  );
  const image = library.func(
    'int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *buffer, void *size)',
  );
  const close = library.func('int __stdcall CloseHandle(void *handle)');
  const lastError = library.func('uint32_t __stdcall GetLastError()');
  const handle = (value: unknown, stage: string): bigint => {
    if (
      typeof value !== 'bigint' ||
      value === 0n ||
      BigInt.asIntN(64, value) === -1n
    )
      throw new WindowsProcessApiError(stage, lastError());
    return value;
  };
  const readEntry = (call: typeof first, snapshot: bigint) => {
    if (!call(snapshot, entry)) {
      const code = lastError();
      if (code === 18) return undefined;
      throw new WindowsProcessApiError('enumerate', code);
    }
    return {
      pid: entry.readUInt32LE(pidOffset),
      name: entry
        .subarray(nameOffset, nameOffset + 520)
        .toString('utf16le')
        .split('\0', 1)[0]!,
    };
  };
  return {
    version: koffi.version,
    snapshot: () => handle(snapshot(2, 0), 'snapshot'),
    first: (snapshot) => {
      entry.fill(0);
      entry.writeUInt32LE(entry.length);
      return readEntry(first, snapshot);
    },
    next: (snapshot) => readEntry(next, snapshot),
    open: (pid) => handle(open(0x1000, 0, pid), 'open'),
    image: (process) => {
      const buffer = Buffer.alloc(32768 * 2);
      const size = Buffer.alloc(4);
      size.writeUInt32LE(32768);
      if (!image(process, 0, buffer, size))
        throw new WindowsProcessApiError('image', lastError());
      const characters = size.readUInt32LE();
      if (characters >= 32768) throw new WindowsProcessApiError('image-size');
      return buffer.subarray(0, characters * 2).toString('utf16le');
    },
    close: (handle) => {
      if (!close(handle))
        throw new WindowsProcessApiError('close', lastError());
    },
  };
}

export function writeWindowsProcessEntry(
  entry: { pid: number; path: string },
  write: (bytes: Buffer, offset: number, length: number) => number = (
    bytes,
    offset,
    length,
  ) => writeSync(1, bytes, offset, length),
) {
  const bytes = Buffer.from(
    `${entry.pid} ${Buffer.from(entry.path, 'utf8').toString('base64')}\n`,
    'utf8',
  );
  let offset = 0;
  while (offset < bytes.length) {
    const written = write(bytes, offset, bytes.length - offset);
    if (
      !Number.isInteger(written) ||
      written <= 0 ||
      written > bytes.length - offset
    )
      throw new WindowsProcessApiError('output');
    offset += written;
  }
}

async function runWorker() {
  if (process.argv[2] === '--load-only') {
    const api = await loadWindowsProcessApi();
    writeSync(
      1,
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        koffi: api.version,
        loaded: true,
      }) + '\n',
    );
    return;
  }
  const [, , encoded, mode, nonce] = process.argv;
  if (
    !encoded ||
    !/^[a-f0-9]{32}$/.test(nonce ?? '') ||
    !['names', 'all'].includes(mode ?? '')
  )
    throw new WindowsProcessApiError('input');
  const counts = new Map<string, number>();
  const mark = (stage: string) => {
    const count = (counts.get(stage) ?? 0) + 1;
    counts.set(stage, count);
    if (count <= 32) writeSync(2, `CIRCLE_QUERY_${nonce} ${stage}\n`);
  };
  mark('DECODE');
  const names: unknown = JSON.parse(
    Buffer.from(encoded, 'base64').toString('utf8'),
  );
  if (
    !Array.isArray(names) ||
    !names.every(
      (name): name is string =>
        typeof name === 'string' && !name.includes('\0'),
    )
  )
    throw new WindowsProcessApiError('input');
  const api = await loadWindowsProcessApi();
  const outcome = enumerateWindowsProcesses(
    api,
    names,
    mode === 'all',
    mark,
    writeWindowsProcessEntry,
  );
  if (!outcome.complete) {
    const first = outcome.issues[0];
    writeSync(
      2,
      `Windows native process query incomplete (stage ${first?.stage ?? 'unknown'}; code ${first?.code ?? 'unknown'}; failures ${outcome.issueCount})\n`,
    );
    process.exitCode = 1;
  }
  mark('COMPLETE');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runWorker().catch((error: unknown) => {
    const issue = error instanceof WindowsProcessApiError ? error : undefined;
    writeSync(
      2,
      `Windows native process query unavailable (stage ${issue?.stage ?? 'load'}; code ${issue?.code ?? 'unknown'})\n`,
    );
    process.exitCode = 1;
  });
}
