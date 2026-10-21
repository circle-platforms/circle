import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** A Windows shell Circle started: its PID, and when it started and was seen to end (ms). */
export interface ShellLifetime {
  pid: number;
  started: number;
  ended: number;
}
/** One entry of the Windows process list. */
export interface ProcessEntry {
  pid: number;
  /** The PID of the process that started it, which may have ended since. */
  parent: number;
  name: string;
}
/**
 * A Windows Job object: the kernel puts every process a member starts into the same Job,
 * however deep, so it holds a command's whole tree even after the processes between have
 * ended and left their children pointing at a PID that no longer exists.
 */
export interface WindowsJobApi {
  create(): bigint;
  /** Puts a running process into the Job; false when Windows refuses. */
  assign(job: bigint, pid: number): boolean;
  /** The PIDs of the processes now in the Job. */
  members(job: bigint): number[];
  /** Resolves after this Job member has exited; its held process handle prevents PID reuse. */
  terminate(job: bigint, pid: number): boolean | Promise<boolean>;
  close(job: bigint): void;
}
/** The few Windows process calls the sweep needs; tests give their own. */
export interface WindowsChildrenApi {
  /** Every process now: its PID, the PID of the process that started it, and its image name. */
  processes(): ProcessEntry[];
  /** When a process started, in ms since 1970, or undefined when it cannot be read. */
  started(pid: number): number | undefined;
  /** Job objects, where Windows offers them. */
  job?: WindowsJobApi;
}
/**
 * A process seen to belong to a command's tree: when it started and, once it has ended, the
 * latest time it can have started a child (ms).
 */
export interface TreeProcess {
  pid: number;
  started: number;
  ended?: number;
}
// A process's recorded start can lag the clock Circle reads by a timer tick.
const TICK = 100;
// Windows starts a console host for a console program that has no console to inherit, as a
// child of that program. It belongs to the console, not to the command, and ends by itself
// once no program uses that console.
const CONSOLE_HOST = 'conhost.exe';
const consoleHost = (name: string): boolean =>
  name.toLowerCase() === CONSOLE_HOST;

/**
 * The processes a Windows shell started, at any depth, that are still running after it ended.
 * `taskkill /T` ends the tree as it is when taskkill looks at it, and it follows only parents
 * that are still running: a program started by a process that has already ended (`cmd /c start
 * /b …`) keeps the ended process's PID as its parent and is out of its reach.
 *
 * The walk starts from the shell and from `known`, the processes seen in the tree before (Job
 * members and earlier walks), and takes a process when its parent is in the tree and it started
 * after that parent started and while that parent still ran. A PID that has been reused belongs
 * to a process that started later than the one recorded, so its children are never taken.
 */
export function strandedTree(
  api: Pick<WindowsChildrenApi, 'processes' | 'started'>,
  shell: ShellLifetime,
  known: TreeProcess[] = [],
): { live: TreeProcess[]; roots: number[]; known: TreeProcess[] } {
  const list = api.processes();
  const now = new Map(list.map((entry) => [entry.pid, entry]));
  const startTimes = new Map<number, number | undefined>();
  const startOf = (pid: number): number | undefined => {
    if (!startTimes.has(pid)) startTimes.set(pid, api.started(pid));
    return startTimes.get(pid);
  };
  const tree = new Map<number, TreeProcess>();
  // The shell has ended; a process holding its PID now is another one.
  tree.set(shell.pid, {
    pid: shell.pid,
    started: shell.started - TICK,
    ended: shell.ended,
  });
  for (const process of known) {
    if (process.pid === shell.pid) continue;
    const current = now.get(process.pid);
    const started = current ? startOf(process.pid) : undefined;
    let ended = process.ended;
    if (!current) ended ??= Infinity;
    else if (started !== process.started)
      // Its PID now belongs to a later process: the recorded one ended before that started.
      ended = Math.min(
        ended ?? Infinity,
        started === undefined ? Infinity : started - 1,
      );
    tree.set(process.pid, {
      ...process,
      ...(ended === undefined ? {} : { ended }),
    });
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of list) {
      if (tree.has(entry.pid) || consoleHost(entry.name)) continue;
      const parent = tree.get(entry.parent);
      if (!parent) continue;
      const started = startOf(entry.pid);
      if (
        started === undefined ||
        started < parent.started ||
        started > (parent.ended ?? Infinity)
      )
        continue;
      tree.set(entry.pid, { pid: entry.pid, started });
      grew = true;
    }
  }
  const live = [...tree.values()].filter(
    (process) =>
      process.pid !== shell.pid &&
      process.ended === undefined &&
      now.has(process.pid) &&
      !consoleHost(now.get(process.pid)!.name),
  );
  const livePids = new Set(live.map((process) => process.pid));
  return {
    live,
    roots: live
      .filter((process) => !livePids.has(now.get(process.pid)!.parent))
      .map((process) => process.pid),
    known: [...tree.values()].filter((process) => process.pid !== shell.pid),
  };
}

/**
 * The tree of one Windows shell Circle started. The shell is put into a Job object as soon as
 * it starts, and what is seen in the tree is recorded when the shell ends, so the tree can be
 * ended later, after the job is marked done, whatever ended in between.
 */
export class WindowsCommandTree {
  private known: TreeProcess[] = [];
  private job?: bigint;
  constructor(
    private readonly api: WindowsChildrenApi,
    private readonly shell: { pid: number; started: number },
    private readonly kill: (pid: number) => Promise<void> = taskkill,
  ) {
    if (!api.job) return;
    try {
      const job = api.job.create();
      if (api.job.assign(job, shell.pid)) this.job = job;
      else api.job.close(job);
    } catch {
      /* Without a Job the walk still finds what it can. */
    }
  }
  private members(): number[] {
    if (this.job === undefined) return [];
    try {
      return this.api.job!.members(this.job);
    } catch {
      return [];
    }
  }
  private walk(ended: number): ReturnType<typeof strandedTree> {
    const members = this.members().flatMap((pid) => {
      if (pid === this.shell.pid || this.known.some((p) => p.pid === pid))
        return [];
      const started = this.api.started(pid);
      return started === undefined ? [] : [{ pid, started }];
    });
    const result = strandedTree(this.api, { ...this.shell, ended }, [
      ...this.known,
      ...members,
    ]);
    this.known = result.known;
    return result;
  }
  /** Notes what is in the tree now. True when something the shell started is still running. */
  record(ended: number): boolean {
    try {
      return this.walk(ended).live.length > 0;
    } catch {
      return false;
    }
  }
  /** Ends what the shell left running. Returns the PIDs it ended. */
  async end(ended: number): Promise<number[]> {
    const done: number[] = [];
    const errors: unknown[] = [];
    const names = new Map(
      this.api.processes().map((entry) => [entry.pid, entry.name]),
    );
    this.walk(ended);
    // A Job member is ended through the Job, which a reused PID is not in.
    if (this.job !== undefined)
      for (const pid of this.members()) {
        const name = names.get(pid);
        if (pid === this.shell.pid || name === undefined || consoleHost(name))
          continue;
        try {
          if (await this.api.job!.terminate(this.job, pid)) done.push(pid);
        } catch (error) {
          errors.push(error);
        }
      }
    // Anything outside the Job, such as a program started before the shell was put in it,
    // is ended with its own tree.
    // A terminated process can stay in the list for a moment while it exits.
    for (const pid of this.walk(ended).roots) {
      if (done.includes(pid)) continue;
      try {
        await this.kill(pid);
        done.push(pid);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        'could not end every Windows command tree member',
      );
    return done;
  }
  dispose(): void {
    if (this.job === undefined) return;
    try {
      this.api.job!.close(this.job);
    } catch {
      /* Closing a handle cannot fail in a way that matters here. */
    }
    this.job = undefined;
  }
}

let childrenApi: Promise<WindowsChildrenApi> | undefined;
let loadedApi: WindowsChildrenApi | undefined;
/** The process list, loaded once: koffi refuses to define its struct type twice. */
export function loadChildrenApi(): Promise<WindowsChildrenApi> {
  childrenApi ??= loadChildrenApiOnce().then(
    (api) => (loadedApi = api),
    (error: unknown) => {
      childrenApi = undefined;
      throw error;
    },
  );
  return childrenApi;
}
/** The process list when it has loaded already, for a caller that cannot wait. */
export function loadedChildrenApi(): WindowsChildrenApi | undefined {
  return loadedApi;
}

async function loadChildrenApiOnce(): Promise<WindowsChildrenApi> {
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
    ...(process.arch === 'x64' || process.arch === 'arm64'
      ? { job: jobApi(kernel, open, close, valid) }
      : {}),
  };
}

function jobApi(
  kernel: { func(declaration: string): (...args: unknown[]) => unknown },
  open: (...args: unknown[]) => unknown,
  close: (...args: unknown[]) => unknown,
  valid: (handle: unknown) => handle is bigint,
): WindowsJobApi {
  const create = kernel.func(
    'void * __stdcall CreateJobObjectW(void *attributes, void *name)',
  );
  const assign = kernel.func(
    'int __stdcall AssignProcessToJobObject(void *job, void *process)',
  );
  const query = kernel.func(
    'int __stdcall QueryInformationJobObject(void *job, int informationClass, void *information, uint32_t length, void *returnedLength)',
  );
  const contains = kernel.func(
    'int __stdcall IsProcessInJob(void *process, void *job, void *result)',
  );
  const terminate = kernel.func(
    'int __stdcall TerminateProcess(void *process, uint32_t code)',
  );
  const wait = kernel.func(
    'uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)',
  );
  // PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA and PROCESS_TERMINATE.
  const withProcess = <T>(
    pid: number,
    use: (handle: bigint) => T,
  ): T | false => {
    const handle: unknown = open(0x1000 | 0x100 | 0x1, 0, pid);
    if (!valid(handle)) return false;
    try {
      return use(handle);
    } finally {
      close(handle);
    }
  };
  return {
    create: () => {
      const job: unknown = create(null, null);
      if (!valid(job)) throw new Error('CreateJobObjectW failed');
      return job;
    },
    assign: (job, pid) =>
      withProcess(pid, (handle) => Boolean(assign(job, handle))) === true,
    members: (job) => {
      // JOBOBJECT_BASIC_PROCESS_ID_LIST: two counts, then one ULONG_PTR per process.
      const data = Buffer.alloc(65536);
      if (!query(job, 3, data, data.length, null)) return [];
      const count = Math.min(data.readUInt32LE(4), (data.length - 8) / 8);
      return Array.from({ length: count }, (_, index) =>
        Number(data.readBigUInt64LE(8 + index * 8)),
      ).filter((pid) => pid > 0 && pid <= 0xffffffff);
    },
    terminate: async (job, pid) => {
      // Query, terminate and synchronize on the same process, even if its PID is
      // reused later. TerminateProcess only initiates termination: pending I/O
      // can keep the process alive after it returns.
      const handle: unknown = open(0x1000 | 0x1 | 0x100000, 0, pid);
      if (!valid(handle)) return false;
      try {
        const inJob = Buffer.alloc(4);
        if (!contains(handle, job, inJob) || !inJob.readUInt32LE(0))
          return false;
        if (!terminate(handle, 1)) return wait(handle, 0) === 0;
        const deadline = Date.now() + 10_000;
        for (;;) {
          const result = wait(handle, 0);
          if (result === 0) return true;
          if (result !== 0x102)
            throw Error(`could not observe Windows process ${pid} exiting`);
          if (Date.now() >= deadline)
            throw Error(`Windows process ${pid} did not finish terminating`);
          await delay(10);
        }
      } finally {
        close(handle);
      }
    },
    close: (job) => {
      close(job);
    },
  };
}

const taskkill = (pid: number): Promise<void> =>
  new Promise((resolve) =>
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve()),
  );
