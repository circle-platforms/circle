import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** Explicit scratch-profile diagnostic. Never records parameters, replies or message text. */
export function createRuntimePerformanceDiagnostics(options: {
  testProfile: boolean;
  enabled: boolean;
  dataFolder: string;
  maxBytes?: number;
}) {
  if (!options.testProfile || !options.enabled) return undefined;
  const fd = openSync(
    join(options.dataFolder, 'performance-worker-events.jsonl'),
    'wx',
    0o600,
  );
  const maximum = options.maxBytes ?? 4 * 1024 * 1024;
  let bytes = 0,
    dropped = 0,
    closed = false;
  const record = (
    phase: string,
    fields: Record<string, string | number | undefined>,
  ) => {
    if (closed) return;
    const safe = Object.fromEntries(
      Object.entries(fields)
        .filter(
          ([, value]) =>
            (typeof value === 'number' && Number.isFinite(value)) ||
            typeof value === 'string',
        )
        .map(([key, value]) => [
          key,
          typeof value === 'string' ? value.slice(0, 256) : value,
        ]),
    );
    const line = JSON.stringify({ phase, at: Date.now(), ...safe }) + '\n';
    if (bytes + Buffer.byteLength(line) > maximum) {
      dropped++;
      return;
    }
    writeSync(fd, line);
    bytes += Buffer.byteLength(line);
  };
  return {
    record,
    close() {
      if (closed) return;
      // Reserved final evidence may exceed the data cap by one small metadata record.
      writeSync(
        fd,
        JSON.stringify({
          phase: 'diagnostics-closed',
          at: Date.now(),
          dropped,
          bytes,
        }) + '\n',
      );
      closed = true;
      closeSync(fd);
    },
  };
}
