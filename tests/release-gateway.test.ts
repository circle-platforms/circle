import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { listenReleaseGateway } from '../scripts/release-gateway.js';
import { cleanupServer } from './helpers.js';

// What the gateway on a port answers, over a connection of this request's own. fetch
// keeps connections alive in one pool per origin for the whole file, and every test
// here binds the same first port again: a request on the connection the last test's
// cleanup closed is reset (ECONNRESET) when it is sent before that close is seen (#416).
const answer = async (port: number) =>
  (
    await fetch(`http://127.0.0.1:${port}`, {
      headers: { connection: 'close' },
    })
  ).text();

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
  const responses = await Promise.all([answer(occupied), answer(available)]);
  assert.deepEqual(responses, ['first gateway', 'second gateway']);
});

test('an already listening gateway is rejected without replacing its listener', async (t) => {
  const server = createServer((_request, response) =>
    response.end('still listening'),
  );
  cleanupServer(t, server);
  const port = await listenReleaseGateway(server);
  await assert.rejects(listenReleaseGateway(server), /already listening/);
  assert.equal(await answer(port), 'still listening');
});
