import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
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
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { DesktopBridge } from '../src/contracts.ts';
import type { McpBearerConnection } from '../../../src/mcp_loader.js';
import { HUB_SERVER } from '../../../src/hub_connection.js';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.js';
import { ScriptedModel } from '../../../src/testing.js';
import { VERSION } from '../../../src/version.js';
import { RuntimeController } from '../src/runtime-controller.ts';
import type {
  RuntimeCommandName,
  RuntimeReply,
} from '../src/runtime-protocol.ts';
import {
  PartialBatchUploadError,
  saveRemoteFile,
  uploadSelected,
  uploadSelectedBatch,
} from '../src/remote-bot-files';
import {
  RemoteBotError,
  remoteBotPort,
  remoteBotRequest,
} from '../src/remote-bot';
import { fileSymlinkRefusal } from './helpers/symlink-support.mjs';
import { patience } from './helpers/patience.mjs';

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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('uploadSelected rejects directories and symbolic links before reading', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'circle-bot-symlink-'));
  try {
    const target = join(dir, 'sample.txt');
    await writeFile(target, 'hello');
    let fetched = false;
    const failFetch = (async () => {
      fetched = true;
      return new Response();
    }) as typeof fetch;
    const { port } = makePort();
    await assert.rejects(
      () => uploadSelected(port, dir, failFetch),
      /only a regular file can be attached/,
    );
    const refusal = await fileSymlinkRefusal();
    await t.test(
      'rejects symbolic links without following them',
      { skip: refusal },
      async () => {
        const linkPath = join(dir, 'link.txt');
        await symlink(target, linkPath, 'file');
        await assert.rejects(
          () => uploadSelected(port, linkPath, failFetch),
          /symbolic links cannot be attached/,
        );
      },
    );
    assert.equal(fetched, false);
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

test('remoteBotRequest sends bot-client-version header and attaches structured error metadata', async () => {
  const { port } = makePort({ tokens: ['tok-1', 'tok-2'] });
  const capturedHeaders: Headers[] = [];
  await remoteBotRequest(port, { action: 'discover' }, (async (
    _input,
    init,
  ) => {
    capturedHeaders.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ current: 'conv-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
  assert.equal(capturedHeaders[0]?.get('bot-client-version'), VERSION);
  assert.equal(capturedHeaders[0]?.get('circle-version'), null);

  for (const scenario of [
    {
      status: 400,
      body: { code: 'BOT_VERSION_MISMATCH', message: 'client too old' },
      expectedCode: 'BOT_VERSION_MISMATCH',
      expectedMessage: 'client too old',
    },
    {
      status: 400,
      body: { code: 'BOT_VERSION_INVALID' },
      expectedCode: 'BOT_VERSION_INVALID',
      expectedMessage: 'invalid bot client version',
    },
    {
      status: 503,
      body: { code: 'BOT_DISABLED', message: 'bot disabled by admin' },
      expectedCode: 'BOT_DISABLED',
      expectedMessage: 'bot disabled by admin',
    },
    {
      status: 403,
      body: {
        code: 'BOT_CLIENT_FORBIDDEN',
        message: 'oauth client token is not allowed',
      },
      expectedCode: 'BOT_CLIENT_FORBIDDEN',
      expectedMessage: 'oauth client token is not allowed',
    },
    {
      status: 401,
      body: { code: 'BOT_UNAUTHENTICATED', message: 'token expired' },
      expectedCode: 'BOT_UNAUTHENTICATED',
      expectedMessage: 'token expired',
    },
    {
      status: 401,
      body: {
        code: 'BOT_CLIENT_FORBIDDEN',
        message: 'token expired',
      },
      expectedCode: 'BOT_CLIENT_FORBIDDEN',
      expectedMessage: 'token expired',
    },
    {
      status: 408,
      body: { code: 'BOT_REQUEST_TIMEOUT' },
      expectedCode: 'BOT_REQUEST_TIMEOUT',
      expectedMessage: 'remote bot request timed out',
    },
    {
      status: 429,
      body: { code: 'BOT_BUSY' },
      expectedCode: 'BOT_BUSY',
      expectedMessage: 'remote bot busy',
    },
    {
      status: 500,
      body: null,
      expectedCode: undefined,
      expectedMessage: 'remote bot unavailable',
    },
    {
      status: 503,
      body: null,
      expectedCode: undefined,
      expectedMessage: 'remote bot unavailable',
    },
  ]) {
    await assert.rejects(
      () =>
        remoteBotRequest(port, { action: 'discover' }, (async () =>
          scenario.body
            ? new Response(JSON.stringify(scenario.body), {
                status: scenario.status,
                headers: { 'content-type': 'application/json' },
              })
            : new Response('unavailable', {
                status: scenario.status,
                headers: { 'content-type': 'text/plain' },
              })) as typeof fetch),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        const meta = error as Error & {
          status?: number;
          code?: string;
          remoteMessage?: string;
        };
        assert.equal(meta.status, scenario.status);
        assert.equal(meta.code, scenario.expectedCode);
        assert.equal(error.message, scenario.expectedMessage);
        return true;
      },
    );
  }

  const dir = await mkdtemp(join(tmpdir(), 'circle-bot-err-'));
  try {
    const filePath = join(dir, 'sample.txt');
    await writeFile(filePath, 'hi');
    await assert.rejects(
      () =>
        uploadSelected(
          port,
          filePath,
          (async () =>
            new Response(
              JSON.stringify({
                code: 'BOT_CLIENT_FORBIDDEN',
                message: 'direct member token required',
              }),
              { status: 403, headers: { 'content-type': 'application/json' } },
            )) as typeof fetch,
        ),
      (error: unknown) => {
        const meta = error as Error & { status?: number; code?: string };
        return (
          error instanceof Error &&
          meta.status === 403 &&
          meta.code === 'BOT_CLIENT_FORBIDDEN' &&
          /direct member token required/.test(error.message)
        );
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('C6: remoteBotRequest, uploadSelected, and saveRemoteFile reject unsafe server URLs before sending tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'circle-bot-url-'));
  try {
    const filePath = join(dir, 'note.txt');
    const outPath = join(dir, 'out.txt');
    await writeFile(filePath, 'content');
    const payloadSha = createHash('sha256').update('content').digest('hex');

    for (const unsafeServer of [
      'http://192.168.1.10:7420/mcp',
      'http://hub.example.test:7420/mcp',
      'ftp://127.0.0.1:7420/mcp',
    ]) {
      let tokenCalls = 0;
      let fetchCalls = 0;
      const unsafePort: McpBearerConnection = {
        server: unsafeServer,
        binding: 'binding-unsafe',
        assertActive() {},
        async token() {
          tokenCalls++;
          return 'secret-bearer-token';
        },
      };
      const failFetch = (async () => {
        fetchCalls++;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      await assert.rejects(
        () => remoteBotRequest(unsafePort, { action: 'discover' }, failFetch),
        /https|loopback/i,
      );
      await assert.rejects(
        () => uploadSelected(unsafePort, filePath, failFetch),
        /https|loopback/i,
      );
      await assert.rejects(
        () => uploadSelectedBatch(unsafePort, [filePath], failFetch),
        /https|loopback/i,
      );
      await assert.rejects(
        () =>
          saveRemoteFile(
            unsafePort,
            { name: 'note.txt', sha256: payloadSha, size: 7 },
            outPath,
            failFetch,
          ),
        /https|loopback/i,
      );
      assert.equal(tokenCalls, 0, `no token requested for ${unsafeServer}`);
      assert.equal(fetchCalls, 0, `no fetch attempted for ${unsafeServer}`);
    }

    for (const safeServer of [
      'https://hub.example.test/mcp',
      'http://127.0.0.1:7420/mcp',
      'http://localhost:7420/mcp',
      'http://[::1]:7420/mcp',
    ]) {
      const safePort: McpBearerConnection = {
        server: safeServer,
        binding: 'binding-safe',
        assertActive() {},
        async token() {
          return 'ok-token';
        },
      };
      const res = await remoteBotRequest(
        safePort,
        { action: 'discover' },
        (async () =>
          new Response(JSON.stringify({ current: 'conv-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      );
      assert.equal(res.binding, 'binding-safe');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('C3: RuntimeController runs remote-bot and remote-bot-native-file outside the mutation queue', async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-bot-c3-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(join(home, 'extensions', 'hold'), { recursive: true });
  await writeFile(
    join(home, 'extensions', 'hold', 'extension.mjs'),
    `export function register(api){api.registerCommand('hold','Hold queue',async(_args,ctx)=>{const v=await api.askSecret('secret');ctx.append(v===null?'cancelled':'entered')})}`,
  );
  const uploadPath = join(root, 'attach.txt');
  const uploadPayload = Buffer.from('attachment payload');
  await writeFile(uploadPath, uploadPayload);
  const uploadSha = createHash('sha256').update(uploadPayload).digest('hex');

  const settings = trustFolder(defaultSettings(), workspace);
  settings.mcpServers[HUB_SERVER] = {
    type: 'http',
    url: 'http://127.0.0.1:7420/mcp',
    headers: { Authorization: 'Bearer member-tok' },
  };
  saveSettings(settings, home);
  const binding = remoteBotPort(home).binding;

  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model: new ScriptedModel([]),
    emit: () => {},
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });

  const call = (name: RuntimeCommandName, payload: Record<string, unknown>) =>
    controller.dispatch({
      id: randomUUID(),
      name,
      payload,
      sessionId: controller.snapshot().activeSessionId,
    });

  let releaseBot!: () => void;
  let releaseUpload!: () => void;
  let botReached!: () => void;
  let uploadReached!: () => void;
  const botWaiting = new Promise<void>((r) => (botReached = r));
  const uploadWaiting = new Promise<void>((r) => (uploadReached = r));
  let mode: 'bot' | 'upload' | 'fast' = 'bot';

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/bot/v1')) {
      if (mode === 'bot') {
        botReached();
        await new Promise<void>((r) => {
          releaseBot = r;
        });
      }
      return new Response(JSON.stringify({ id: 'bot', current: 'c1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/bot/v1/files/')) {
      if (mode === 'upload') {
        uploadReached();
        await new Promise<void>((r) => {
          releaseUpload = r;
        });
      }
      return new Response(
        JSON.stringify({ sha256: uploadSha, size: uploadPayload.length }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  // 1. Slow remote-bot request must not stall queued set-effort mutation.
  const order1: string[] = [];
  const slowBot = call('remote-bot', { action: 'discover' }).then((reply) => {
    order1.push('remote-bot');
    return reply;
  });
  await botWaiting;
  const effort1 = call('set-effort', { effort: 'high' }).then((reply) => {
    order1.push('set-effort');
    return reply;
  });
  for (let i = 0; i < 8 && order1.length === 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
  releaseBot();
  assert.equal((await effort1).ok, true);
  assert.equal((await slowBot).ok, true);
  assert.deepEqual(order1, ['set-effort', 'remote-bot']);

  // 2. Slow remote-bot-native-file upload must not stall queued set-effort mutation.
  mode = 'upload';
  const order2: string[] = [];
  const slowUpload = call('remote-bot-native-file', {
    action: 'upload',
    binding,
    path: uploadPath,
  }).then((reply) => {
    order2.push('remote-upload');
    return reply;
  });
  await uploadWaiting;
  const effort2 = call('set-effort', { effort: 'low' }).then((reply) => {
    order2.push('set-effort');
    return reply;
  });
  for (let i = 0; i < 8 && order2.length === 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
  releaseUpload();
  assert.equal((await effort2).ok, true);
  assert.equal((await slowUpload).ok, true);
  assert.deepEqual(order2, ['set-effort', 'remote-upload']);

  // 3. Held mutation queue (extension secret prompt) must not block remote-bot calls.
  mode = 'fast';
  const order3: string[] = [];
  const heldMutation = call('custom-command', { name: 'hold', args: '' }).then(
    (reply) => {
      order3.push('held-mutation');
      return reply;
    },
  );
  const deadline = Date.now() + patience(8000);
  while (
    !controller
      .snapshot()
      .interactions.some(
        (row) => row.kind === 'secret' && row.status === 'pending',
      )
  ) {
    if (Date.now() > deadline) throw new Error('timed out waiting for secret');
    await delay(10);
  }
  const fastBot = call('remote-bot', { action: 'discover' }).then((reply) => {
    order3.push('fast-bot');
    return reply;
  });
  assert.equal((await fastBot).ok, true);
  const card = controller
    .snapshot()
    .interactions.find(
      (row) => row.kind === 'secret' && row.status === 'pending',
    )!;
  await controller.dispatch({
    id: randomUUID(),
    name: 'answer',
    sessionId: card.sessionId,
    payload: { id: card.id, revision: card.revision, cancel: true },
  });
  await heldMutation;
  assert.deepEqual(order3, ['fast-bot', 'held-mutation']);
});

test('C20: RuntimeController upload-batch pre-validates all files locally before any upload', async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-bot-batch-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const settings = defaultSettings();
  settings.mcpServers[HUB_SERVER] = {
    type: 'http',
    url: 'http://127.0.0.1:7420/mcp',
    headers: { Authorization: 'Bearer member-tok' },
  };
  saveSettings(settings, home);
  const binding = remoteBotPort(home).binding;

  const valid1 = join(root, 'a.txt');
  const valid2 = join(root, 'b.txt');
  const subDir = join(root, 'folder');
  await writeFile(valid1, 'alpha');
  await writeFile(valid2, 'beta');
  await mkdir(subDir);

  let uploadFetches = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    uploadFetches++;
    const shaHex = url.split('/').pop() ?? '';
    const size =
      shaHex === createHash('sha256').update('alpha').digest('hex') ? 5 : 4;
    return new Response(JSON.stringify({ sha256: shaHex, size }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model: new ScriptedModel([]),
    emit: () => {},
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });

  const dispatchBatch = (paths: string[]): Promise<RuntimeReply> =>
    controller.dispatch({
      id: randomUUID(),
      name: 'remote-bot-native-file',
      payload: { action: 'upload-batch', binding, paths },
      sessionId: controller.snapshot().activeSessionId,
    });

  const invalidBatch = await dispatchBatch([valid1, subDir]);
  assert.equal(invalidBatch.ok, false);
  assert.match(
    String(invalidBatch.error),
    /only a regular file can be attached/,
  );
  assert.equal(
    uploadFetches,
    0,
    'valid1 must not be uploaded when batch fails',
  );

  const tooMany = await dispatchBatch(Array.from({ length: 9 }, () => valid1));
  assert.equal(tooMany.ok, false);
  assert.match(String(tooMany.error), /select up to eight files/);
  assert.equal(uploadFetches, 0);

  const validBatch = await dispatchBatch([valid1, valid2]);
  assert.equal(validBatch.ok, true, validBatch.error);
  assert.equal(uploadFetches, 2);
  assert.deepEqual(
    (validBatch.data as Array<{ name: string; size: number }>).map((f) => ({
      name: f.name,
      size: f.size,
    })),
    [
      { name: 'a.txt', size: 5 },
      { name: 'b.txt', size: 4 },
    ],
  );

  // S11: saveRemoteFile HTTP error responses preserve status/code via RemoteBotError.
  const saveOut = join(root, 'save-fail.txt');
  await assert.rejects(
    () =>
      saveRemoteFile(
        remoteBotPort(home),
        {
          name: 'save-fail.txt',
          sha256: createHash('sha256').update('x').digest('hex'),
          size: 1,
        },
        saveOut,
        (async () =>
          new Response(
            JSON.stringify({
              code: 'BOT_CLIENT_FORBIDDEN',
              message: 'direct member token required',
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          )) as typeof fetch,
      ),
    (error: unknown) =>
      error instanceof RemoteBotError &&
      error.status === 403 &&
      error.code === 'BOT_CLIENT_FORBIDDEN' &&
      error.remoteMessage === 'direct member token required',
  );

  // S12: uploadSelectedBatch mid-batch failure on file 3 of 5 reports uploaded count, total, and failing filename.
  const fiveFiles = await Promise.all(
    ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map(async (name) => {
      const p = join(root, name);
      await writeFile(p, name);
      return p;
    }),
  );
  let attempt = 0;
  await assert.rejects(
    () =>
      uploadSelectedBatch(remoteBotPort(home), fiveFiles, (async (
        input: string | URL | Request,
      ) => {
        attempt++;
        if (attempt === 3) {
          return new Response(
            JSON.stringify({
              code: 'BOT_QUOTA_EXCEEDED',
              message: 'quota exceeded',
            }),
            { status: 413, headers: { 'content-type': 'application/json' } },
          );
        }
        const shaHex = String(input).split('/').pop() ?? '';
        return new Response(JSON.stringify({ sha256: shaHex, size: 5 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch),
    (error: unknown) => {
      assert.ok(error instanceof PartialBatchUploadError);
      assert.equal(error.uploaded, 2);
      assert.equal(error.total, 5);
      assert.equal(error.fileName, 'c.txt');
      assert.equal(error.reason, 'quota exceeded');
      assert.equal(error.status, 413);
      assert.equal(error.code, 'BOT_QUOTA_EXCEEDED');
      assert.equal(
        error.message,
        'Uploaded 2 of 5 files; failed on c.txt: quota exceeded',
      );
      return true;
    },
  );
});

test('T2: preload unwrapBotTransfer preserves structured error metadata and fails on error envelopes', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/preload.ts', import.meta.url))],
    platform: 'node',
    format: 'cjs',
    bundle: true,
    external: ['electron'],
    write: false,
  });
  let bridge!: DesktopBridge;
  let nextReply: unknown;
  runInNewContext(result.outputFiles[0]!.text, {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_key: string, api: DesktopBridge) => {
          bridge = api;
        },
      },
      ipcRenderer: {
        invoke: async () => nextReply,
        send: () => {},
        on: () => {},
        removeListener: () => {},
      },
    }),
  });

  nextReply = {
    ok: true,
    data: [{ name: 'ok.txt', sha256: 'a'.repeat(64), size: 2 }],
  };
  assert.deepEqual(await bridge.attachBotFiles!('b1'), [
    { name: 'ok.txt', sha256: 'a'.repeat(64), size: 2 },
  ]);

  nextReply = {
    ok: false,
    error: 'Uploaded 1 of 3 files; failed on c: d.txt: fetch failed',
    errorStatus: 413,
    errorCode: 'BOT_QUOTA_EXCEEDED',
    errorDetail: 'quota full',
    errorUploaded: 1,
    errorTotal: 3,
    errorFileName: 'c: d.txt',
    errorReason: 'fetch failed',
  };
  await assert.rejects(
    () => bridge.attachBotFiles!('b1'),
    (error: unknown) => {
      const meta = error as {
        message?: unknown;
        status?: number;
        code?: string;
        detail?: string;
        errorUploaded?: number;
        errorTotal?: number;
        errorFileName?: string;
        errorReason?: string;
      };
      return (
        meta?.message ===
          'Uploaded 1 of 3 files; failed on c: d.txt: fetch failed' &&
        meta.status === 413 &&
        meta.code === 'BOT_QUOTA_EXCEEDED' &&
        meta.detail === 'quota full' &&
        meta.errorUploaded === 1 &&
        meta.errorTotal === 3 &&
        meta.errorFileName === 'c: d.txt' &&
        meta.errorReason === 'fetch failed'
      );
    },
  );

  nextReply = {
    ok: false,
    error: 'attachment quota exceeded',
    errorStatus: 413,
    errorCode: 'BOT_QUOTA_EXCEEDED',
  };
  await assert.rejects(
    () =>
      bridge.saveBotFile!('b1', {
        name: 'ok.txt',
        sha256: 'a'.repeat(64),
        size: 2,
      }),
    (error: unknown) => {
      const meta = error as {
        message?: unknown;
        status?: number;
        code?: string;
      };
      return (
        meta?.message === 'attachment quota exceeded' &&
        meta.status === 413 &&
        meta.code === 'BOT_QUOTA_EXCEEDED'
      );
    },
  );
});

test('F14/F19: RuntimeController exposes hasAuthorizationHeader + settingsPath on mcp entries, preserves PartialBatchUploadError fields, and sanitizes fs errors', async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-bot-f14-f19-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const settings = defaultSettings();
  settings.mcpServers[HUB_SERVER] = {
    type: 'http',
    url: 'http://127.0.0.1:7420/mcp',
    headers: { Authorization: 'Bearer member-tok' },
  };
  saveSettings(settings, home);
  const binding = remoteBotPort(home).binding;

  const fileA = join(root, 'a.txt');
  const fileColon = join(root, 'c: d.txt');
  const fileC = join(root, 'e.txt');
  await writeFile(fileA, 'alpha');
  await writeFile(fileColon, 'colon');
  await writeFile(fileC, 'gamma');

  let uploadCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    uploadCalls++;
    if (uploadCalls === 2) {
      throw new Error('fetch failed');
    }
    const shaHex = String(input).split('/').pop() ?? '';
    return new Response(JSON.stringify({ sha256: shaHex, size: 5 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model: new ScriptedModel([]),
    emit: () => {},
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });

  const hubEntry = controller.snapshot().mcp.find((m) => m.name === HUB_SERVER);
  assert.equal(hubEntry?.hasAuthorizationHeader, true);
  assert.equal(hubEntry?.settingsPath, join(home, 'settings.json'));

  const batchReply = await controller.dispatch({
    id: randomUUID(),
    name: 'remote-bot-native-file',
    payload: {
      action: 'upload-batch',
      binding,
      paths: [fileA, fileColon, fileC],
    },
    sessionId: controller.snapshot().activeSessionId,
  });
  assert.equal(batchReply.ok, false);
  assert.equal(batchReply.errorUploaded, 1);
  assert.equal(batchReply.errorTotal, 3);
  assert.equal(batchReply.errorFileName, 'c: d.txt');
  assert.equal(batchReply.errorReason, 'fetch failed');

  const missingPath = join(root, 'secret-missing-path.txt');
  await assert.rejects(
    () => uploadSelected(remoteBotPort(home), missingPath, fetch),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'file unavailable' &&
      !error.message.includes(root),
  );

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = join(root, 'locked.txt');
    await writeFile(locked, 'secret');
    await chmod(locked, 0o000);
    await assert.rejects(
      () => uploadSelected(remoteBotPort(home), locked, fetch),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'file permission denied' &&
        !error.message.includes(root),
    );
  }
});

test('F11/F15: docs/extensions.md and CHANGELOG.md document remote-bot contracts cleanly without accidental blank lines', async () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const extensionsDoc = await readFile(
    join(repoRoot, 'docs', 'extensions.md'),
    'utf8',
  );
  assert.match(extensionsDoc, /configVersion/);
  assert.match(extensionsDoc, /disable.*bot_disabled_aborted/);
  assert.match(extensionsDoc, /16,000/);
  assert.match(extensionsDoc, /8 files/);
  assert.match(extensionsDoc, /64,000/);
  assert.match(extensionsDoc, /256 KiB/);
  assert.match(extensionsDoc, /20 MiB/);
  assert.match(
    extensionsDoc,
    /test:remote-bot.*fixture.*rather than opening OS file-picker dialogs/s,
  );
  assert.match(
    extensionsDoc,
    /test:remote-bot.*member token redaction in DOM and logs.*model secret redaction runs in paired mode/s,
  );
  assert.match(
    extensionsDoc,
    /test:remote-bot.*without.*asserting notice classification/s,
  );
  assert.match(
    extensionsDoc,
    /test:paired.*WeCom adapter.*WeCom SDK.*\/api\/bot-channel\/v1.*direct `?\/api\/bot\/v1`?.*not Desktop's/s,
  );

  const changelog = await readFile(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  assert.doesNotMatch(changelog, /^### Added\n\n- \*\*Private remote chat/m);
  assert.doesNotMatch(
    changelog,
    /^### Changed\n\n- \*\*Finished background jobs/m,
  );
  assert.doesNotMatch(
    changelog,
    /^### Fixed\n\n- \*\*Pack scripts in the desktop app/m,
  );
  assert.doesNotMatch(
    changelog,
    /The narrow settings dialog stays on whole pixels\..*\n\n## 1\.14\.0/m,
  );
});
