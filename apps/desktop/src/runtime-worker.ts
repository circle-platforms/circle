import {
  createRuntimePerformanceDiagnostics,
  runtimeCommandDiagnosticMetadata,
} from './runtime-performance-diagnostics.js';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RuntimeController } from './runtime-controller';
import { BrowserBridge } from '../../../src/browser/tools.js';
import type { BrowserReply } from '../../../src/browser/protocol.js';
import { RuntimeFixtureModel } from './runtime-fixture';
import { ModelCatalog } from '../../../src/model_catalog.js';
import { initializeNetwork } from '../../../src/network_bootstrap.js';
import { RuntimeCredentialClient } from './runtime-private-channel';
import { workspaceToolsForWorker, workspaceRuntimePath } from './runtime-tools';
import type { WorkspaceServiceEvent } from './workspace-protocol';
import type { RuntimeTokenDelta } from './runtime-protocol';
import { validatePrivateExternalFileRequest } from './runtime-external-file-channel';

type Port = {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
};
const port = (process as unknown as { parentPort: Port }).parentPort;
if (!port) throw Error('Circle runtime needs its native parent process');
const home = process.env.CIRCLE_DESKTOP_RUNTIME_HOME;
if (!home) throw Error('Circle runtime home is missing');
const workspaceTools = workspaceToolsForWorker(
  import.meta.url,
  process.execPath,
);
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
const controller = new RuntimeController({
  home,
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
  beforeDelete: (sessionId) => browser.releaseSession(sessionId),
  userHome: home,
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
  const message = data as { type?: unknown; reply?: BrowserReply };
  if (message?.type === 'browser-reply' && message.reply) {
    browser.receive(message.reply);
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
async function close() {
  if (exiting) return;
  exiting = true;
  await controller.close();
  credentialStore.close();
  diagnostics?.close();
  process.exit(0);
}
process.on('SIGTERM', () => {
  void close();
});
process.on('SIGINT', () => {
  void close();
});
controller.publish();
void controller.initialize();
