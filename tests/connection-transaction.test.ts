import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { AgentRuntime } from '../src/runtime.js';
import {
  defaultSettings,
  loadSettings,
  saveCredentials,
  saveSettings,
  saveSettingsChange,
  withConnectionLock,
} from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

test('connection transactions are reentrant and preserve the settings read-modify-write boundary', (t) => {
  const home = scratch(t);
  withConnectionLock(home, () => {
    saveCredentials({ api_key: 'synthetic-local-key' }, home);
    withConnectionLock(home, () => {
      saveSettingsChange(home, (saved) => {
        saved.theme = 'light';
      });
    });
  });
  assert.equal(loadSettings(home).theme, 'light');
  assert.equal(
    withConnectionLock(home, () => 'released'),
    'released',
  );
});

test('a new runtime cannot construct an old-host SDK from credentials written halfway through another process login', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const oldRequests: string[] = [];
  const oldHost = createServer((request, response) => {
    oldRequests.push(request.headers.authorization ?? '');
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => oldHost.listen(0, '127.0.0.1', resolve));
  cleanup(t, async () => {
    oldHost.closeAllConnections();
    await new Promise<void>((resolve) => oldHost.close(() => resolve()));
  });
  const address = oldHost.address();
  assert(address && typeof address === 'object');
  const stale = defaultSettings();
  stale.initialized = true;
  stale.auth.base_url = `http://127.0.0.1:${address.port}/v1`;
  stale.auth.model = 'synthetic-old';
  saveSettings(stale, home);
  saveCredentials({ api_key: 'synthetic-old-key' }, home);
  const changed = structuredClone(stale);
  changed.auth.base_url = 'http://127.0.0.1:1/v1';
  changed.auth.model = 'synthetic-next';
  const settingsModule = pathToFileURL(resolve('src/settings.ts')).href;
  const writer = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { withConnectionLock, saveCredentials, saveSettings } from ${JSON.stringify(settingsModule)};
    withConnectionLock(${JSON.stringify(home)}, () => {
      saveCredentials({ api_key: 'synthetic-next-key' }, ${JSON.stringify(home)});
      process.send({ halfWritten: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      saveSettings(${JSON.stringify(changed)}, ${JSON.stringify(home)});
    });
    process.disconnect();
  `,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, CIRCLE_HOME: home },
    },
  );
  let stderr = '';
  writer.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  cleanup(t, () => {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill();
  });
  const exited = once(writer, 'exit');
  const [ready] = await once(writer, 'message');
  assert.deepEqual(ready, { halfWritten: true });
  let attempted: AgentRuntime | undefined;
  cleanup(t, () => attempted?.close());
  assert.throws(
    () =>
      (attempted = new AgentRuntime({
        workspace,
        home,
        userHome: home,
        settings: stale,
        headless: true,
        bundledExtensions: false,
      })),
    /saved connection changed/,
    'SDK creation waits for the complete pair and rejects stale endpoint settings',
  );
  const [code] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(loadSettings(home).auth.base_url, changed.auth.base_url);
  assert.deepEqual(
    oldRequests,
    [],
    'the next endpoint key is never sent to the previous host',
  );
});
