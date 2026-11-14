// A server entry's `headersHelper`: a command Circle runs in a shell each time it connects the server, whose standard
// output is a JSON object of header names and values, sent over the entry's own `headers` of the same names.
import { spawn } from 'node:child_process';
import { shellEnvironment } from './sandbox.js';

/** How long a helper may take. */
export const HEADERS_HELPER_TIMEOUT_MS = 10_000;

/**
 * Runs a helper in `folder` and gives the headers it printed. A helper of a project's `.mcp.json` is a command the
 * person did not write, so it gets the environment without the variables whose names look secret (`own` false).
 */
export function runHeadersHelper(
  command: string,
  options: {
    folder: string;
    server: string;
    url: string;
    own: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<Record<string, string>> {
  const base = options.own
    ? { ...process.env }
    : (shellEnvironment() as NodeJS.ProcessEnv);
  const env = {
    ...base,
    CIRCLE_MCP_SERVER_NAME: options.server,
    CIRCLE_MCP_SERVER_URL: options.url,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.folder || undefined,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, value?: Record<string, string>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      if (error) reject(error);
      else resolve(value!);
    };
    const stop = () => {
      child.kill();
      finish(new Error('headersHelper was stopped'));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new Error(
          `headersHelper did not finish in ${Math.round((options.timeoutMs ?? HEADERS_HELPER_TIMEOUT_MS) / 1000)} seconds`,
        ),
      );
    }, options.timeoutMs ?? HEADERS_HELPER_TIMEOUT_MS);
    timer.unref?.();
    options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 10_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) =>
      finish(new Error(`headersHelper could not start: ${error.message}`)),
    );
    child.on('close', (code) => {
      if (code !== 0) {
        const why = stderr.trim().split(/\r?\n/)[0]?.slice(0, 200);
        finish(
          new Error(
            `headersHelper exited ${code ?? 'without a code'}${why ? `: ${why}` : ''}`,
          ),
        );
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(stdout);
      } catch {
        finish(new Error('headersHelper did not print a JSON object'));
        return;
      }
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        !Object.values(value).every((item) => typeof item === 'string')
      ) {
        finish(
          new Error(
            'headersHelper must print a JSON object of header names and text values',
          ),
        );
        return;
      }
      finish(undefined, value as Record<string, string>);
    });
  });
}
