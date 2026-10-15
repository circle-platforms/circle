import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { cancellationFixture, cleanup, scratch } from './helpers.js';

function browserWithChild(child: ChildProcess) {
  const browser = new ChromeBrowser({
    executable: process.execPath,
    closeTimeout: 40,
  });
  const state = browser as any;
  state.child = child;
  state.cdp = { send: async () => {}, close: () => {} };
  return browser;
}

test('browser close waits for its actual owned descendant to exit before returning', async (t) => {
  const root = scratch(t);
  const fixture = await cancellationFixture(t, root);
  if (process.platform !== 'win32')
    writeFileSync(
      join(root, 'grandchild.cjs'),
      readFileSync(join(root, 'grandchild.cjs'), 'utf8') +
        "\nprocess.on('SIGTERM',()=>{});\n",
    );
  const child = spawn(process.execPath, [join(root, 'parent.cjs')], {
    cwd: root,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  const browser = browserWithChild(child);
  cleanup(t, () => browser.close());
  await fixture.ready();
  const closing = browser.close();
  assert.equal(
    browser.close(),
    closing,
    'simultaneous closes share one cleanup',
  );
  await closing;
  assert(child.exitCode !== null || child.signalCode !== null);
  assert.equal(await fixture.release(), 'closed');
});

test(
  'browser close escalates an ignored graceful signal and awaits the actual exit',
  { skip: process.platform === 'win32' },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    cleanup(t, () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    const browser = browserWithChild(child);
    await browser.close();
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(child.exitCode, null);
  },
);

test('browser cleanup failure rejects and remains retryable instead of confirming deletion', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 1_073_741_824,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => false,
  }) as unknown as ChildProcess;
  const browser = browserWithChild(child);
  await assert.rejects(
    browser.close(),
    /browser process did not stop|taskkill/i,
  );
  (child as unknown as { exitCode: number | null }).exitCode = 0;
  child.emit('exit', 0, null);
  await browser.close();
});
