import {
  createRuntimePerformanceDiagnostics,
  runtimeCommandDiagnosticMetadata,
} from './runtime-performance-diagnostics.js';
import { close as closeFile, open, readFileSync, stat } from 'node:fs';
import { dirname, join } from 'node:path';
import { RuntimeController } from './runtime-controller';
import { pendingResources, ThreadPoolWatch } from './thread-pool-watch';
import { BrowserBridge } from '../../../src/browser/tools.js';
import type { BrowserReply } from '../../../src/browser/protocol.js';
import { RuntimeFixtureModel } from './runtime-fixture';
import { TerminalBridge } from '../../../src/terminal/tools.js';
import type { TerminalReply } from '../../../src/terminal/protocol.js';
import { ModelCatalog } from '../../../src/model_catalog.js';
import { initializeNetwork } from '../../../src/network_bootstrap.js';
import { RuntimeCredentialClient } from './runtime-private-channel';
import { workspaceToolsForWorker, workspaceRuntimePath } from './runtime-tools';
import type { WorkspaceServiceEvent } from './workspace-protocol';
import type { RuntimeTokenDelta } from './runtime-protocol';
import { validatePrivateExternalFileRequest } from './runtime-external-file-channel';
import { DATA_IN_USE, isDesktopDataInUse } from './runtime-failure';
import { redactRuntimeOutput } from './runtime-exit';

type Port = {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
};
const port = (process as unknown as { parentPort: Port }).parentPort;
if (!port) throw Error('Circle runtime needs its native parent process');
async function run() {
  watchThreadPool();
  const home = process.env.CIRCLE_DESKTOP_RUNTIME_HOME;
  if (!home) throw Error('Circle runtime home is missing');
  const workspaceTools = workspaceToolsForWorker(import.meta.url);
  // Child commands, Jobs and their nested package scripts inherit the shipped
  // runtime. This changes only this utility process, never user shell settings.
  process.env.PATH = workspaceRuntimePath(
    workspaceTools.runtimeExecutable,
    process.env.PATH,
  );
  initializeNetwork(home);
  const fixturePath = process.env.CIRCLE_DESKTOP_RUNTIME_FIXTURE;
  let model: RuntimeFixtureModel | undefined;
  if (fixturePath) {
    if (!process.env.CIRCLE_WORKBENCH_TEST_PROFILE)
      throw Error('scripted model requires an explicit test profile');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    model = new RuntimeFixtureModel(fixture);
  }
  const diagnostics = createRuntimePerformanceDiagnostics({
    testProfile: Boolean(process.env.CIRCLE_WORKBENCH_TEST_PROFILE),
    enabled: process.env.CIRCLE_NATIVE_PERF_DIAGNOSTICS === '1',
    dataFolder: dirname(home),
  });
  const browser = new BrowserBridge((message) => port.postMessage(message));
  const credentialStore = new RuntimeCredentialClient((message) =>
    port.postMessage(message),
  );
  const terminal = new TerminalBridge((message) => port.postMessage(message));
  const controller = new RuntimeController({
    home,
    onFatalError: (error) => {
      reportFailure(error);
      void close(1);
    },
    // The supervisor keeps home as runtime-home inside the application's data folder
    dataFolder: dirname(home),
    model,
    browser,
    credentialStore,
    workspaceTools,
    emitWorkspaceEvent: (event: WorkspaceServiceEvent) => {
      diagnostics?.record('workspace-event-sent', {
        resourceId: event.resourceId,
        epoch: event.epoch,
        seq: event.seq,
        sourceSeq: event.sourceSeq,
      });
      port.postMessage({ type: 'workspace-event', event });
    },
    terminal,
    emitTerminalTabs: (conversation, rows) =>
      port.postMessage({ type: 'terminal-tabs', conversation, rows }),
    beforeDelete: async (sessionId) => {
      await browser.releaseSession(sessionId);
      await terminal.releaseSession(sessionId);
    },
    userHome: home,
    // A test profile keeps its ChatGPT host ID with its data, away from ~/.circle.
    // and its ChatGPT plan may point at a local stand-in for OpenAI.
    ...(process.env.CIRCLE_WORKBENCH_TEST_PROFILE
      ? {
          agentHostFile: join(dirname(home), 'agent-host-id'),
          ...(process.env.CIRCLE_CHATGPT_API_URL
            ? { chatgptBaseUrl: process.env.CIRCLE_CHATGPT_API_URL }
            : {}),
        }
      : {}),
    catalog: process.env.CIRCLE_WORKBENCH_TEST_PROFILE
      ? (path) =>
          new ModelCatalog(path, { env: { CIRCLE_NO_MODELS_REFRESH: '1' } })
      : undefined,
    emit: (update) => port.postMessage({ type: 'update', update }),
    emitTokenDelta: (delta: RuntimeTokenDelta) =>
      port.postMessage({ type: 'token-delta', delta }),
    openUrl: (url) => port.postMessage({ type: 'open-url', url }),
  });
  port.on('message', ({ data }) => {
    if ((data as { type?: unknown })?.type === 'external-file-capability') {
      void Promise.resolve()
        .then(async () => {
          const request = validatePrivateExternalFileRequest(data);
          const result =
            request.operation === 'grant'
              ? await controller.grantExternalFile(
                  request.sessionId,
                  request.path!,
                  request.access!,
                )
              : await controller.revokeExternalFileGrant(
                  request.sessionId,
                  request.grantId!,
                );
          controller.publish();
          return { id: request.id, ok: true, data: result };
        })
        .catch((error) => ({
          id: String((data as { id?: unknown })?.id ?? 'invalid'),
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'external file capability failed',
        }))
        .then((reply) => port.postMessage({ type: 'reply', reply }));
      return;
    }

    if ((data as { type?: unknown })?.type === 'credential-reply') {
      credentialStore.receive(data);
      return;
    }
    const message = data as {
      type?: unknown;
      reply?: BrowserReply | TerminalReply;
    };
    if (message?.type === 'browser-reply' && message.reply) {
      browser.receive(message.reply as BrowserReply);
      return;
    }
    if (message?.type === 'terminal-reply' && message.reply) {
      terminal.receive(message.reply as TerminalReply);
      return;
    }
    if (message?.type === 'terminal-tab-control') {
      // The person takes one of their terminal tabs, hands it back or stops Circle on it
      const control = data as {
        id?: unknown;
        conversation?: unknown;
        session?: unknown;
        action?: unknown;
      };
      const id = String(control.id ?? '');
      void Promise.resolve()
        .then(() => {
          if (
            typeof control.conversation !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,100}$/.test(control.conversation) ||
            typeof control.session !== 'string' ||
            !['take', 'return', 'stop'].includes(String(control.action))
          )
            throw Error('invalid terminal tab action');
          return controller.terminalTabControl(
            control.conversation,
            control.session,
            control.action as 'take' | 'return' | 'stop',
          );
        })
        .then(
          (rows) =>
            port.postMessage({
              type: 'terminal-tab-reply',
              id,
              ok: true,
              rows,
            }),
          (error: unknown) =>
            port.postMessage({
              type: 'terminal-tab-reply',
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
      return;
    }
    const metadata = diagnostics
      ? runtimeCommandDiagnosticMetadata(data)
      : undefined;
    if (metadata) diagnostics?.record('command-start', metadata);
    void controller.dispatch(data).then((reply) => {
      if (metadata) diagnostics?.record('command-end', metadata);
      port.postMessage({ type: 'reply', reply });
    });
  });
  let exiting = false;
  async function close(code = 0) {
    if (exiting) return;
    exiting = true;
    await controller.close();
    credentialStore.close();
    diagnostics?.close();
    process.exit(code);
  }
  process.on('SIGTERM', () => {
    void close();
  });
  process.on('SIGINT', () => {
    void close();
  });
  controller.publish();
  await controller.initialize();
}

function reportFailure(error: unknown): void {
  if (isDesktopDataInUse(error))
    port.postMessage({ type: 'runtime-failure', code: DATA_IN_USE });
}

void run().catch((error) => {
  reportFailure(error);
  process.stderr.write(redactRuntimeOutput(String(error)) + '\n');
  process.exit(1);
});

/**
 * Tells the supervisor when libuv's thread pool stops taking work, as macOS has been seen to
 * cause (thread-pool-watch.ts): every file, DNS and crypto operation here would then wait for
 * ever, and the supervisor ends and restarts this process. On by default on macOS only. The
 * test profile can shorten the interval and point the probe at a FIFO, whose open waits for a
 * writer, to stand for a pool that stopped.
 */
function watchThreadPool() {
  const test = Boolean(process.env.CIRCLE_WORKBENCH_TEST_PROFILE);
  const interval = test
    ? Number(process.env.CIRCLE_RUNTIME_POOL_WATCH_MS) || undefined
    : undefined;
  const fifo = test
    ? process.env.CIRCLE_RUNTIME_POOL_PROBE_FIFO || undefined
    : undefined;
  if (process.platform !== 'darwin' && !interval) return;
  new ThreadPoolWatch({
    probe: fifo
      ? (done) =>
          open(fifo, 'r', (error, fd) =>
            error ? done() : closeFile(fd, () => done()),
          )
      : (done) => stat('/', () => done()),
    intervalMs: interval,
    stallMs: interval && interval * 3,
    onStall: ({ waitedMs }) =>
      port.postMessage({
        type: 'thread-pool-stalled',
        waitedMs,
        pending: pendingResources(),
      }),
  }).start();
}
