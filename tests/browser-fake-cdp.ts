import assert from 'node:assert/strict';
import childProcesses, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';
import { ChromeBrowser, type ChromeOptions } from '../src/browser/chrome.js';
import type { CdpPipe } from '../src/browser/cdp.js';
import { cleanup, scratch } from './helpers.js';

export interface FakeRequest {
  id: number;
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

/**
 * What the fake browser does with one request: `true` when the test took it (answered it
 * later, or never), anything else for the stand-in's ordinary answer.
 */
export type FakeHandler = (
  request: FakeRequest,
  fake: FakeBrowser,
) => boolean | void;

export interface FakeBrowser {
  browser: ChromeBrowser;
  /** Every request Circle sent, in order. */
  requests: FakeRequest[];
  answer(request: FakeRequest, result?: Record<string, unknown>): void;
  /** Answers with the browser's own protocol error. */
  refuse(request: FakeRequest, message: string): void;
  emit(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): void;
  /** The browser's protocol pipe ends, as when it crashes; the process is killed too. */
  crash(): void;
  /**
   * The browser ends by itself, in the order a real one is seen to: its protocol pipe
   * closes first, then it writes its last words and exits with `code`.
   */
  end(lastWords: string, code: number): void;
  child(): ChildProcess;
  /** The commands the pipe still waits on. */
  pending(): { method: string; target: string }[];
  /** Resolves once Circle has sent `method` (for `session`, when given). */
  sent(method: string, sessionId?: string): Promise<FakeRequest>;
}

/**
 * A stand-in for Chrome behind Circle's own pipe: a real owned process (so a test sees that
 * none is left), whose protocol this test answers. It answers like a page that loads at once,
 * except where `handle` takes a request.
 */
export function fakeBrowser(
  t: TestContext,
  handle: FakeHandler = () => {},
  options: Partial<ChromeOptions> = {},
): FakeBrowser {
  const root = scratch(t, 'circle-fake-cdp-');
  const executable = 'circle-fake-cdp-browser';
  const spawn = childProcesses.spawn;
  let child: ChildProcess | undefined;
  let output: PassThrough | undefined;
  const requests: FakeRequest[] = [];
  const watchers: {
    method: string;
    sessionId?: string;
    resolve: (request: FakeRequest) => void;
  }[] = [];
  let targets = 0;
  let loaders = 0;
  const write = (message: Record<string, unknown>) => {
    if (output && !output.destroyed)
      output.write(JSON.stringify(message) + '\0');
  };
  const sessionOf = (targetId: string) => `S-${targetId}`;
  const targetOf = (sessionId?: string) => sessionId?.replace(/^S-/, '') ?? '';
  const createTarget = (url: string) => {
    const targetId = `T${++targets}`;
    queueMicrotask(() =>
      fake.emit('Target.targetCreated', {
        targetInfo: { targetId, type: 'page', url, title: '' },
      }),
    );
    return targetId;
  };
  const ordinary = (request: FakeRequest) => {
    const { method, params, sessionId } = request;
    switch (method) {
      case 'Browser.getVersion':
        return fake.answer(request, { product: 'FakeChrome/1' });
      case 'Target.setDiscoverTargets':
        fake.answer(request);
        createTarget('about:blank');
        return;
      case 'Target.createTarget':
        return fake.answer(request, { targetId: createTarget(params.url) });
      case 'Target.attachToTarget':
        return fake.answer(request, { sessionId: sessionOf(params.targetId) });
      case 'Page.getFrameTree':
        return fake.answer(request, {
          frameTree: { frame: { id: targetOf(sessionId) } },
        });
      case 'Page.createIsolatedWorld':
        return fake.answer(request, { executionContextId: 7 });
      case 'Runtime.evaluate': {
        const expression = String(params.expression);
        if (expression === 'document.title')
          return fake.answer(request, { result: { value: 'Fake page' } });
        if (expression === 'document.visibilityState')
          return fake.answer(request, { result: { value: 'visible' } });
        const command = /\}\)\("([a-z-]+)",/.exec(expression)?.[1];
        return fake.answer(request, {
          result: {
            value: {
              ok: true,
              value: command === 'snapshot' ? '- heading "Fake page"' : true,
            },
          },
        });
      }
      case 'Page.navigate': {
        const loaderId = `L${++loaders}`;
        fake.answer(request, { frameId: targetOf(sessionId), loaderId });
        fake.emit(
          'Page.frameNavigated',
          { frame: { id: targetOf(sessionId), url: params.url, loaderId } },
          sessionId,
        );
        return;
      }
      case 'Browser.close':
        fake.answer(request);
        child?.send({ exit: true }, () => {});
        return;
      default:
        return fake.answer(request);
    }
  };
  const fake: FakeBrowser = {
    browser: undefined as unknown as ChromeBrowser,
    requests,
    answer(request, result = {}) {
      write({
        id: request.id,
        result,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      });
    },
    refuse(request, message) {
      write({
        id: request.id,
        error: { code: -32000, message },
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      });
    },
    emit(method, params, sessionId) {
      write({ method, params, ...(sessionId ? { sessionId } : {}) });
    },
    crash() {
      output?.destroy();
      child?.kill('SIGKILL');
    },
    end(lastWords, code) {
      output?.destroy();
      child?.send({ end: { lastWords, code } }, () => {});
    },
    child: () => {
      assert(child, 'the fake browser was not started');
      return child;
    },
    pending: () =>
      (fake.browser as unknown as { cdp?: CdpPipe }).cdp?.pending ?? [],
    sent(method, sessionId) {
      const seen = requests.find(
        (request) =>
          request.method === method &&
          (sessionId === undefined || request.sessionId === sessionId),
      );
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) =>
        watchers.push({ method, sessionId, resolve }),
      );
    },
  };
  t.mock.method(
    childProcesses,
    'spawn',
    (file: any, args: any, spawnOptions: any) => {
      if (file !== executable) return spawn(file, args, spawnOptions);
      const input = new PassThrough();
      output = new PassThrough();
      const launched = spawn(
        process.execPath,
        [
          '-e',
          "process.on('message', (m) => { if (m.exit) process.exit(0); if (m.end) process.stderr.write(m.end.lastWords + '\\n', () => process.exit(m.end.code)); }); setInterval(() => {}, 1000);",
        ],
        { ...spawnOptions, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      child = launched;
      launched.stdio[3] = input;
      launched.stdio[4] = output;
      const ended = output;
      launched.once('exit', () => ended.destroy());
      let buffer = '';
      input.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf('\0')) >= 0) {
          const request = JSON.parse(buffer.slice(0, end)) as FakeRequest;
          buffer = buffer.slice(end + 1);
          request.params ??= {};
          requests.push(request);
          for (const watcher of [...watchers])
            if (
              watcher.method === request.method &&
              (watcher.sessionId === undefined ||
                watcher.sessionId === request.sessionId)
            ) {
              watchers.splice(watchers.indexOf(watcher), 1);
              watcher.resolve(request);
            }
          if (handle(request, fake) !== true) ordinary(request);
        }
      });
      return launched;
    },
  );
  syncBuiltinESMExports();
  fake.browser = new ChromeBrowser({
    executable,
    headless: true,
    downloads: join(root, 'downloads'),
    trustFile: join(root, 'certificates.json'),
    closeTimeout: 2000,
    ...options,
  });
  cleanup(t, async () => {
    try {
      await fake.browser.close();
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
  return fake;
}

/** After close: the owned process exited and its protocol pipe holds nothing. */
export function assertNothingLeft(fake: FakeBrowser) {
  const child = fake.child();
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    'the fake browser process is still running',
  );
  for (const stream of [child.stdio[3], child.stdio[4]])
    assert.equal(stream?.destroyed, true, 'a protocol pipe is still open');
  assert.deepEqual(fake.pending(), []);
}
