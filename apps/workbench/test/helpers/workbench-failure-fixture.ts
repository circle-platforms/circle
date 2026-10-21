import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { warmModules, workbenchCleanup } from './workbench-server.ts';

test('workbench setup failure', async (t) => {
  const scratch = process.env.CIRCLE_FIXTURE_ROOT!;
  const failure = process.env.CIRCLE_FIXTURE_FAILURE;
  const cleanup = workbenchCleanup(t);
  const server = await createServer({
    configFile: false,
    root: scratch,
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
    logLevel: 'silent',
  });
  cleanup(async () => {
    await writeFile(
      join(scratch, 'closed.json'),
      JSON.stringify({ listening: server.httpServer!.listening }),
    );
  });
  cleanup(() => server.close());
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(join(scratch, 'port.txt'), String(address.port));

  if (failure === 'warm') {
    await warmModules(server, '/missing-entry.js');
  } else if (failure === 'launch') {
    // No browser or Page exists when launch rejects, just as in #231.
    t.mock.method(chromium, 'launch', async () => {
      throw new Error('fixture browser launch failed');
    });
    await chromium.launch();
  } else {
    cleanup(async () => {
      throw new Error('fixture browser close failed');
    });
  }
});
