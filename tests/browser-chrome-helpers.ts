import { spawnSync, type ChildProcess } from 'node:child_process';
import { type Server } from 'node:http';
import { ChromeBrowser, findBrowser } from '../src/browser/chrome.js';
import type { CdpPipe } from '../src/browser/cdp.js';
import { listenForBrowser } from './browser-port.mjs';
import {
  BrowserFixture,
  type BrowserFixtureRecord,
} from './browser-fixture.js';

// The terminal's browser, driven for real: a Chrome or Edge without a window, local HTTP and
// HTTPS sites with a certificate made for this test, nothing from the network.
export const executable = findBrowser();
export const openssl = spawnSync('openssl', ['version']).status === 0;
export const skip = !executable
  ? 'no Chrome, Edge or Chromium is installed'
  : !openssl
    ? 'openssl is not on PATH to make a test certificate'
    : false;

export const listen = (server: Server) => listenForBrowser(server);

/** The simulated person hands back a page they have actually finished opening. */
export async function humanNavigation(
  cdp: Pick<CdpPipe, 'on'>,
  session: string,
  url: string,
  signal: AbortSignal,
  action: () => Promise<unknown>,
): Promise<void> {
  const lifecycle = new AbortController();
  const active = AbortSignal.any([signal, lifecycle.signal]);
  const loaded = new Promise<void>((resolve, reject) => {
    let frame: string | undefined;
    const seen: string[] = [];
    let stop = () => {};
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      stop();
      active.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(active.reason ?? Error('handoff stopped'));
    const timer = setTimeout(
      () =>
        finish(
          Error(
            `the human navigation did not finish in 10 s; ${seen.join(', ')}`,
          ),
        ),
      10_000,
    );
    stop = cdp.on((event) => {
      if (event.method === 'Circle.closed')
        return finish(Error('browser closed before human navigation finished'));
      if (event.sessionId !== session) return;
      if (
        event.method === 'Page.frameNavigated' &&
        !event.params.frame.parentId
      ) {
        seen.push(
          `frame ${event.params.frame.id} committed ${event.params.frame.url === url ? 'the expected URL' : 'another URL'}`,
        );
        if (event.params.frame.url === url) frame = event.params.frame.id;
      }
      if (event.method === 'Page.frameStoppedLoading') {
        seen.push(`frame ${event.params.frameId} stopped loading`);
        if (frame && event.params.frameId === frame) finish();
      }
    });
    active.addEventListener('abort', aborted, { once: true });
    if (active.aborted) aborted();
  });
  try {
    await Promise.all([
      loaded,
      Promise.resolve().then(() => {
        active.throwIfAborted();
        return action();
      }),
    ]);
  } finally {
    lifecycle.abort(Error('human navigation wait ended'));
  }
}

/** Diagnostics contain protocol metadata only, never expressions, input, URLs or results. */
export function browserProtocolTrace(chrome: ChromeBrowser) {
  const internal = chrome as unknown as {
    cdp?: CdpPipe;
    send: (
      method: string,
      params?: Record<string, unknown>,
      session?: string,
      options?: Record<string, unknown>,
    ) => Promise<any>;
  };
  const started = Date.now();
  const records: Record<string, unknown>[] = [];
  const pending = new Map<number, Record<string, unknown>>();
  let next = 0;
  let watched: CdpPipe | undefined;
  const add = (record: Record<string, unknown>) => {
    records.push({ at: Date.now() - started, ...record });
    if (records.length > 160) records.shift();
  };
  const send = internal.send.bind(chrome);
  internal.send = (method, params = {}, session, options) => {
    if (internal.cdp && internal.cdp !== watched) {
      watched = internal.cdp;
      watched.on((event) => {
        const detail = event.params;
        const common = {
          kind: 'event',
          method: event.method,
          session: event.sessionId,
        };
        if (event.method === 'Runtime.executionContextCreated')
          add({
            ...common,
            context: detail.context.id,
            frame: detail.context.auxData?.frameId,
            isDefault: detail.context.auxData?.isDefault,
          });
        else if (event.method === 'Runtime.executionContextDestroyed')
          add({ ...common, context: detail.executionContextId });
        else if (event.method === 'Page.frameNavigated')
          add({
            ...common,
            frame: detail.frame.id,
            loader: detail.frame.loaderId,
            main: !detail.frame.parentId,
          });
        else if (
          ['Page.frameStartedLoading', 'Page.frameStoppedLoading'].includes(
            event.method,
          )
        )
          add({ ...common, frame: detail.frameId });
        else if (
          [
            'Runtime.executionContextsCleared',
            'Page.loadEventFired',
            'Circle.closed',
          ].includes(event.method)
        )
          add(common);
        else if (event.method === 'Animation.animationStarted')
          add({
            ...common,
            animation: detail.animation.id,
            type: detail.animation.type,
            duration: detail.animation.source?.duration,
            delay: detail.animation.source?.delay,
          });
        else if (event.method === 'Animation.animationCanceled')
          add({ ...common, animation: detail.id });
      });
    }
    const id = ++next;
    const at = Date.now();
    const request = {
      id,
      method,
      session,
      context: params.contextId,
      awaitPromise: params.awaitPromise,
    };
    pending.set(id, { ...request, started: at });
    add({ kind: 'request', ...request });
    if (method === 'Page.enable')
      void send('Animation.enable', {}, session).catch(() => {});
    return send(method, params, session, options).then(
      (value) => {
        pending.delete(id);
        add({
          kind: 'response',
          id,
          method,
          elapsed: Date.now() - at,
          exception: !!value?.exceptionDetails,
        });
        return value;
      },
      (error) => {
        pending.delete(id);
        add({ kind: 'request-error', id, method, elapsed: Date.now() - at });
        throw error;
      },
    );
  };
  return () => ({
    pending: [...pending.values()].map(({ started: at, ...request }) => ({
      ...request,
      elapsed: Date.now() - Number(at),
    })),
    recent: records,
  });
}

/** Immediate, bounded-fixture records contain identities and protocol state only. */
export function browserFixture(
  chrome: ChromeBrowser,
  budgetMs: number,
  report: (record: BrowserFixtureRecord) => void = (record) =>
    process.stderr.write(JSON.stringify({ browserFixture: record }) + '\n'),
) {
  const internal = chrome as unknown as {
    child?: ChildProcess;
    ownedRoots?: Set<ChildProcess>;
    conversations: Map<
      string,
      {
        active?: string;
        tabs: Map<
          string,
          {
            session: string;
            dialogs: { id: string; type: string }[];
            intercepting?: boolean;
            chooser?: unknown;
          }
        >;
      }
    >;
  };
  const protocol = browserProtocolTrace(chrome);
  return new BrowserFixture({
    budgetMs,
    report,
    close: () => chrome.close(),
    ownedRoots: () => [...(internal.ownedRoots ?? []), internal.child],
    state: () => ({
      process: internal.child
        ? {
            pid: internal.child.pid,
            exitCode: internal.child.exitCode,
            signalCode: internal.child.signalCode,
          }
        : undefined,
      conversations: [...internal.conversations].map(([id, conversation]) => ({
        id,
        active: conversation.active,
        tabs: [...conversation.tabs].map(([id, tab]) => ({
          id,
          session: tab.session,
          dialogs: tab.dialogs.map(({ id, type }) => ({ id, type })),
          intercepting: tab.intercepting,
          chooser: !!tab.chooser,
        })),
      })),
      pending: protocol().pending.map((entry) => {
        const { method, session, elapsed } = entry as Record<string, unknown>;
        return { method, session, elapsed };
      }),
    }),
  });
}
