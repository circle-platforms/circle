import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import type { DesktopBridge, PopoutAttachment } from '../src/contracts.ts';

// The preload as a window gets it, over an ipcRenderer that records what it sends.
async function preload(answer: (channel: string) => Promise<unknown>) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/preload.ts', import.meta.url))],
    platform: 'node',
    format: 'cjs',
    bundle: true,
    external: ['electron'],
    write: false,
  });
  let bridge!: DesktopBridge;
  const invoked: unknown[][] = [];
  const sent: unknown[][] = [];
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  runInNewContext(result.outputFiles[0]!.text, {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_key: string, api: DesktopBridge) => {
          bridge = api;
        },
      },
      ipcRenderer: {
        invoke: (...args: unknown[]) => {
          invoked.push(args);
          return answer(String(args[0]));
        },
        send: (...args: unknown[]) => sent.push(args),
        on: (channel: string, handler: (...args: unknown[]) => void) => {
          if (!handlers.has(channel)) handlers.set(channel, new Set());
          handlers.get(channel)!.add(handler);
        },
        removeListener: (
          channel: string,
          handler: (...args: unknown[]) => void,
        ) => handlers.get(channel)?.delete(handler),
      },
    }),
  });
  const deliver = (channel: string, value?: unknown) => {
    for (const handler of handlers.get(channel) ?? []) handler({}, value);
  };
  return { bridge, invoked, sent, deliver, handlers };
}
const settle = () => new Promise((done) => setImmediate(done));
const attachment: PopoutAttachment = {
  id: 'terminal-selection:one',
  name: 'zsh · selection',
  kind: 'file',
  mime: 'text/plain',
  size: 4,
  content: 'mark',
};

test('the main window answers each attachment a window of its own sends, with what its message box did', async () => {
  const { bridge, sent, deliver, handlers } = await preload(async () => null);
  const outcomes: (boolean | Error)[] = [
    true,
    false,
    Error('this conversation is gone'),
  ];
  const seen: [string, PopoutAttachment][] = [];
  const stop = bridge.onPopoutAttach!((sessionId, value) => {
    seen.push([sessionId, value]);
    const outcome = outcomes.shift()!;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  for (const request of ['r1', 'r2', 'r3'])
    deliver('circle:popout-attachment', {
      request,
      sessionId: 's1',
      attachment,
    });
  await settle();
  assert.deepEqual(seen, [
    ['s1', attachment],
    ['s1', attachment],
    ['s1', attachment],
  ]);
  assert.deepEqual(sent, [
    ['circle:popout-attachment-answer', 'r1', true, ''],
    ['circle:popout-attachment-answer', 'r2', false, ''],
    [
      'circle:popout-attachment-answer',
      'r3',
      false,
      'this conversation is gone',
    ],
  ]);
  stop();
  assert.equal(handlers.get('circle:popout-attachment')?.size, 0);
});

test('a window of its own sends what it attaches and hears the main process in its own words', async () => {
  const { bridge, invoked } = await preload(async (channel) => {
    if (channel === 'circle:popout-attach')
      throw Error(
        "Error invoking remote method 'circle:popout-attach': Error: invalid conversation",
      );
    return null;
  });
  await assert.rejects(
    bridge.popoutAttach!('s1', attachment),
    (error: Error) => error.message === 'invalid conversation',
  );
  assert.deepEqual(invoked, [['circle:popout-attach', 's1', attachment]]);
});

test('the browser window takes an address on start and when told there is one', async () => {
  const { bridge, invoked, deliver } = await preload(async (channel) =>
    channel === 'circle:popout-address' ? 'https://example.test/' : null,
  );
  assert.equal(await bridge.popoutAddress!(), 'https://example.test/');
  let told = 0;
  const stop = bridge.onPopoutAddress!(() => told++);
  deliver('circle:popout-address');
  stop();
  deliver('circle:popout-address');
  assert.equal(told, 1);
  // Opening a window sends an address only when there is one.
  await bridge.popoutOpen('terminal', 's1', 'terminal · one');
  await bridge.popoutOpen('browser', 's1', 'browser · one', 'https://a.test/');
  assert.deepEqual(invoked.slice(1), [
    ['circle:popout-open', 'terminal', 's1', 'terminal · one'],
    ['circle:popout-open', 'browser', 's1', 'browser · one', 'https://a.test/'],
  ]);
});
