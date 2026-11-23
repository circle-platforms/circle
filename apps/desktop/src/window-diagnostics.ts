/**
 * What a window cost before it died, so that a crash can be named afterwards. A renderer
 * that runs out of memory takes its own figures with it, so the main process keeps them.
 * Numbers and channel names only: no session, file or model text reaches the log.
 */
export const WINDOW_SAMPLE_MS = 30_000;
const KEPT_SAMPLES = 40;
const FIRST_REPORT_MB = 1024;
const REPORT_STEP_MB = 512;

interface ProcessMemory {
  pid: number;
  memory: { workingSetSize: number };
}
interface WindowEvents {
  on(event: 'unresponsive' | 'responsive', listener: () => void): unknown;
  webContents: {
    on(
      event: 'render-process-gone',
      listener: (
        event: unknown,
        details: { reason: string; exitCode: number },
      ) => void,
    ): unknown;
  };
}
interface Sample {
  at: number;
  windowMb: number;
  totalMb: number;
  sends: Array<{ channel: string; count: number; chars: number | null }>;
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
  return [
    new Date(sample.at).toISOString(),
    `window ${sample.windowMb} MB`,
    `all ${sample.totalMb} MB`,
    ...sends,
  ].join(', ');
}

export function createWindowDiagnostics(options: {
  log: (text: string) => void;
  /** The processes of the application's own windows, not of the pages in its browser panels. */
  windowPids: () => number[];
  metrics: () => ProcessMemory[];
  now?: () => number;
  every?: (run: () => void, ms: number) => void;
}) {
  const now = options.now ?? Date.now;
  const every = options.every ?? ((run, ms) => setInterval(run, ms).unref?.());
  const sent = new Map<
    string,
    { count: number; reported: number; latest: unknown[] }
  >();
  const samples: Sample[] = [];
  let highestMb = 0;
  let nextReportMb = FIRST_REPORT_MB;
  let sampling = false;
  const secondsSince = (at: number) => Math.round((now() - at) / 1000);
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
      mb: megabytes(one.memory.workingSetSize),
    }));
    const taken: Sample = {
      at: now(),
      windowMb: Math.max(
        0,
        ...sizes.filter((one) => pids.includes(one.pid)).map((one) => one.mb),
      ),
      totalMb: sizes.reduce((total, one) => total + one.mb, 0),
      sends: [...sent]
        .filter(([, one]) => one.count > one.reported)
        .map(([channel, one]) => {
          const count = one.count - one.reported;
          one.reported = one.count;
          return { channel, count, chars: charsOf(one.latest) };
        }),
    };
    samples.push(taken);
    if (samples.length > KEPT_SAMPLES) samples.shift();
    highestMb = Math.max(highestMb, taken.windowMb);
    if (taken.windowMb < nextReportMb) return;
    while (taken.windowMb >= nextReportMb) nextReportMb += REPORT_STEP_MB;
    options.log(`window memory: ${sampleLine(taken)}`);
  };
  return {
    sent(channel: string, args: unknown[]) {
      const known = sent.get(channel);
      if (known) {
        known.count++;
        known.latest = args;
      } else sent.set(channel, { count: 1, reported: 0, latest: args });
    },
    sample,
    watch(name: string, target: WindowEvents) {
      if (!sampling) every(sample, WINDOW_SAMPLE_MS);
      sampling = true;
      const openedAt = now();
      let stoppedAt: number | undefined;
      target.webContents.on('render-process-gone', (_event, details) => {
        options.log(
          [
            `window ${name} renderer gone: reason ${details.reason}, exit code ${details.exitCode}, ${secondsSince(openedAt)} s after opening, highest ${highestMb} MB`,
            ...samples.map(sampleLine),
          ].join('\n'),
        );
        samples.length = 0;
        highestMb = 0;
        nextReportMb = FIRST_REPORT_MB;
      });
      target.on('unresponsive', () => {
        stoppedAt = now();
        const last = samples.at(-1);
        options.log(
          `window ${name} stopped responding ${secondsSince(openedAt)} s after opening${last ? `, last sample ${last.windowMb} MB` : ''}`,
        );
      });
      target.on('responsive', () => {
        if (stoppedAt === undefined) return;
        options.log(
          `window ${name} responding again after ${secondsSince(stoppedAt)} s`,
        );
        stoppedAt = undefined;
      });
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
