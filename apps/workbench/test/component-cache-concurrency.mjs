import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const output =
  process.env.CIRCLE_COMPONENT_CACHE_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-vite-isolation-')));
const prior = process.env.CIRCLE_COMPONENT_UI_EVIDENCE;
const servers = [];
let browser;
try {
  for (const name of ['first-suite', 'parallel-suite']) {
    const directory = resolve(output, name);
    await mkdir(directory, { recursive: true });
    process.env.CIRCLE_COMPONENT_UI_EVIDENCE = directory;
    const server = await createServer({
      root,
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
    });
    servers.push(server);
    assert.equal(server.config.cacheDir, join(directory, 'vite-cache'));
  }
  await Promise.all(servers.map((server) => server.listen()));
  assert.notEqual(servers[0].config.cacheDir, servers[1].config.cacheDir);
  assert.ok(
    servers.every(
      (server) =>
        server.environments.client.depsOptimizer?.initState === 'initialized',
    ),
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const failures = [];
  const pages = await Promise.all(servers.map(() => browser.newPage()));
  for (const page of pages) {
    page.setDefaultTimeout(8000);
    page.on('response', (response) => {
      if (response.status() >= 400)
        failures.push({ status: response.status(), url: response.url() });
    });
    page.on('pageerror', (error) => failures.push({ error: String(error) }));
  }
  await Promise.all(
    pages.map((page, index) =>
      page.goto(
        servers[index].resolvedUrls.local[0] +
          'test/response-readability-ui.html?language=en&theme=dark#/session/session1',
      ),
    ),
  );
  await Promise.all(
    pages.map((page) =>
      page
        .getByRole('region', { name: 'response table', exact: true })
        .waitFor(),
    ),
  );
  assert.deepEqual(failures, []);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        passed: true,
        sharedNodeModules: await realpath(join(root, 'node_modules')),
        privateCaches: servers.map((server) => server.config.cacheDir),
        failures,
        cases: pages.length,
        qualifier:
          'two actual parallel Vite servers and browser pages; does not assert concurrency is the only cause of the original 504',
      },
      null,
      2,
    ),
  );
  console.log(
    'Two parallel actual Vite fixtures render response tables with independent cache identities and no failed module requests',
  );
} finally {
  if (prior === undefined) delete process.env.CIRCLE_COMPONENT_UI_EVIDENCE;
  else process.env.CIRCLE_COMPONENT_UI_EVIDENCE = prior;
  await browser?.close();
  await Promise.all(servers.map((server) => server.close()));
}
