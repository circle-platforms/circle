import { closeSync, openSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { validateWorkspaceRequest } from './workspace-protocol.js';

/** Never copy arbitrary names, parameters or model content into diagnostics. */
export function runtimeCommandDiagnosticMetadata(value: unknown) {
  const command = value as {
    id?: unknown;
    name?: unknown;
    payload?: unknown;
  } | null;
  const id =
    typeof command?.id === 'string' && /^[a-f0-9-]{36}$/i.test(command.id)
      ? command.id
      : undefined;
  if (command?.name === 'workspace-service') {
    try {
      const payload = command.payload as {
        service?: unknown;
        method?: unknown;
      } | null;
      const request = validateWorkspaceRequest({
        service: payload?.service,
        method: payload?.method,
      });
      return {
        id,
        name: 'workspace-service',
        service: request.service,
        method: request.method,
      };
    } catch {
      /* Unknown metadata is not evidence and must not be copied. */
    }
  }
  return { id, name: 'other-command' };
}

/** Scratch-only and fail-safe: diagnostic I/O cannot interrupt dispatch, emission or shutdown. */
export function createRuntimePerformanceDiagnostics(options: {
  testProfile: boolean;
  enabled: boolean;
  dataFolder: string;
  maxBytes?: number;
  io?: {
    open?: typeof openSync;
    write?: typeof writeSync;
    close?: typeof closeSync;
  };
}) {
  if (!options.testProfile || !options.enabled) return undefined;
  const epoch = randomUUID();
  const path = join(
    options.dataFolder,
    `performance-worker-events-${epoch}.jsonl`,
  );
  const io = {
    open: openSync,
    write: writeSync,
    close: closeSync,
    ...options.io,
  };
  let fd: number | undefined, unavailable: string | undefined;
  let bytes = 0,
    dropped = 0,
    closed = false;
  const fail = (error: unknown) => {
    unavailable = String(
      (error as NodeJS.ErrnoException)?.code ?? 'DIAGNOSTIC_IO_ERROR',
    );
    if (fd !== undefined) {
      try {
        io.close(fd);
      } catch {}
      fd = undefined;
    }
    // Codes only: no path, message, parameters or credentials.
    console.error('native performance diagnostics unavailable:', unavailable);
  };
  try {
    fd = io.open(path, 'wx', 0o600);
  } catch (error) {
    fail(error);
  }
  const maximum = options.maxBytes ?? 4 * 1024 * 1024;
  const record = (
    phase: string,
    fields: Record<string, string | number | undefined>,
  ) => {
    if (closed || fd === undefined) return;
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
    const line =
      JSON.stringify({ phase, at: Date.now(), epoch, ...safe }) + '\n';
    if (bytes + Buffer.byteLength(line) > maximum) {
      dropped++;
      return;
    }
    try {
      io.write(fd, line);
      bytes += Buffer.byteLength(line);
    } catch (error) {
      fail(error);
    }
  };
  return {
    record,
    get status() {
      return { epoch, path, unavailable, dropped, bytes };
    },
    close() {
      if (closed) return;
      if (fd !== undefined) {
        try {
          io.write(
            fd,
            JSON.stringify({
              phase: 'diagnostics-closed',
              at: Date.now(),
              epoch,
              dropped,
              bytes,
            }) + '\n',
          );
        } catch (error) {
          fail(error);
        }
      }
      closed = true;
      if (fd !== undefined) {
        try {
          io.close(fd);
        } catch (error) {
          fail(error);
        }
        fd = undefined;
      }
    },
  };
}
