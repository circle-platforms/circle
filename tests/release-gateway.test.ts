import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { listenReleaseGateway } from '../scripts/release-gateway.js';
import { cleanupServer } from './helpers.js';

test('release gateways use Fetch-compatible local ports and skip occupied listeners', async (t) => {
  const first = createServer((_request, response) =>
    response.end('first gateway'),
  );
  const second = createServer((_request, response) =>
    response.end('second gateway'),
  );
  cleanupServer(t, first);
  cleanupServer(t, second);
  const before = [first, second].map((server) => ({
    error: server.listeners('error'),
    listening: server.listeners('listening'),
  }));
  const occupied = await listenReleaseGateway(first);
  const available = await listenReleaseGateway(second);
  assert(occupied >= 49152 && occupied <= 65535);
  assert(available > occupied && available <= 65535);
  for (const [index, server] of [first, second].entries()) {
    assert.deepEqual(server.listeners('error'), before[index]!.error);
    assert.deepEqual(server.listeners('listening'), before[index]!.listening);
  }
  const responses = await Promise.all([
    fetch(`http://127.0.0.1:${occupied}`).then((response) => response.text()),
    fetch(`http://127.0.0.1:${available}`).then((response) => response.text()),
  ]);
  assert.deepEqual(responses, ['first gateway', 'second gateway']);
});

test('an already listening gateway is rejected without replacing its listener', async (t) => {
  const server = createServer((_request, response) =>
    response.end('still listening'),
  );
  cleanupServer(t, server);
  const port = await listenReleaseGateway(server);
  await assert.rejects(listenReleaseGateway(server), /already listening/);
  assert.equal(
    await (await fetch(`http://127.0.0.1:${port}`)).text(),
    'still listening',
  );
});
