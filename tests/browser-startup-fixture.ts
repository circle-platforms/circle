import assert from 'node:assert/strict';
import childProcesses, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { cleanup, scratch } from './helpers.js';

/** A real owned process; IPC gates protocol closure and stderr without platform fds. */
export function ownedStartupBrowser(
  t: TestContext,
  phase: string,
  exits: boolean,
  spawnError?: NodeJS.ErrnoException,
  closeTimeout?: number,
) {
  const root = scratch(t);
  const executable = 'circle-owned-startup-fixture';
  const program = `
process.on('message', (request) => {
  if (request.exit) return process.exit(23);
  if (request.method === ${JSON.stringify(phase)}) {
    process.stderr.write('fixture final startup diagnostic\\n', () =>
      process.send({ stopping: true }, () => {}));
    return;
  }
  process.send({ id: request.id, result: {} }, () => {});
});
`;
  const spawn = childProcesses.spawn;
  let child: ChildProcess | undefined;
  t.mock.method(
    childProcesses,
    'spawn',
    (file: any, args: any, options: any) => {
      if (file !== executable) return spawn(file, args, options);
      const input = new PassThrough();
      const output = new PassThrough();
      const launched = spawn(process.execPath, ['-e', program], {
        ...options,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      child = launched;
      if (spawnError) queueMicrotask(() => launched.emit('error', spawnError));
      launched.stdio[3] = input;
      launched.stdio[4] = output;
      let sawStderr = false;
      let stopping = false;
      const finish = () => {
        if (!sawStderr || !stopping) return;
        stopping = false;
        if (exits) launched.send({ exit: true }, () => {});
        else output.destroy();
      };
      launched.stderr!.on('data', () => {
        sawStderr = true;
        finish();
      });
      launched.on('message', (message: any) => {
        if (message.stopping) {
          stopping = true;
          finish();
        } else output.write(JSON.stringify(message) + '\0');
      });
      // For the known-exit case, EOF is delivered only after the actual exit.
      launched.once('exit', () => output.destroy());
      let pending = '';
      input.on('data', (chunk: Buffer) => {
        pending += chunk.toString();
        let end: number;
        while ((end = pending.indexOf('\0')) >= 0) {
          const request = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          launched.send(request, () => {});
        }
      });
      return child;
    },
  );
  syncBuiltinESMExports();
  const browser = new ChromeBrowser({
    executable,
    headless: true,
    downloads: join(root, 'downloads'),
    trustFile: join(root, 'certificates.json'),
    closeTimeout,
  });
  cleanup(t, async () => {
    try {
      await browser.close();
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
  return {
    browser,
    child: () => {
      assert(child);
      return child;
    },
  };
}
