import { realpathSync } from 'node:fs';
import { join } from 'node:path';

/** A live handle is retained throughout ownership; no cleanup targets a saved PID. */
export interface WindowsJobApi {
  create(): bigint;
  configure(job: bigint): void;
  open(pid: number): bigint;
  processId(process: bigint): number;
  creationTime(process: bigint): bigint;
  image(process: bigint): string;
  exited(process: bigint): boolean;
  exitCode(process: bigint): number;
  assign(job: bigint, process: bigint): void;
  contains(job: bigint, process: bigint): boolean;
  members(job: bigint): number[];
  terminate(job: bigint): void;
  close(handle: bigint): void;
}
export class WindowsCommandJob {
  private wrapper?: bigint;
  private wrapperId?: number;
  private root?: bigint;
  private wrapperCreated?: bigint;
  private disposed = false;
  private readonly job: bigint;
  constructor(private readonly api: WindowsJobApi) {
    this.job = api.create();
    try {
      api.configure(this.job);
    } catch (error) {
      api.close(this.job);
      throw error;
    }
  }
  assignWrapper(options: {
    pid: number;
    authenticatedPid: number;
    executable: string;
    launchedAfter: number;
    now?: number;
  }) {
    if (this.disposed || this.wrapper)
      throw Error('Windows command Job is not assignable');
    if (
      !Number.isSafeInteger(options.pid) ||
      options.pid <= 0 ||
      options.pid !== options.authenticatedPid
    )
      throw Error(
        'Windows supervisor identity does not match its original PTY',
      );
    const handle = this.api.open(options.pid);
    try {
      const created = this.api.creationTime(handle);
      const lower =
        BigInt(options.launchedAfter) * 10000n + 116444736000000000n;
      const upper =
        (BigInt(options.now ?? Date.now()) + 1n) * 10000n -
        1n +
        116444736000000000n;
      if (
        this.api.processId(handle) !== options.pid ||
        this.api.exited(handle) ||
        created < lower ||
        created > upper ||
        realpathSync.native(this.api.image(handle)).toLowerCase() !==
          realpathSync.native(options.executable).toLowerCase()
      )
        throw Error(
          'Windows supervisor live handle identity could not be verified',
        );
      this.api.assign(this.job, handle);
      if (!this.api.contains(this.job, handle) || this.api.exited(handle))
        throw Error('Windows supervisor Job assignment was not confirmed');
      this.wrapperCreated = created;
      this.wrapper = handle;
      this.wrapperId = options.pid;
    } catch (error) {
      this.api.close(handle);
      throw error;
    }
  }
  /** Capture only the authenticated supervisor's live actual root, before Stop. */
  captureRoot(pid: number): void {
    if (
      this.disposed ||
      !this.wrapper ||
      this.root ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      pid === this.wrapperId
    )
      throw Error('Windows command root is not capturable');
    const handle = this.api.open(pid);
    try {
      if (
        this.api.processId(handle) !== pid ||
        this.api.exited(handle) ||
        this.api.creationTime(handle) < this.wrapperCreated! ||
        !this.api.contains(this.job, handle)
      )
        throw Error(
          'Windows actual command root handle identity is unconfirmed',
        );
      this.root = handle;
    } catch (error) {
      this.api.close(handle);
      throw error;
    }
  }
  actualRootExitCode(): number {
    if (this.disposed || !this.root || !this.api.exited(this.root))
      throw Error('Windows actual command exit handle is unconfirmed');
    return this.api.exitCode(this.root);
  }
  members(): number[] {
    if (this.disposed || !this.wrapper)
      throw Error('Windows command Job is not assigned');
    return this.api.members(this.job);
  }
  onlyWrapper(): boolean {
    const members = this.members();
    return (
      members.length === 1 &&
      members[0] === this.wrapperId &&
      !this.api.exited(this.wrapper!)
    );
  }
  terminate() {
    if (this.disposed || !this.wrapper)
      throw Error('Windows command Job is not assigned');
    this.api.terminate(this.job);
  }
  dispose() {
    if (this.disposed) return;
    // KILL_ON_JOB_CLOSE also covers host failure; the handle is never inherited.
    this.api.close(this.job);
    this.disposed = true;
    if (this.root) this.api.close(this.root);
    if (this.wrapper) this.api.close(this.wrapper);
  }
}

export async function loadWindowsJobApi(): Promise<WindowsJobApi> {
  if (process.platform !== 'win32')
    throw Error('Windows command Job is unavailable on this platform');
  const { default: koffi } = await import('koffi');
  const kernel = koffi.load(
    join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'kernel32.dll'),
  );
  const fn = (declaration: string) => kernel.func(declaration);
  const create = fn(
    'void * __stdcall CreateJobObjectW(void *attributes, void *name)',
  );
  const set = fn(
    'int __stdcall SetInformationJobObject(void *job, int informationClass, void *information, uint32_t length)',
  );
  const query = fn(
    'int __stdcall QueryInformationJobObject(void *job, int informationClass, void *information, uint32_t length, void *returnedLength)',
  );
  const open = fn(
    'void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)',
  );
  const assign = fn(
    'int __stdcall AssignProcessToJobObject(void *job, void *process)',
  );
  const contains = fn(
    'int __stdcall IsProcessInJob(void *process, void *job, void *result)',
  );
  const terminate = fn(
    'int __stdcall TerminateJobObject(void *job, uint32_t code)',
  );
  const close = fn('int __stdcall CloseHandle(void *handle)');
  const pid = fn('uint32_t __stdcall GetProcessId(void *process)');
  const times = fn(
    'int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)',
  );
  const image = fn(
    'int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *buffer, void *size)',
  );
  const wait = fn(
    'uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)',
  );
  const processExitCode = fn(
    'int __stdcall GetExitCodeProcess(void *process, void *code)',
  );
  const lastError = fn('uint32_t __stdcall GetLastError()');
  const check = (result: unknown, stage: string) => {
    if (!result)
      throw Error(`Windows command Job ${stage} failed (code ${lastError()})`);
  };
  const handle = (value: unknown) => {
    if (
      typeof value !== 'bigint' ||
      value === 0n ||
      BigInt.asIntN(64, value) === -1n
    )
      throw Error(`Windows command Job handle failed (code ${lastError()})`);
    return value;
  };
  if (process.arch !== 'x64' && process.arch !== 'arm64')
    throw Error('Windows command Job ABI is unsupported');
  return {
    create: () => handle(create(null, null)),
    configure: (job) => {
      // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64/arm64 ABI: basic limits64,
      // IO counters48, then four SIZE_T fields32. Only kill-on-close, no breakaway.
      const info = Buffer.alloc(144);
      info.writeUInt32LE(0x2000, 16);
      check(set(job, 9, info, info.length), 'configure');
    },
    open: (id) => handle(open(0x1000 | 0x100 | 0x1 | 0x100000, 0, id)),
    processId: (process) => {
      const id = Number(pid(process));
      check(id, 'process identity');
      return id;
    },
    creationTime: (process) => {
      const created = Buffer.alloc(8);
      check(
        times(
          process,
          created,
          Buffer.alloc(8),
          Buffer.alloc(8),
          Buffer.alloc(8),
        ),
        'process creation',
      );
      return created.readBigUInt64LE();
    },
    image: (process) => {
      const data = Buffer.alloc(65536),
        size = Buffer.alloc(4);
      size.writeUInt32LE(32768);
      check(image(process, 0, data, size), 'process image');
      const length = size.readUInt32LE();
      if (length >= 32768) throw Error('Windows command image is too long');
      return data.subarray(0, length * 2).toString('utf16le');
    },
    exited: (process) => {
      const status = Number(wait(process, 0));
      if (status === 0) return true;
      if (status === 258) return false;
      throw Error(`Windows command wait failed (code ${lastError()})`);
    },
    exitCode: (process) => {
      const code = Buffer.alloc(4);
      check(processExitCode(process, code), 'actual process exit code');
      return code.readUInt32LE();
    },
    assign: (job, process) => check(assign(job, process), 'assign'),
    contains: (job, process) => {
      const result = Buffer.alloc(4);
      check(contains(process, job, result), 'membership');
      return result.readUInt32LE() !== 0;
    },
    members: (job) => {
      const data = Buffer.alloc(65536);
      check(query(job, 3, data, data.length, null), 'members');
      const assigned = data.readUInt32LE(0),
        count = data.readUInt32LE(4);
      if (count !== assigned || count > (data.length - 8) / 8)
        throw Error('Windows command Job member list is incomplete');
      return Array.from({ length: count }, (_, i) => {
        const value = data.readBigUInt64LE(8 + i * 8);
        if (value > 0xffffffffn || value === 0n)
          throw Error('Invalid Windows command Job member');
        return Number(value);
      });
    },
    terminate: (job) => check(terminate(job, 1), 'terminate'),
    close: (handle) => check(close(handle), 'close'),
  };
}
