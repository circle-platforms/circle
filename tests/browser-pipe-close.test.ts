import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { cleanup, scratch } from './helpers.js';

async function within(
  work: Promise<void>,
  milliseconds: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('owned browser pipes did not close')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test(
  'browser exit closes its pipes while a detached helper still holds inherited stderr',
  { skip: process.platform === 'win32', timeout: 10_000 },
  async (t) => {
    const root = scratch(t);
    const executable = join(root, 'browser');
    const script = join(root, 'browser.cjs');
    const helperPidFile = join(root, 'helper.pid');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      executable,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      script,
      `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const helper = spawn(process.execPath, ['-e', ${JSON.stringify(`
  process.stderr.write('detached helper inherited stderr\\n', () => process.send('ready'));
  setInterval(() => {}, 1000);
`)}], { detached: true, stdio: ['ignore', 'ignore', 2, 'ipc'] });
fs.writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
helper.once('message', () => {
  helper.disconnect();
  helper.unref();
  const input = fs.createReadStream(null, { fd: 3, autoClose: false });
  let pending = '';
  input.on('data', (chunk) => {
    pending += chunk.toString();
    let end;
    while ((end = pending.indexOf('\\0')) >= 0) {
      const request = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      fs.writeSync(4, JSON.stringify({ id: request.id, result: {} }) + '\\0');
      if (request.method === 'Browser.close') process.exit(0);
    }
  });
});
`,
    );
    const browser = new ChromeBrowser({
      executable,
      headless: true,
      downloads: join(root, 'downloads'),
      startTimeout: 2000,
      closeTimeout: 300,
    });
    const state = browser as unknown as {
      start(): Promise<unknown>;
      child?: ChildProcess;
    };
    let child: ChildProcess | undefined;
    cleanup(t, async () => {
      // The stand-in helper has its own process group, just as an external updater can.
      // Only the helper made by this test is stopped, even when the assertion fails.
      if (existsSync(helperPidFile)) {
        const pid = Number(readFileSync(helperPidFile, 'utf8'));
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      for (const stream of child?.stdio ?? []) stream?.destroy();
      await browser.close();
    });
    await state.start();
    child = state.child!;
    const helperPid = Number(readFileSync(helperPidFile, 'utf8'));
    assert.equal(process.kill(helperPid, 0), true);
    assert.equal(child.stderr?.destroyed, false);
    const closed = new Promise<void>((resolve) =>
      child!.once('close', resolve),
    );
    await browser.close();
    await within(closed, 2000);
    assert.equal(child.exitCode, 0);
    for (const stream of child.stdio)
      if (stream) assert.equal(stream.destroyed, true);
    assert.equal(
      process.kill(helperPid, 0),
      true,
      'closing the owned pipes must leave the detached helper running',
    );
  },
);
