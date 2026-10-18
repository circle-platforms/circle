import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { validateRuntimeCommand } from '../src/runtime-protocol.ts';

test('preload exposes a path-free native chooser while public runtime commands cannot mint', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/preload.ts', import.meta.url))],
    platform: 'node',
    format: 'cjs',
    bundle: true,
    external: ['electron'],
    write: false,
  });
  let bridge: any;
  const calls: unknown[][] = [];
  runInNewContext(result.outputFiles[0].text, {
    require: (name: string) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld: (key: string, api: unknown) => {
            assert.equal(key, 'circleDesktop');
            bridge = api;
          },
        },
        ipcRenderer: {
          invoke: (...args: unknown[]) => {
            calls.push(args);
            return Promise.resolve(null);
          },
        },
      };
    },
  });
  assert.equal(Object.isFrozen(bridge), true);
  await bridge.requestExternalFileGrant(
    'sessionA',
    'readwrite',
    '/forged/renderer/path',
  );
  assert.deepEqual(
    calls,
    [['circle:request-external-file-grant', 'sessionA', 'readwrite']],
    'no renderer path reaches the native picker channel',
  );
  for (const name of [
    'grant-external-file',
    'mint-external-file',
    'external-file-grant',
    'request-external-file-grant',
  ]) {
    assert.throws(
      () =>
        validateRuntimeCommand({
          id: 'attempt',
          sessionId: 'sessionA',
          name,
          payload: { path: '/forged/path', access: 'readwrite' },
        }),
      /invalid runtime command/,
    );
  }
});
