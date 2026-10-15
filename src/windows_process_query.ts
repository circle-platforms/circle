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
export class WindowsProcessQueryObservation extends Error {
  readonly name = 'WindowsProcessQueryObservation';
  readonly details;
  constructor(
    markers: Markers,
    elapsedMs: number,
    outcome: { status: number | null; error?: Error },
  ) {
    const nativeCode = (outcome.error as NodeJS.ErrnoException | undefined)
      ?.code;
    const errorCode =
      typeof nativeCode === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(nativeCode)
        ? nativeCode
        : 'unknown';
    const counts = queryStages
      .map((stage) => `${stage}=${markers.counts[stage]}`)
      .join(',');
    const capped = markers.possiblyCappedStages.join(',') || 'none';
    super(
      `Windows process query observation: last captured stage: ${markers.lastCapturedStage}; captured counts: ${counts}; possibly capped stages: ${capped}; elapsed ms: ${Math.round(elapsedMs)}; status: ${outcome.status}; error code: ${errorCode}. Markers show reached boundaries, not the stalled operation`,
    );
    this.details = {
      lastCapturedStage: markers.lastCapturedStage,
      capturedCounts: markers.counts,
      possiblyCappedStages: markers.possiblyCappedStages,
      elapsedMs: Math.round(elapsedMs),
      status: outcome.status,
      errorCode,
    };
  }
}
