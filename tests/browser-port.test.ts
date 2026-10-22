import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { cleanupServer } from './helpers.js';
import { listenForBrowser, REFUSED_PORTS } from './browser-port.mjs';

test('the browser fixture ports leave out the ones a browser refuses', () => {
  for (const port of [1719, 1720, 1723, 2049, 5060, 6000, 6667, 10080])
    assert.ok(REFUSED_PORTS.has(port), String(port));
  assert.ok(!REFUSED_PORTS.has(8080));
});

test('a refused port is never handed to the page, and is let go once a good one is bound', async (t) => {
  const asked: number[] = [];
  // Refuse the first two ports the OS hands out, whatever they are
  const refused = {
    has(port: number) {
      asked.push(port);
      return asked.length <= 2;
    },
  } as ReadonlySet<number>;
  const server = createServer();
  cleanupServer(t, server);
  const port = await listenForBrowser(server, refused);

  assert.equal(asked.length, 3);
  assert.equal(new Set(asked).size, 3, 'a refused port was handed out again');
  assert.equal(port, asked[2]);
  assert.equal(server.listening, true);
  assert.equal((server.address() as { port: number }).port, port);
  for (const freed of asked.slice(0, 2)) {
    const again = createServer();
    await new Promise<void>((resolve, reject) => {
      again.once('error', reject);
      again.listen(freed, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => again.close(resolve));
  }
});
