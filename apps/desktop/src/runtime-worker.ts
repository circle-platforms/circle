import { readFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from './runtime-controller';
import { BrowserBridge } from '../../../src/browser/tools.js';
import type { BrowserReply } from '../../../src/browser/protocol.js';
import { ScriptedModel } from '../../../src/testing.js';
import { emptyUsage, type ModelResponse } from '../../../src/types.js';
import { ModelCatalog } from '../../../src/model_catalog.js';

type Port = {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
};
const port = (process as unknown as { parentPort: Port }).parentPort;
if (!port) throw Error('Circle runtime needs its native parent process');
const home = process.env.CIRCLE_DESKTOP_RUNTIME_HOME;
if (!home) throw Error('Circle runtime home is missing');
const fixturePath = process.env.CIRCLE_DESKTOP_RUNTIME_FIXTURE;
let model: ScriptedModel | undefined;
if (fixturePath) {
  if (!process.env.CIRCLE_WORKBENCH_TEST_PROFILE)
    throw Error('scripted model requires an explicit test profile');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  model = new ScriptedModel(
    fixture.replies.map(
      (entry: {
        message?: ModelResponse['message'];
        delayMs?: number;
        waitForAbort?: boolean;
        chunks?: string[];
      }) =>
        async (request: Parameters<ScriptedModel['complete']>[0]) => {
          if (fixture.requestsPath)
            appendFileSync(
              fixture.requestsPath,
              JSON.stringify({
                system: request.system,
                messages: request.messages,
                tools: request.tools.map(
                  ({ run: _run, approvalFacts: _facts, ...tool }) => tool,
                ),
              }) + '\n',
              { mode: 0o600 },
            );
          if (entry.waitForAbort)
            await new Promise<void>((_resolve, reject) => {
              const abort = () =>
                reject(request.signal.reason ?? Error('aborted'));
              request.signal.addEventListener('abort', abort, { once: true });
              if (request.signal.aborted) abort();
            });
          for (const chunk of entry.chunks ?? []) {
            request.token(chunk);
            await delay(entry.delayMs ?? 15, undefined, {
              signal: request.signal,
            });
          }
          if (entry.delayMs && !entry.chunks)
            await delay(entry.delayMs, undefined, { signal: request.signal });
          const message = entry.message ?? {
            id: randomUUID(),
            role: 'assistant',
            content: (entry.chunks ?? []).join(''),
          };
          if (message.content && !entry.chunks) request.token(message.content);
          return { message, usage: emptyUsage() };
        },
    ),
  );
}
const browser = new BrowserBridge((message) => port.postMessage(message));
const controller = new RuntimeController({
  home,
  model,
  browser,
  userHome: home,
  catalog: process.env.CIRCLE_WORKBENCH_TEST_PROFILE
    ? (path) =>
        new ModelCatalog(path, { env: { CIRCLE_NO_MODELS_REFRESH: '1' } })
    : undefined,
  emit: (update) => port.postMessage({ type: 'update', update }),
});
port.on('message', ({ data }) => {
  const message = data as { type?: unknown; reply?: BrowserReply };
  if (message?.type === 'browser-reply' && message.reply) {
    browser.receive(message.reply);
    return;
  }
  void controller
    .dispatch(data)
    .then((reply) => port.postMessage({ type: 'reply', reply }));
});
let exiting = false;
async function close() {
  if (exiting) return;
  exiting = true;
  await controller.close();
  process.exit(0);
}
process.on('SIGTERM', () => {
  void close();
});
process.on('SIGINT', () => {
  void close();
});
controller.publish();
