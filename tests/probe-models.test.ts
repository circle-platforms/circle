import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { resolveEndpoint } from '../src/probe.js';

test('only explicitly selected Anthropic model-list 404 and 405 responses allow manual discovery fallback', async (t) => {
  let status = 404;
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    res.writeHead(status);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/apps/anthropic`;
  for (const code of [404, 405]) {
    status = code;
    const found = await resolveEndpoint(endpoint, 'local-test-key', {
      protocol: 'anthropic',
    });
    assert.equal(found.modelListUnavailable, true);
    assert.equal(found.inferred, false);
    assert.equal(found.base_url, endpoint);
    assert.equal(found.detail, `http ${code}`);
    assert.deepEqual(found.models, []);
  }
  assert.deepEqual(paths, [
    '/apps/anthropic/v1/models',
    '/apps/anthropic/v1/models',
  ]);
  for (const code of [401, 403, 429, 500]) {
    status = code;
    const found = await resolveEndpoint(endpoint, 'local-test-key', {
      protocol: 'anthropic',
    });
    assert.equal(found.modelListUnavailable, undefined);
    assert.equal(found.status, 'failed');
    assert.equal(found.detail, `http ${code}`);
  }
  status = 404;
  for (const options of [{}, { protocol: 'openai' }]) {
    const found = await resolveEndpoint(endpoint, 'local-test-key', options);
    assert.equal(found.modelListUnavailable, undefined);
    assert.equal(found.status, 'failed');
  }
});
