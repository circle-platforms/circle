import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import {
  createServer,
  get,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { cleanupServer, until } from './helpers.js';
import {
  listenForBrowser,
  loopbackEvidence,
  REFUSED_PORTS,
} from './browser-port.mjs';

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

// What a page's server saw is what tells a page that did not load apart: a request that never
// came, one that came and was not answered, or one answered in time.
test('a browser-facing server records each connection, request and answer, and a request left unanswered', async (t) => {
  let held: ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url === '/held') held = res;
    else res.end('page');
  });
  cleanupServer(t, server);
  const port = await listenForBrowser(server);
  const [nothing] = loopbackEvidence(server);
  assert.equal(nothing!.port, port);
  assert.deepEqual(nothing!.events, []);
  // One connection for each request, as a browser's first visit makes one
  const ask = (path: string) =>
    get({ host: '127.0.0.1', port, path, agent: false });
  const page = ask('/page?query=1');
  const [answer] = (await once(page, 'response')) as [IncomingMessage];
  answer.resume();
  await once(answer, 'end');
  const unanswered = ask('/held');
  unanswered.on('error', () => {});
  await until(() => held !== undefined, { label: 'the held request' });
  unanswered.destroy();
  await until(
    () =>
      loopbackEvidence(server)[0]!.events.some(
        (event) => event.event === 'closed unanswered',
      ),
    { label: 'the unanswered request closes' },
  );
  const [evidence] = loopbackEvidence(server);
  assert.deepEqual(
    evidence!.events.map(({ at: _at, from: _from, ...event }) => event),
    [
      { event: 'connection' },
      { event: 'request', method: 'GET', path: '/page' },
      { event: 'answered', path: '/page', status: 200 },
      { event: 'connection' },
      { event: 'request', method: 'GET', path: '/held' },
      { event: 'closed unanswered', path: '/held' },
    ],
  );
  for (const event of evidence!.events)
    if (event.event === 'connection') assert.equal(typeof event.from, 'number');
  const at = evidence!.events.map((event) => event.at);
  assert.ok(at[0]! >= 0);
  assert.deepEqual(
    at,
    [...at].sort((a, b) => a - b),
  );
  // Every listening server, and none once it has closed
  assert.ok(loopbackEvidence().some((one) => one.port === port));
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  assert.deepEqual(loopbackEvidence(server), []);
});
