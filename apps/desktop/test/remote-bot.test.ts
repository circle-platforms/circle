import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { McpBearerConnection } from '../../../src/mcp_loader.js';
import { HUB_SERVER } from '../../../src/hub_connection.js';
import { saveRemoteFile, uploadSelected } from '../src/remote-bot-files';
import { remoteBotPort, remoteBotRequest } from '../src/remote-bot';

function makePort(options?: {
  binding?: string;
  tokens?: string[];
  assertActive?: () => void;
}) {
  const tokenCalls: Array<string | undefined> = [];
  let index = 0;
  const tokens = options?.tokens ?? ['tok-1', 'tok-2'];
  const port: McpBearerConnection = {
    server: 'https://hub.example.test',
    binding: options?.binding ?? 'binding-1',
    assertActive() {
      options?.assertActive?.();
    },
    async token(_signal, rejected) {
      tokenCalls.push(rejected);
      const value = tokens[Math.min(index, tokens.length - 1)]!;
      index++;
      return value;
    },
  };
  return { port, tokenCalls };
}

function trackedBodyResponse(
  status: number,
  chunks: Uint8Array[],
  headers?: Record<string, string>,
) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status, headers }),
    wasCancelled: () => cancelled,
  };
}

test('remoteBotPort validates configured Hub server and binding', async () => {
  const home = await mkdtemp(join(tmpdir(), 'circle-bot-port-'));
  try {
    assert.throws(() => remoteBotPort(home), /remote bot unavailable/);
    await writeFile(
      join(home, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          [HUB_SERVER]: {
            type: 'http',
            url: 'https://hub.example.test/mcp',
          },
        },
      }),
    );
    assert.throws(() => remoteBotPort(home), /MCP sign-in is required/);
    await writeFile(
      join(home, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          [HUB_SERVER]: {
            type: 'http',
            url: 'https://hub.example.test/mcp',
            headers: { Authorization: 'Bearer synth-hub-token' },
          },
        },
      }),
    );
    const port = remoteBotPort(home);
    assert.equal(port.server, 'https://hub.example.test/mcp');
    assert.equal(remoteBotPort(home, port.binding).binding, port.binding);
    port.assertActive();
    assert.throws(
      () => remoteBotPort(home, 'stale-binding'),
      /remote bot connection changed/,
    );
    await writeFile(
      join(home, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          [HUB_SERVER]: {
            type: 'http',
            url: 'https://hub.example.test/mcp',
            headers: { Authorization: 'Bearer rotated-hub-token' },
          },
        },
      }),
    );
    const rotated = remoteBotPort(home);
    assert.notEqual(rotated.binding, port.binding);
    assert.throws(() => port.assertActive(), /MCP sign-in is required/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('remoteBotRequest validates operations, retries on 401, and handles non-JSON errors', async () => {
  const { port, tokenCalls } = makePort({ tokens: ['stale-tok', 'fresh-tok'] });
  await assert.rejects(
    () =>
      remoteBotRequest(port, {
        action: 'history',
        binding: 'other-binding',
      }),
    /remote bot connection changed/,
  );
  await assert.rejects(
    () =>
      remoteBotRequest(port, {
        action: 'unknown-op',
        binding: 'binding-1',
      }),
    /unknown remote bot operation/,
  );

  const authHeaders: string[] = [];
  const first401 = trackedBodyResponse(401, [Buffer.from('unauthorized')]);
  const discover = await remoteBotRequest(port, { action: 'discover' }, (async (
    _input,
    init,
  ) => {
    authHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
    if (authHeaders.length === 1) return first401.response;
    return new Response(JSON.stringify({ current: 'conv-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
  assert.deepEqual(discover, { current: 'conv-1', binding: 'binding-1' });
  assert.deepEqual(authHeaders, ['Bearer stale-tok', 'Bearer fresh-tok']);
  assert.deepEqual(tokenCalls, [undefined, 'stale-tok']);
  assert.equal(first401.wasCancelled(), true);

  await assert.rejects(
    () =>
      remoteBotRequest(
        port,
        { action: 'discover' },
        (async () =>
          new Response(JSON.stringify({ message: 'rate limited' }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      ),
    /rate limited/,
  );

  await assert.rejects(
    () =>
      remoteBotRequest(
        port,
        { action: 'discover' },
        (async () =>
          new Response('<html>502 Bad Gateway</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          })) as typeof fetch,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'remote bot unavailable' &&
      !(error instanceof SyntaxError),
  );

  let activeCalls = 0;
  const stale = makePort({
    assertActive() {
      activeCalls++;
      if (activeCalls === 2) throw new Error('port closed');
    },
  });
  await assert.rejects(
    () =>
      remoteBotRequest(
        stale.port,
        { action: 'discover' },
        (async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
          })) as typeof fetch,
      ),
    /port closed/,
  );
});

test('uploadSelected retries on 401 with a fresh stream, checks errors before parsing, and verifies receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'circle-bot-upload-'));
  try {
    const filePath = join(dir, 'sample.txt');
    const payload = Buffer.from('hello remote bot attachment\n');
    await writeFile(filePath, payload);
    const expectedSha = createHash('sha256').update(payload).digest('hex');

    const { port, tokenCalls } = makePort({ tokens: ['old', 'new'] });
    const first401 = trackedBodyResponse(401, [Buffer.from('expired')]);
    const uploadedBodies: Buffer[] = [];
    const uploadedAuth: string[] = [];
    const uploaded = await uploadSelected(port, filePath, (async (
      _url,
      init,
    ) => {
      uploadedAuth.push(new Headers(init?.headers).get('authorization') ?? '');
      const bytes = Buffer.from(
        await new Response(init?.body as BodyInit).arrayBuffer(),
      );
      uploadedBodies.push(bytes);
      if (uploadedBodies.length === 1) return first401.response;
      return new Response(
        JSON.stringify({ sha256: expectedSha, size: payload.length }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch);

    assert.deepEqual(uploaded, {
      name: 'sample.txt',
      sha256: expectedSha,
      size: payload.length,
    });
    assert.deepEqual(uploadedAuth, ['Bearer old', 'Bearer new']);
    assert.deepEqual(tokenCalls, [undefined, 'old']);
    assert.equal(first401.wasCancelled(), true);
    assert.equal(uploadedBodies.length, 2);
    assert.deepEqual(uploadedBodies[0], payload);
    assert.deepEqual(uploadedBodies[1], payload);

    const badGateway = trackedBodyResponse(502, [Buffer.from('Bad Gateway')]);
    await assert.rejects(
      () =>
        uploadSelected(
          makePort().port,
          filePath,
          (async () => badGateway.response) as typeof fetch,
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'file upload was not verified' &&
        !(error instanceof SyntaxError),
    );
    assert.equal(badGateway.wasCancelled(), true);

    await assert.rejects(
      () =>
        uploadSelected(
          port,
          filePath,
          (async () =>
            new Response(
              JSON.stringify({ sha256: '0'.repeat(64), size: payload.length }),
              { status: 200 },
            )) as typeof fetch,
        ),
      /file upload was not verified/,
    );

    const linkPath = join(dir, 'link.txt');
    await symlink(filePath, linkPath);
    await assert.rejects(
      () =>
        uploadSelected(
          port,
          linkPath,
          (async () => new Response()) as typeof fetch,
        ),
      { code: 'ELOOP' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveRemoteFile validates receipts, refreshes on 401, checks content-length, and verifies SHA-256', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'circle-bot-save-'));
  try {
    const { port } = makePort();
    const outPath = join(dir, 'downloaded.bin');

    await assert.rejects(
      () =>
        saveRemoteFile(
          port,
          { name: 'bad', sha256: 'not-a-sha', size: 10 },
          outPath,
          fetch,
        ),
      /invalid file receipt/,
    );
    await assert.rejects(
      () =>
        saveRemoteFile(
          port,
          { name: 'bad', sha256: 'a'.repeat(64), size: -1 },
          outPath,
          fetch,
        ),
      /invalid file receipt/,
    );

    const payload = Buffer.concat([
      Buffer.from('first-chunk-'),
      Buffer.from('second-chunk'),
    ]);
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const missingLength = trackedBodyResponse(200, [], {});
    await assert.rejects(
      () =>
        saveRemoteFile(
          port,
          {
            name: 'empty.txt',
            sha256: createHash('sha256').update('').digest('hex'),
            size: 0,
          },
          outPath,
          (async () => missingLength.response) as typeof fetch,
        ),
      /file unavailable/,
    );
    assert.equal(missingLength.wasCancelled(), true);

    const refresh = makePort({ tokens: ['t1', 't2'] });
    const first401 = trackedBodyResponse(401, [Buffer.from('unauthorized')]);
    const authHeaders: string[] = [];
    await saveRemoteFile(
      refresh.port,
      { name: 'downloaded.bin', sha256, size: payload.length },
      outPath,
      (async (_url, init) => {
        authHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
        if (authHeaders.length === 1) return first401.response;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(payload.subarray(0, 12));
            await delay(1);
            controller.enqueue(payload.subarray(12));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-length': String(payload.length) },
        });
      }) as typeof fetch,
    );
    assert.deepEqual(authHeaders, ['Bearer t1', 'Bearer t2']);
    assert.equal(first401.wasCancelled(), true);
    assert.deepEqual(await readFile(outPath), payload);

    const badOut = join(dir, 'corrupted.bin');
    await assert.rejects(
      () =>
        saveRemoteFile(
          port,
          { name: 'corrupted.bin', sha256, size: payload.length },
          badOut,
          (async () =>
            new Response(Buffer.from('x'.repeat(payload.length)), {
              status: 200,
              headers: { 'content-length': String(payload.length) },
            })) as typeof fetch,
        ),
      /file digest mismatch/,
    );
    const remaining = await readdir(dir);
    assert.deepEqual(
      remaining.filter((entry) => entry.startsWith('.circle-')),
      [],
    );
    await assert.rejects(() => readFile(badOut), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
