import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What a window cost before it died, so that a crash can be named afterwards. A renderer
 * that runs out of memory takes its own figures with it, so the main process keeps them.
 * Numbers and channel names only: no session, file or model text reaches the log.
 */
export const WINDOW_SAMPLE_MS = 30_000;
const KEPT_SAMPLES = 40;
const FIRST_REPORT_MB = 1024;
const REPORT_STEP_MB = 512;

export interface ProcessMemory {
  pid: number;
  type?: string;
  name?: string;
  memory: {
    workingSetSize: number;
    peakWorkingSetSize?: number;
    privateBytes?: number;
  };
}

export interface RendererMemoryStats {
  jsHeapMb: number;
  jsHeapLimitMb: number;
  blinkAllocatedMb: number;
}

export interface WindowEvents {
  on(
    event: 'unresponsive' | 'responsive' | 'closed',
    listener: () => void,
  ): unknown;
  once?(event: 'closed', listener: () => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(
    event: string,
    listener: (...args: unknown[]) => void,
  ): unknown;
  isDestroyed?(): boolean;
  webContents: {
    id?: number;
    isDestroyed?: () => boolean;
    isCrashed?: () => boolean;
    getOSProcessId?: () => number;
    on(
      event: 'render-process-gone',
      listener: (
        event: unknown,
        details: { reason: string; exitCode: number },
      ) => void,
    ): unknown;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    off?(event: string, listener: (...args: unknown[]) => void): unknown;
    removeListener?(
      event: string,
      listener: (...args: unknown[]) => void,
    ): unknown;
  };
}

interface Sample {
  at: number;
  windowMb: number;
  privateMb?: number;
  peakMb?: number;
  totalMb: number;
  renderer?: RendererMemoryStats;
  sends: Array<{ channel: string; count: number; chars: number | null }>;
}

interface WindowState {
  id: number;
  name: string;
  openedAt: number;
  stoppedAt?: number;
  pid?: number;
  renderer?: RendererMemoryStats;
  samples: Sample[];
  highestMb: number;
  nextReportMb: number;
  sent: Map<string, { count: number; reported: number; latest: unknown[] }>;
  targetRef: WeakRef<WindowEvents>;
  cleanup?: () => void;
}

const megabytes = (kilobytes: number) => Math.round(kilobytes / 1024);

/** How large a message was. A value JSON cannot carry has no size, and that is not an error. */
function charsOf(value: unknown) {
  try {
    return JSON.stringify(value)?.length ?? null;
  } catch {
    return null;
  }
}

function sampleLine(sample: Sample) {
  const sends = sample.sends.map(
    ({ channel, count, chars }) =>
      `${channel} ${count}${chars === null ? '' : ` (last ${chars} chars)`}`,
  );
  const breakdown: string[] = [];
  if (sample.privateMb !== undefined)
    breakdown.push(`private ${sample.privateMb} MB`);
  if (sample.peakMb !== undefined) breakdown.push(`peak ${sample.peakMb} MB`);
  if (sample.renderer) {
    breakdown.push(
      `heap ${sample.renderer.jsHeapMb}/${sample.renderer.jsHeapLimitMb} MB`,
      `blink ${sample.renderer.blinkAllocatedMb} MB`,
    );
  }
  return [
    new Date(sample.at).toISOString(),
    `window ${sample.windowMb} MB`,
    `all ${sample.totalMb} MB`,
    ...breakdown,
    ...sends,
  ].join(', ');
}

function writeSnapshotAtomically(
  file: string,
  payload: Record<string, unknown>,
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(payload, null, 2));
    renameSync(temp, file);
  } catch {
    // Disk diagnostic persistence must never disrupt the main process.
  }
}

function removeListener(
  emitter: {
    off?: (e: string, fn: (...args: unknown[]) => void) => void;
    removeListener?: (e: string, fn: (...args: unknown[]) => void) => void;
  },
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  if (typeof emitter.off === 'function') emitter.off(event, listener);
  else if (typeof emitter.removeListener === 'function')
    emitter.removeListener(event, listener);
}

function rotatePreviousSnapshot(file: string): void {
  try {
    if (!existsSync(file)) return;
    const previous = file.endsWith('.json')
      ? `${file.slice(0, -5)}.previous.json`
      : `${file}.previous`;
    renameSync(file, previous);
  } catch {
    // Disk diagnostic persistence must never disrupt the main process.
  }
}

export function createWindowDiagnostics(options: {
  log: (text: string) => void;
  /** The processes of the application's own windows, not of the pages in its browser panels. */
  windowPids: () => number[];
  metrics: () => ProcessMemory[];
  snapshotFile?: string;
  sampleMs?: number;
  now?: () => number;
  every?: (run: () => void, ms: number) => void;
}) {
  if (options.snapshotFile) rotatePreviousSnapshot(options.snapshotFile);
  const now = options.now ?? Date.now;
  const every = options.every ?? ((run, ms) => setInterval(run, ms).unref?.());
  const sampleMs = options.sampleMs ?? WINDOW_SAMPLE_MS;
  const windows = new Map<number, WindowState>();
  let fallbackId = -1;
  let fallbackNextReportMb = FIRST_REPORT_MB;
  let sampling = false;

  const secondsSince = (at: number) => Math.round((now() - at) / 1000);

  const captureLivePid = (entry: WindowState, target?: WindowEvents) => {
    const win = target ?? entry.targetRef.deref();
    if (
      !win ||
      win.isDestroyed?.() ||
      win.webContents.isDestroyed?.() ||
      win.webContents.isCrashed?.()
    )
      return;
    const osPid = win.webContents.getOSProcessId?.();
    if (typeof osPid === 'number' && osPid > 0) entry.pid = osPid;
  };

  const sample = () => {
    let processes: ProcessMemory[], pids: number[];
    try {
      processes = options.metrics();
      pids = options.windowPids();
    } catch {
      return;
    }
    const sizes = processes.map((one) => ({
      pid: one.pid,
      type: one.type,
      name: one.name,
      mb: megabytes(one.memory.workingSetSize),
      privateMb:
        typeof one.memory.privateBytes === 'number'
          ? megabytes(one.memory.privateBytes)
          : undefined,
      peakMb:
        typeof one.memory.peakWorkingSetSize === 'number'
          ? megabytes(one.memory.peakWorkingSetSize)
          : undefined,
    }));
    const totalMb = sizes.reduce((total, one) => total + one.mb, 0);
    const timestamp = now();

    // Prune windows already collected or destroyed without an explicit close event.
    for (const [key, entry] of windows) {
      const target = entry.targetRef.deref();
      if (!target || target.isDestroyed?.()) {
        entry.cleanup?.();
        windows.delete(key);
      }
    }

    if (windows.size === 0) {
      const windowMb = Math.max(
        0,
        ...sizes.filter((one) => pids.includes(one.pid)).map((one) => one.mb),
      );
      const taken: Sample = {
        at: timestamp,
        windowMb,
        totalMb,
        sends: [],
      };
      if (taken.windowMb >= fallbackNextReportMb) {
        while (taken.windowMb >= fallbackNextReportMb)
          fallbackNextReportMb += REPORT_STEP_MB;
        options.log(`window memory: ${sampleLine(taken)}`);
      }
    } else {
      const active: WindowState[] = [];
      const assignedPids = new Set<number>();
      for (const entry of windows.values()) {
        const target = entry.targetRef.deref();
        if (
          target?.webContents.isDestroyed?.() ||
          target?.webContents.isCrashed?.()
        ) {
          continue;
        }
        captureLivePid(entry);
        if (entry.pid !== undefined) assignedPids.add(entry.pid);
        active.push(entry);
      }
      const unclaimedPids = pids.filter((pid) => !assignedPids.has(pid));
      for (const entry of active) {
        const match =
          entry.pid !== undefined
            ? sizes.find((one) => one.pid === entry.pid)
            : assignedPids.size === 0
              ? sizes
                  .filter((one) => unclaimedPids.includes(one.pid))
                  .sort((a, b) => b.mb - a.mb)[0]
              : undefined;
        const taken: Sample = {
          at: timestamp,
          windowMb: match?.mb ?? 0,
          ...(match?.privateMb !== undefined
            ? { privateMb: match.privateMb }
            : {}),
          ...(match?.peakMb !== undefined ? { peakMb: match.peakMb } : {}),
          totalMb,
          ...(entry.renderer ? { renderer: { ...entry.renderer } } : {}),
          sends: [...entry.sent]
            .filter(([, one]) => one.count > one.reported)
            .map(([channel, one]) => {
              const count = one.count - one.reported;
              one.reported = one.count;
              return { channel, count, chars: charsOf(one.latest) };
            }),
        };
        entry.samples.push(taken);
        if (entry.samples.length > KEPT_SAMPLES) entry.samples.shift();
        entry.highestMb = Math.max(entry.highestMb, taken.windowMb);
        if (taken.windowMb >= entry.nextReportMb) {
          while (taken.windowMb >= entry.nextReportMb)
            entry.nextReportMb += REPORT_STEP_MB;
          options.log(`window memory: ${sampleLine(taken)}`);
        }
      }
    }

    if (options.snapshotFile) {
      writeSnapshotAtomically(options.snapshotFile, {
        updatedAt: timestamp,
        processes: sizes,
        windows: Object.fromEntries(
          [...windows.entries()].map(([id, entry]) => [
            String(id),
            {
              name: entry.name,
              pid: entry.pid ?? 0,
              openedAt: entry.openedAt,
              highestMb: entry.highestMb,
              samples: entry.samples,
            },
          ]),
        ),
      });
    }
  };

  return {
    sent(channel: string, args: unknown[], targetIds?: readonly number[]) {
      const filter = targetIds ? new Set(targetIds) : undefined;
      for (const entry of windows.values()) {
        if (filter && !filter.has(entry.id)) continue;
        const known = entry.sent.get(channel);
        if (known) {
          known.count++;
          known.latest = args;
        } else {
          entry.sent.set(channel, { count: 1, reported: 0, latest: args });
        }
      }
    },
    rendererMemory(webContentsId: number, stats: RendererMemoryStats) {
      const entry = windows.get(webContentsId);
      if (entry) entry.renderer = { ...stats };
    },
    sample,
    watch(name: string, target: WindowEvents) {
      if (!sampling) every(sample, sampleMs);
      sampling = true;
      const key =
        typeof target.webContents.id === 'number'
          ? target.webContents.id
          : fallbackId--;
      windows.get(key)?.cleanup?.();

      const entry: WindowState = {
        id: key,
        name,
        openedAt: now(),
        samples: [],
        highestMb: 0,
        nextReportMb: FIRST_REPORT_MB,
        sent: new Map(),
        targetRef: new WeakRef(target),
      };
      captureLivePid(entry, target);
      windows.set(key, entry);

      const onDidFinishLoad = () => {
        captureLivePid(entry);
      };
      const onGone = (
        _event: unknown,
        details: { reason: string; exitCode: number },
      ) => {
        options.log(
          [
            `window ${entry.name} renderer gone: reason ${details.reason}, exit code ${details.exitCode}, ${secondsSince(entry.openedAt)} s after opening, highest ${entry.highestMb} MB`,
            ...entry.samples.map(sampleLine),
          ].join('\n'),
        );
        entry.samples.length = 0;
        entry.highestMb = 0;
        entry.nextReportMb = FIRST_REPORT_MB;
      };
      const onUnresponsive = () => {
        entry.stoppedAt = now();
        const last = entry.samples.at(-1);
        options.log(
          `window ${entry.name} stopped responding ${secondsSince(entry.openedAt)} s after opening${last ? `, last sample ${last.windowMb} MB` : ''}`,
        );
      };
      const onResponsive = () => {
        if (entry.stoppedAt === undefined) return;
        options.log(
          `window ${entry.name} responding again after ${secondsSince(entry.stoppedAt)} s`,
        );
        entry.stoppedAt = undefined;
      };
      const onClosed = () => {
        entry.cleanup?.();
        if (windows.get(key) === entry) windows.delete(key);
      };

      entry.cleanup = () => {
        const win = entry.targetRef.deref();
        if (!win) return;
        try {
          removeListener(win, 'unresponsive', onUnresponsive);
          removeListener(win, 'responsive', onResponsive);
          removeListener(win, 'closed', onClosed);
          if (!win.isDestroyed?.()) {
            removeListener(
              win.webContents,
              'render-process-gone',
              onGone as (...args: unknown[]) => void,
            );
            removeListener(win.webContents, 'did-finish-load', onDidFinishLoad);
          }
        } catch {
          // Electron tears down webContents before/during closed.
        }
      };

      target.webContents.on('render-process-gone', onGone);
      target.webContents.on('did-finish-load', onDidFinishLoad);
      target.on('unresponsive', onUnresponsive);
      target.on('responsive', onResponsive);
      if (typeof target.once === 'function') target.once('closed', onClosed);
      else target.on('closed', onClosed);
    },
    childGone(details: {
      type: string;
      reason: string;
      exitCode: number;
      name?: string;
    }) {
      if (details.reason === 'clean-exit') return;
      options.log(
        `process gone: ${details.type}${details.name ? ` ${details.name}` : ''}, reason ${details.reason}, exit code ${details.exitCode}`,
      );
    },
  };
}
