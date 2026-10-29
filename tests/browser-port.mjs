// A browser refuses some ports outright (ERR_UNSAFE_PORT), loopback included, and an
// OS whose ephemeral range starts low, as Windows can be set to, may hand one out.
import { createServer } from 'node:net';

// The Fetch standard's bad ports, which Chromium blocks too
export const REFUSED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

const bind = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });

const close = (server) =>
  new Promise((resolve) => server.close(() => resolve()));

// What each server a browser opens has seen while it listens: the browser's connections, its
// requests and when each was answered. A failed test prints it, so a page that did not load
// says whether its request never came (the runner), came and was not answered (the fixture),
// or was answered in time (the page's load).
const seen = new Map();

function watch(server, port) {
  const since = Date.now();
  const events = [];
  const add = (event) => {
    events.push({ at: Date.now() - since, ...event });
    if (events.length > 50) events.shift();
  };
  server.on('connection', (socket) =>
    add({ event: 'connection', from: socket.remotePort }),
  );
  server.on('request', (request, response) => {
    const path = String(request.url ?? '').split('?')[0];
    add({ event: 'request', method: request.method, path });
    response.once('finish', () =>
      add({ event: 'answered', path, status: response.statusCode }),
    );
    response.once('close', () => {
      if (!response.writableFinished) add({ event: 'closed unanswered', path });
    });
  });
  server.once('close', () => seen.delete(server));
  seen.set(server, { port, since, events });
}

/** What the listening servers a browser opens have seen, or what one of them has. */
export function loopbackEvidence(server) {
  const servers = server
    ? [seen.get(server)].filter(Boolean)
    : [...seen.values()];
  return servers.map(({ port, since, events }) => ({
    port,
    since: new Date(since).toISOString(),
    events: [...events],
  }));
}

/**
 * Listens on a loopback port a browser will open and returns it. A refused port
 * stays held by a placeholder until then, so the OS cannot hand it out again.
 */
export async function listenForBrowser(server, refused = REFUSED_PORTS) {
  const held = [];
  try {
    for (;;) {
      const port = await bind(server, 0);
      if (!refused.has(port)) {
        watch(server, port);
        return port;
      }
      await close(server);
      const placeholder = createServer();
      // Someone else may take the port in between; then it is held anyway
      await bind(placeholder, port).then(
        () => held.push(placeholder),
        () => {},
      );
    }
  } finally {
    await Promise.all(held.map(close));
  }
}
