import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { configureNetwork, networkError } from '../src/net.js';
import { webFetch, webSearch } from '../src/websearch.js';

async function listen(t: TestContext, server: Server): Promise<string> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('network diagnostics retain nested and aggregate causes while hiding credentials and URL queries', () => {
  const timeout = Object.assign(new Error('connect timed out'), {
    code: 'UND_ERR_CONNECT_TIMEOUT',
  });
  const refused = Object.assign(
    new Error(
      'relay https://user:synthetic-password@[2001:db8::1]/route?q=synthetic-query Authorization: Bearer synthetic-token',
    ),
    { code: 'ECONNREFUSED' },
  );
  const original = new TypeError('fetch failed', {
    cause: new AggregateError([timeout, refused], 'both addresses failed'),
  });
  const error = networkError(
    original,
    'https://user:synthetic-host-secret@fixture.invalid/path?q=synthetic-target-query',
  );
  assert.match(error.message, /timeout failure on fixture\.invalid/);
  assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/);
  assert.match(error.message, /ECONNREFUSED/);
  assert.match(error.message, /https:\/\/\[2001:db8::1\]/);
  assert.doesNotMatch(
    error.message,
    /synthetic-password|synthetic-query|synthetic-token|synthetic-host-secret|synthetic-target-query/,
  );
  assert.equal(error.cause, original);
  assert.equal(
    (error as NodeJS.ErrnoException).code,
    'UND_ERR_CONNECT_TIMEOUT',
  );
  const cyclic = new Error('cyclic connection error');
  cyclic.cause = cyclic;
  assert.equal(networkError(cyclic, 'fixture.invalid').cause, cyclic);
});

test('a proxy failure is named by its status and words, not by digits in an address', () => {
  const kind = (error: unknown) =>
    /^(\S+(?: response)?) failure on/.exec(
      networkError(error, 'fixture.invalid').message,
    )?.[1];
  const refused = (address: string) =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error(`connect ECONNREFUSED ${address}`), {
        code: 'ECONNREFUSED',
      }),
    });
  assert.equal(kind(refused('10.0.0.4:4071')), 'connection');
  assert.equal(kind(refused('192.0.2.1:8407')), 'connection');
  // As undici reports a CONNECT tunnel the proxy refused, with or without 407
  for (const status of [407, 502])
    assert.equal(
      kind(
        new TypeError('fetch failed', {
          cause: Object.assign(
            new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`),
            { code: 'UND_ERR_ABORTED' },
          ),
        }),
      ),
      'proxy',
    );
  assert.equal(
    kind(Object.assign(new Error('HTTP 407'), { status: 407 })),
    'proxy',
  );
});

test('a timeout from AbortSignal.timeout carries no numeric DOMException code', () => {
  const timeout = new DOMException(
    'The operation was aborted due to timeout',
    'TimeoutError',
  );
  assert.equal(timeout.code, 23);
  const error = networkError(timeout, 'fixture.invalid');
  assert.equal(
    error.message,
    'timeout failure on fixture.invalid: The operation was aborted due to timeout',
  );
  assert.equal((error as NodeJS.ErrnoException).code, undefined);
});

test('network diagnostics retain named and IPv6 hosts with non-default ports', () => {
  for (const [host, expected] of [
    ['fixture.invalid:8443', 'fixture.invalid:8443'],
    [
      'https://fixture.invalid:8443/path?q=synthetic-query',
      'fixture.invalid:8443',
    ],
    ['[2001:db8::2]:9443', '[2001:db8::2]:9443'],
    ['https://[2001:db8::2]:9443/path?q=synthetic-query', '[2001:db8::2]:9443'],
  ]) {
    const error = networkError(new Error('socket closed'), host!);
    assert.ok(error.message.includes(`failure on ${expected}:`), error.message);
    assert.doesNotMatch(error.message, /synthetic-query/);
  }
});

test('a response body socket failure names the fetch and both search hosts and retains the real terminated causes', async (t) => {
  const pending: ServerResponse[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Length': '1000',
    });
    response.write('<html>partial response');
    pending.push(response);
  });
  const local = await listen(t, server);
  let calls = 0;
  const request: typeof fetch = async (_input, init) => {
    calls++;
    const response = await fetch(local, init);
    assert.equal(response.status, 200);
    const socketResponse = pending.shift();
    assert.ok(socketResponse);
    // Headers are already received: this fails a real body read, not fetch itself.
    setImmediate(() => socketResponse.destroy());
    return response;
  };
  const realCause = (error: Error) => {
    assert.ok(error.cause instanceof TypeError);
    assert.equal(error.cause.message, 'terminated');
    assert.equal(
      (error.cause.cause as NodeJS.ErrnoException).code,
      'UND_ERR_SOCKET',
    );
  };
  await assert.rejects(
    webFetch(
      'https://stream-fixture.invalid:8443/page?q=synthetic-query',
      'text',
      new AbortController().signal,
      request,
    ),
    (error: Error) => {
      assert.match(
        error.message,
        /connection failure on stream-fixture\.invalid:8443/,
      );
      assert.match(error.message, /UND_ERR_SOCKET/);
      assert.match(error.message, /HTTPS_PROXY/);
      assert.doesNotMatch(error.message, /synthetic-query/);
      realCause(error);
      return true;
    },
  );
  await assert.rejects(
    webSearch(
      'synthetic-search-query',
      new AbortController().signal,
      5,
      request,
    ),
    (error: Error) => {
      assert.match(
        error.message,
        /connection failure on lite\.duckduckgo\.com/,
      );
      assert.match(
        error.message,
        /connection failure on html\.duckduckgo\.com/,
      );
      assert.match(error.message, /UND_ERR_SOCKET/);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 2);
      for (const failure of error.cause.errors) realCause(failure);
      assert.doesNotMatch(error.message, /synthetic-search-query/);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test('an actual CONNECT handshake timeout is classified, retains its cause and gives the CLI proxy hint', async (t) => {
  const connects: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    connects.push(request.url ?? '');
    // This synthetic gateway accepts CONNECT but never finishes the TLS handshake.
    // It never resolves or connects to the requested host.
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  const address = await listen(t, proxy);
  const network = configureNetwork({
    HTTPS_PROXY: address,
    HTTP_PROXY: address,
    NO_PROXY: '',
  });
  assert.deepEqual(network.problems, []);
  assert.equal(network.proxy, true);
  try {
    await assert.rejects(
      webFetch(
        'https://timeout-fixture.invalid/page',
        'text',
        new AbortController().signal,
      ),
      (error: Error) => {
        assert.match(
          error.message,
          /timeout failure on timeout-fixture\.invalid/,
        );
        assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/);
        assert.match(error.message, /HTTPS_PROXY/);
        assert.doesNotMatch(error.message, /NODE_USE_ENV_PROXY/);
        assert.ok(error.cause instanceof TypeError);
        assert.equal(
          (error.cause.cause as NodeJS.ErrnoException).code,
          'UND_ERR_CONNECT_TIMEOUT',
        );
        return true;
      },
    );
    assert.deepEqual(connects, ['timeout-fixture.invalid:443']);
  } finally {
    network.restore();
  }
});

test('cancelling an actual response body read propagates the user reason without a network wrapper', async (t) => {
  const controller = new AbortController();
  const interrupted = new Error('user interrupted body read');
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Length': '1000',
    });
    response.write('partial');
  });
  const local = await listen(t, server);
  let calls = 0;
  const request: typeof fetch = async (_input, init) => {
    calls++;
    const response = await fetch(local, init);
    assert.equal(response.status, 200);
    setImmediate(() => controller.abort(interrupted));
    return response;
  };
  await assert.rejects(
    webFetch(
      'https://cancel-fixture.invalid/page',
      'text',
      controller.signal,
      request,
    ),
    (error: Error) => error === interrupted,
  );
  assert.equal(calls, 1);
});

test('cancelling a search request does not wrap the reason or call the fallback endpoint', async () => {
  const controller = new AbortController();
  const interrupted = new Error('user interrupted search');
  let calls = 0;
  await assert.rejects(
    webSearch('query', controller.signal, 5, async () => {
      calls++;
      controller.abort(interrupted);
      throw interrupted;
    }),
    (error: Error) => error === interrupted,
  );
  assert.equal(calls, 1);
});
