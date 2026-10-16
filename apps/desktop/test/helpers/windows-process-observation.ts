import { join } from 'node:path';

export type WindowsProcessObservation =
  | { pid: number; at: number; exists: false }
  | {
      pid: number;
      at: number;
      exists: true;
      image: string;
      creationTicks: string;
      exitCode: number;
      wait: 'running' | 'exited';
    };

/** Test observation only. Every handle is read-only, transient and closed here. */
export async function createWindowsProcessObserver() {
  if (process.platform !== 'win32')
    throw Error('requires actual Windows process handles');
  const { default: koffi } = await import('koffi');
  const library = koffi.load(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'kernel32.dll'),
  );
  const open = library.func(
    'void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)',
  );
  const close = library.func('int __stdcall CloseHandle(void *handle)');
  const times = library.func(
    'int __stdcall GetProcessTimes(void *handle, void *creation, void *exit, void *kernel, void *user)',
  );
  const code = library.func(
    'int __stdcall GetExitCodeProcess(void *handle, void *code)',
  );
  const wait = library.func(
    'uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)',
  );
  const image = library.func(
    'int __stdcall QueryFullProcessImageNameW(void *handle, uint32_t flags, void *buffer, void *size)',
  );
  const error = library.func('uint32_t __stdcall GetLastError()');
  const check = (value: unknown, stage: string) => {
    if (!value)
      throw Error(`read-only Windows process ${stage} failed (${error()})`);
  };
  return (pid: number): WindowsProcessObservation => {
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw Error('invalid observed PID');
    const at = Date.now();
    // QUERY_LIMITED_INFORMATION | SYNCHRONIZE. Never PROCESS_TERMINATE.
    const handle = open(0x1000 | 0x100000, 0, pid);
    if (typeof handle !== 'bigint' || handle === 0n) {
      const last = Number(error());
      if (last === 87) return { pid, at, exists: false };
      throw Error(`read-only Windows process open failed (${last})`);
    }
    try {
      const creation = Buffer.alloc(8),
        exitCode = Buffer.alloc(4),
        name = Buffer.alloc(65536),
        size = Buffer.alloc(4);
      check(
        times(
          handle,
          creation,
          Buffer.alloc(8),
          Buffer.alloc(8),
          Buffer.alloc(8),
        ),
        'creation',
      );
      check(code(handle, exitCode), 'exit code');
      const state = Number(wait(handle, 0));
      if (state !== 0 && state !== 258)
        throw Error(`read-only Windows process wait failed (${error()})`);
      size.writeUInt32LE(32768);
      check(image(handle, 0, name, size), 'image');
      const length = size.readUInt32LE();
      if (length >= 32768) throw Error('observed process image is too long');
      return {
        pid,
        at,
        exists: true,
        image: name.subarray(0, length * 2).toString('utf16le'),
        creationTicks: creation.readBigUInt64LE().toString(),
        exitCode: exitCode.readUInt32LE(),
        wait: state === 0 ? 'exited' : 'running',
      };
    } finally {
      check(close(handle), 'close');
    }
  };
}
