import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import { resolveEndpoint } from '../src/probe.js';
import { connectionModels } from '../src/connection_models.js';
import { PROVIDER_PRESETS } from '../src/providers.js';
import { SetupFlow } from '../src/tui/setup_flow.js';
import { runLineInit, type LinePrompter } from '../src/line_setup.js';
import { loadSettings, loadCredentials } from '../src/settings.js';
import { scratch } from './helpers.js';

async function gateway(
  t: Parameters<typeof scratch>[0],
  reply: (req: IncomingMessage) => unknown,
) {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    const body = reply(req);
    if (body === undefined) res.writeHead(404).end();
    else
      res
        .setHeader('Content-Type', 'application/json')
        .end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((done) => server.close(() => done()));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
  };
}
test('OpenAI discovery preserves SDK paths, supports Together arrays, and only adds v1 to unversioned roots', async (t) => {
  for (const [path, answer, saved] of [
    ['', '/models', ''],
    ['/gateway', '/gateway/v1/models', '/gateway/v1'],
    ['/v2', '/v2/models', '/v2'],
    ['/v1beta/openai', '/v1beta/openai/models', '/v1beta/openai'],
    ['/openai/v1', '/openai/v1/models', '/openai/v1'],
  ]) {
    const { base, seen } = await gateway(t, (req) =>
      req.url === answer
        ? [{ id: 'one' }, { id: 'two' }, { id: 'one' }]
        : undefined,
    );
    const found = await resolveEndpoint(base + path, 'test-key', {
      protocol: 'openai',
    });
    assert.equal(found.status, 'discovered');
    assert.equal(found.base_url, base + saved);
    assert.deepEqual(found.models, ['one', 'two']);
    assert.ok(
      seen.every(
        (req) =>
          req.headers.authorization === 'Bearer test-key' &&
          !req.headers['x-api-key'],
      ),
    );
    if (path === '/v2')
      assert.deepEqual(
        seen.map((req) => req.url),
        ['/v2/models'],
      );
  }
});
test('Anthropic follows has_more beyond 20 models, encodes cursors and keeps its prefix and authentication on every page', async (t) => {
  const first = Array.from({ length: 20 }, (_, i) => ({ id: `model-${i}` }));
  const { base, seen } = await gateway(t, (req) => {
    const url = new URL(req.url!, 'http://test');
    assert.equal(url.pathname, '/anthropic/v1/models');
    return !url.search
      ? { data: first, has_more: true, last_id: 'cursor /&?' }
      : {
          data: [{ id: 'model-20' }, first[0]],
          has_more: false,
          last_id: 'model-20',
        };
  });
  const found = await resolveEndpoint(base + '/anthropic/v1/', 'key', {
    protocol: 'anthropic',
  });
  assert.equal(found.base_url, base + '/anthropic');
  assert.equal(found.models.length, 21);
  assert.equal(found.models.at(-1), 'model-20');
  assert.equal(
    new URL(seen[1]!.url!, base).searchParams.get('after_id'),
    'cursor /&?',
  );
  assert.ok(
    seen.every(
      (req) =>
        req.headers['x-api-key'] === 'key' &&
        req.headers['anthropic-version'] === '2023-06-01' &&
        !req.headers.authorization,
    ),
  );
});
test('a failed or cyclic later Anthropic page never returns a truncated successful list', async (t) => {
  for (const mode of ['http', 'invalid', 'cycle', 'empty', 'missing']) {
    const { base, seen } = await gateway(t, (req) => {
      if (!req.url!.includes('?'))
        return {
          data: [{ id: 'first' }],
          has_more: true,
          last_id: mode === 'missing' ? undefined : 'first',
        };
      if (mode === 'http') return undefined;
      if (mode === 'invalid') return { data: [{ id: 3 }] };
      return {
        data: mode === 'empty' ? [] : [{ id: 'first' }],
        has_more: true,
        last_id: 'first',
      };
    });
    const found = await resolveEndpoint(base, 'key', { protocol: 'anthropic' });
    assert.equal(found.status, 'failed', mode);
    assert.deepEqual(found.models, []);
    assert.ok(seen.length <= 2);
  }
});
test('provider presets are explicit, skip discovery and remain editable without being saved as an online list', async (t) => {
  const home = scratch(t);
  let calls = 0;
  const flow = new SetupFlow(home, async () => {
    calls++;
    throw Error('must not discover presets');
  });
  assert.equal(flow.step, 'provider');
  flow.chooseProvider('bailian-anthropic');
  flow.submitUrl('http://127.0.0.1:12345/custom/anthropic/v1');
  flow.submitKey('synthetic');
  await flow.runProbe();
  assert.equal(calls, 0);
  assert.equal(flow.step, 'model');
  assert.match(flow.status, /presets.*unverified/);
  assert.ok(flow.models.includes('qwen3.8-max'));
  flow.use('my-own-id');
  assert.equal(flow.auth().model, 'my-own-id');
  assert.equal(flow.auth().base_url, 'http://127.0.0.1:12345/custom/anthropic');
  assert.equal(flow.auth().protocol, 'anthropic');
  assert.equal(loadSettings(home).initialized, false);
  const providerIndex =
    PROVIDER_PRESETS.findIndex((p) => p.id === 'bailian-anthropic') + 1;
  const answers = [
    String(providerIndex),
    'http://127.0.0.1:12345/custom/anthropic/v1',
    'synthetic',
    'my-own-id',
  ];
  const said: string[] = [];
  const io: LinePrompter = {
    ask: async () => answers.shift(),
    say: (line) => said.push(line),
    close() {},
  };
  await runLineInit(home, io);
  assert.equal(loadSettings(home).auth.model, 'my-own-id');
  assert.equal(loadSettings(home).auth.protocol, 'anthropic');
  assert.equal(loadCredentials(home).api_key, 'synthetic');
  assert.match(
    said.join('\n'),
    /provider presets; model and key are unverified/,
  );
});
test('an online provider failure remains a failure and never falls back to presets or another protocol', async (t) => {
  const { base, seen } = await gateway(t, () => undefined);
  const found = await connectionModels(base + '/v2', 'key', 'qianfan');
  assert.equal(found.status, 'failed');
  assert.equal(found.protocol, 'openai');
  assert.equal(found.inferred, false);
  assert.deepEqual(found.models, []);
  assert.deepEqual(
    seen.map((req) => req.url),
    ['/v2/models'],
  );
  await assert.rejects(
    connectionModels(base, 'key', 'unknown'),
    /unknown provider/,
  );
});
