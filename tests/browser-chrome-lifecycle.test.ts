import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChromeBrowser, findBrowser } from '../src/browser/chrome.js';
import type { CdpPipe } from '../src/browser/cdp.js';
import { getEventListeners } from 'node:events';
import { cleanup, scratch as made } from './helpers.js';
import { humanNavigation } from './browser-chrome-helpers.js';

test('findBrowser looks where Chrome and Edge are installed, and CIRCLE_BROWSER wins', () => {
  const present = (paths: string[]) => (path: string) => paths.includes(path);
  assert.equal(
    findBrowser(
      {
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
      },
      'win32',
      present(['C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']),
    ),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  );
  // Chrome before Edge, wherever each is
  assert.equal(
    findBrowser(
      {
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
      },
      'win32',
      present([
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      ]),
    ),
    'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  );
  assert.equal(
    findBrowser(
      { HOME: '/Users/a' },
      'darwin',
      present([
        '/Users/a/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]),
    ),
    '/Users/a/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  );
  assert.equal(
    findBrowser(
      { PATH: '/usr/local/bin:/usr/bin' },
      'linux',
      present(['/usr/bin/chromium', '/usr/bin/google-chrome']),
    ),
    '/usr/bin/google-chrome',
  );
  assert.equal(
    findBrowser(
      { CIRCLE_BROWSER: '/opt/x/chrome', PATH: '/usr/bin' },
      'linux',
      present(['/opt/x/chrome', '/usr/bin/google-chrome']),
    ),
    '/opt/x/chrome',
  );
  assert.equal(
    findBrowser({ CIRCLE_BROWSER: '/missing' }, 'linux', present([])),
    undefined,
  );
  assert.equal(
    findBrowser({ PATH: '/usr/bin' }, 'linux', present([])),
    undefined,
  );
});

test(
  'a browser that does not answer in time is stopped, and the action says it did not start',
  {
    skip:
      process.platform === 'win32'
        ? 'the program that never answers is a shell script'
        : false,
  },
  async (t) => {
    const root = made(t);
    // Takes the browser's arguments and never answers on the pipe
    const silent = join(root, 'silent-browser');
    writeFileSync(silent, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const chrome = new ChromeBrowser({
      executable: silent,
      headless: true,
      downloads: join(root, 'downloads'),
      startTimeout: 300,
    });
    cleanup(t, () => chrome.close());
    const started = Date.now();
    await assert.rejects(
      chrome.request('c', 'snapshot', {}, new AbortController().signal),
      /^Error: the browser did not start in 0\.3 s$/,
    );
    assert.ok(Date.now() - started < 10_000);
    const child = (chrome as unknown as { child: ChildProcess }).child;
    assert.equal(child.killed, true);
  },
);

test('close returns only after the browser it stopped has exited, and kills one that will not stop', async (t) => {
  // Stand-ins for a browser that does not close when asked: one is slow to finish once it is
  // stopped, as a loaded Windows machine was; the other ignores the stop.
  const programs = {
    slow: "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 700));",
    deaf: "process.on('SIGTERM', () => {});",
  };
  const root = made(t);
  const stopped = await Promise.all(
    Object.values(programs).map(async (program) => {
      const child = spawn(
        process.execPath,
        ['-e', `${program} setInterval(() => {}, 1000); console.log('ready');`],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      t.after(() => void child.kill('SIGKILL'));
      await new Promise((resolve) => child.stdout.once('data', resolve));
      const chrome = new ChromeBrowser({
        executable: process.execPath,
        headless: true,
        downloads: join(root, 'downloads'),
      });
      (chrome as unknown as { child: ChildProcess }).child = child;
      await chrome.close();
      return child;
    }),
  );
  for (const child of stopped) {
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' });
  }
  if (process.platform !== 'win32') {
    const [slow, deaf] = stopped;
    assert.equal(slow!.exitCode, 0);
    assert.equal(deaf!.signalCode, 'SIGKILL');
  }
});

test('human navigation observes a rejected CDP send and removes the navigation listener', async () => {
  const listeners = new Set<Parameters<CdpPipe['on']>[0]>();
  const cdp = {
    on: (listener: Parameters<CdpPipe['on']>[0]) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const controller = new AbortController();
  const failure = Error('fixture send rejected');
  await assert.rejects(
    humanNavigation(
      cdp,
      'session',
      'http://fixture/b',
      controller.signal,
      async () => {
        throw failure;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(listeners.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('aborted human navigation removes its event listener and retains the abort reason', async () => {
  const listeners = new Set<Parameters<CdpPipe['on']>[0]>();
  const cdp = {
    on: (listener: Parameters<CdpPipe['on']>[0]) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const controller = new AbortController();
  let sent!: () => void;
  const started = new Promise<void>((resolve) => (sent = resolve));
  const pending = humanNavigation(
    cdp,
    'session',
    'http://fixture/b',
    controller.signal,
    () => {
      sent();
      return new Promise(() => {});
    },
  );
  const failure = Error('fixture handoff stopped');
  const rejected = assert.rejects(pending, (error) => error === failure);
  await started;
  controller.abort(failure);
  await rejected;
  assert.equal(listeners.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
