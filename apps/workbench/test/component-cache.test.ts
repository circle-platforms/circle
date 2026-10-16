import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
test('component suites receive independent Vite caches while ordinary dev keeps its default', async (t) => {
  const previous = process.env.CIRCLE_COMPONENT_UI_EVIDENCE;
  t.after(() => {
    if (previous === undefined) delete process.env.CIRCLE_COMPONENT_UI_EVIDENCE;
    else process.env.CIRCLE_COMPONENT_UI_EVIDENCE = previous;
  });
  const directories = ['/tmp/circle-cache-a', '/tmp/circle-cache-b'];
  const configurations = [];
  for (const directory of directories) {
    process.env.CIRCLE_COMPONENT_UI_EVIDENCE = directory;
    configurations.push(await resolveConfig({ root }, 'serve'));
  }
  assert.equal(
    configurations[0]!.cacheDir,
    resolve(directories[0]!, 'vite-cache'),
  );
  assert.equal(
    configurations[1]!.cacheDir,
    resolve(directories[1]!, 'vite-cache'),
  );
  assert.notEqual(configurations[0]!.cacheDir, configurations[1]!.cacheDir);
  delete process.env.CIRCLE_COMPONENT_UI_EVIDENCE;
  const ordinary = await resolveConfig({ root }, 'serve');
  assert.match(ordinary.cacheDir, /node_modules[/\\]\.vite$/);
});
