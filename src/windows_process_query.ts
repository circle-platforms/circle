// Observation only: reaching a marker does not identify a stalled native operation.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const queryStages = [
  'DECODE',
  'LOOKUP',
  'MODULE',
  'DISPOSE',
  'COMPLETE',
] as const;
type Stage = (typeof queryStages)[number];
const markerLimit = 32;

export function windowsProcessQuery(
  names: string[],
  all: boolean,
  nonce = randomBytes(16).toString('hex'),
) {
  if (!/^[a-f0-9]{32}$/.test(nonce))
    throw new Error('invalid query observation nonce');
  if (names.some((name) => name.includes('\0')))
    throw new Error('Windows process image names cannot contain NUL');
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const worker = fileURLToPath(
    new URL(`./windows_process_native${extension}`, import.meta.url),
  );
  return {
    args: [
      worker,
      Buffer.from(JSON.stringify(names), 'utf8').toString('base64'),
      all ? 'all' : 'names',
      nonce,
    ],
    nonce,
  };
}

export function readWindowsProcessRecords(stdout: string) {
  const lines = stdout.split('\n');
  const tail = lines.pop()!;
  let invalidRecords = 0;
  const incompleteRecords = tail.length ? 1 : 0;
  const entries: { pid: number; path: string }[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  for (const line of lines) {
    const match = /^(\d+) ([A-Za-z0-9+/]+={0,2})\r?$/.exec(line);
    if (!match) {
      invalidRecords++;
      continue;
    }
    const bytes = Buffer.from(match[2]!, 'base64');
    if (bytes.toString('base64') !== match[2]) {
      invalidRecords++;
      continue;
    }
    try {
      const path = decoder.decode(bytes);
      if (!path || path.includes('\0')) throw new Error('invalid image path');
      entries.push({ pid: Number(match[1]), path });
    } catch {
      invalidRecords++;
    }
  }
  return { entries, invalidRecords, incompleteRecords };
}

export function readWindowsQueryMarkers(stderr: string, nonce: string) {
  const counts = Object.fromEntries(
    queryStages.map((stage) => [stage, 0]),
  ) as Record<Stage, number>;
  let lastCapturedStage: Stage | 'unknown' = 'unknown';
  let cleaned = '';
  // Preserve every non-marker character, including CRLF and a final partial line.
  for (const line of stderr.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const text = line.endsWith('\n')
      ? line.slice(0, -1).replace(/\r$/, '')
      : undefined;
    const match = text?.match(
      /^CIRCLE_QUERY_([a-f0-9]{32}) (DECODE|LOOKUP|MODULE|DISPOSE|COMPLETE)$/,
    );
    if (!match || match[1] !== nonce) {
      cleaned += line;
      continue;
    }
    const stage = match[2] as Stage;
    counts[stage]++;
    lastCapturedStage = stage;
  }
  return {
    cleaned,
    counts,
    lastCapturedStage,
    possiblyCappedStages: queryStages.filter(
      (stage) => counts[stage] >= markerLimit,
    ),
  };
}

type Markers = ReturnType<typeof readWindowsQueryMarkers>;
// What the runner returned. Absent fields stay unknown rather than being inferred.
export interface WindowsQueryOutcome {
  status: number | null;
  error?: Error;
  pid?: number;
  signal?: NodeJS.Signals | null;
  stdout?: string | null;
  stderr?: string | null;
}
const lineCount = (value: string): number =>
  value ? value.split(/\r?\n/).length - (value.endsWith('\n') ? 1 : 0) : 0;
// Lengths of the decoded strings in UTF-16 code units, not raw pipe bytes; never their content.
const streamSize = (value: string | null | undefined) =>
  typeof value === 'string'
    ? { codeUnits: value.length, lines: lineCount(value) }
    : { codeUnits: 'unknown' as const, lines: 'unknown' as const };
export class WindowsProcessQueryObservation extends Error {
  readonly name = 'WindowsProcessQueryObservation';
  readonly details;
  constructor(
    markers: Markers,
    elapsedMs: number,
    outcome: WindowsQueryOutcome,
    records?: { invalidRecords: number; incompleteRecords: number },
  ) {
    const nativeCode = (outcome.error as NodeJS.ErrnoException | undefined)
      ?.code;
    const errorCode =
      typeof nativeCode === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(nativeCode)
        ? nativeCode
        : 'unknown';
    // A reported PID, including zero, does not establish that the query started; a reported
    // signal does not establish what stopped it.
    const reportedPid =
      typeof outcome.pid === 'number' &&
      Number.isSafeInteger(outcome.pid) &&
      outcome.pid >= 0
        ? outcome.pid
        : 'unknown';
    const signal =
      outcome.signal === null
        ? null
        : typeof outcome.signal === 'string' &&
            /^SIG[A-Z0-9]{1,16}$/.test(outcome.signal)
          ? outcome.signal
          : 'unknown';
    const stdout = streamSize(outcome.stdout);
    const stderr = streamSize(outcome.stderr);
    const counts = queryStages
      .map((stage) => `${stage}=${markers.counts[stage]}`)
      .join(',');
    const capped = markers.possiblyCappedStages.join(',') || 'none';
    const outputProblem = !!(
      records?.invalidRecords || records?.incompleteRecords
    );
    const output = outputProblem
      ? `; stdout records invalid=${records!.invalidRecords}, incomplete=${records!.incompleteRecords}; absence unknown`
      : '';
    super(
      `Windows process query observation: last captured stage: ${markers.lastCapturedStage}; captured counts: ${counts}; possibly capped stages: ${capped}; elapsed ms: ${Math.round(elapsedMs)}; status: ${outcome.status}; error code: ${errorCode}; signal: ${signal}; reported pid: ${reportedPid}; stdout: ${stdout.codeUnits} code units in ${stdout.lines} lines; stderr: ${stderr.codeUnits} code units in ${stderr.lines} lines. Markers show reached boundaries, not the stalled operation${output}`,
    );
    this.details = {
      lastCapturedStage: markers.lastCapturedStage,
      capturedCounts: markers.counts,
      possiblyCappedStages: markers.possiblyCappedStages,
      elapsedMs: Math.round(elapsedMs),
      status: outcome.status,
      errorCode,
      signal,
      reportedPid,
      stdoutCodeUnits: stdout.codeUnits,
      stderrCodeUnits: stderr.codeUnits,
      stdoutLineCount: stdout.lines,
      stderrLineCount: stderr.lines,
      ...(outputProblem
        ? {
            invalidRecords: records!.invalidRecords,
            incompleteRecords: records!.incompleteRecords,
          }
        : {}),
    };
  }
}
