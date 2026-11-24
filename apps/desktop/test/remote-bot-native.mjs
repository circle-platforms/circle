import { _electron as electron, request } from 'playwright';
import { VERSION } from '../../../src/version.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthorizedServer } from '../../../tests/fixtures/knowledge-sync/authorized-server.ts';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const hubRepo =
  process.argv[2] && process.argv[2] !== 'standalone' ? process.argv[2] : null;
const standalone = !hubRepo;
const afterExit = 'finish after desktop exits';
const held = Promise.withResolvers();
const issued = [];
const scratch = await mkdtemp(join(tmpdir(), 'circle-bot-native-'));

async function startStandaloneBackend() {
  const auth = new AuthorizedServer(join(scratch, 'peer'));
  auth.device = true;
  await auth.start();

  const memberToken = 'synthetic-direct-member-token';
  const logs = [];
  const storedFiles = new Map();
  const seenBotHeaders = [];
  let cursorSeq = 0;
  let convSeq = 1;
  let currentConv = 'conv-1';
  const conversations = new Map([
    [currentConv, { events: [], seenRequests: new Set(), active: null }],
  ]);
  let phase2Token = false;
  let forceUnauthenticated = false;
  let forceVersionMismatch = false;
  let forceQuotaExceeded = false;

  const readBytes = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };

  const json = (res, status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname === '/api/bot/v1') {
      logs.push(`POST /api/bot/v1\n`);
      seenBotHeaders.push({ ...req.headers });
      if (req.headers['bot-client-version'] !== VERSION) {
        return json(res, 400, {
          code: 'BOT_VERSION_INVALID',
          message: 'invalid bot client version',
        });
      }
      if (req.headers['circle-version'] !== undefined) {
        return json(res, 400, {
          code: 'BOT_VERSION_INVALID',
          message: 'legacy circle-version header must not be sent',
        });
      }
      const authHeader = req.headers.authorization ?? '';
      if (forceUnauthenticated) {
        return json(res, 401, {
          code: 'BOT_UNAUTHENTICATED',
          message: 'unauthorized',
        });
      }
      if (forceVersionMismatch) {
        return json(res, 400, {
          code: 'BOT_VERSION_MISMATCH',
          message: 'client version mismatch',
        });
      }
      if (authHeader === `Bearer ${auth.token}` && !phase2Token) {
        return json(res, 403, {
          code: 'BOT_CLIENT_FORBIDDEN',
          message: 'oauth client token is not allowed',
        });
      }
      if (authHeader !== `Bearer ${memberToken}`) {
        return json(res, 401, {
          code: 'BOT_UNAUTHENTICATED',
          message: 'unauthorized',
        });
      }
      const op = JSON.parse((await readBytes(req)).toString('utf8'));
      if (op.action === 'discover') {
        return json(res, 200, {
          id: 'synthetic-bot',
          name: 'Synthetic Member Bot',
          current: currentConv,
        });
      }
      if (op.action === 'new') {
        currentConv = `conv-${++convSeq}`;
        conversations.set(currentConv, {
          events: [],
          seenRequests: new Set(),
          active: null,
        });
        return json(res, 200, { current: currentConv });
      }
      const conv = conversations.get(String(op.conversation ?? currentConv));
      if (!conv) return json(res, 404, { message: 'unknown conversation' });
      if (op.action === 'history') {
        const after = Number(op.after ?? 0);
        return json(res, 200, {
          events: conv.events.filter((e) => e.cursor > after),
          queued: [],
          deliveries: [],
          fileDeliveries: [],
          active: conv.active,
          question: null,
        });
      }
      if (op.action === 'stop') {
        conv.active = null;
        return json(res, 200, { stopped: true });
      }
      if (op.action === 'send') {
        const reqId = String(op.request ?? '');
        if (!conv.seenRequests.has(reqId)) {
          conv.seenRequests.add(reqId);
          const text = String(op.text ?? '');
          const files = Array.isArray(op.files) ? op.files : [];
          let fileText = '';
          if (files.length > 0) {
            const bytes = storedFiles.get(files[0].sha256);
            fileText = bytes ? bytes.toString('utf8') : '';
          }
          issued.push({
            messages: [
              {
                role: 'user',
                content: fileText ? `${text}\n${fileText}` : text,
              },
            ],
          });
          conv.events.push({
            id: `u-${reqId}`,
            at: new Date().toISOString(),
            role: 'user',
            text,
            ...(files.length ? { files } : {}),
            cursor: ++cursorSeq,
          });
          if (text === afterExit) {
            conv.active = { request: reqId, draft: '' };
            void held.promise.then(() => {
              conv.active = null;
              conv.events.push({
                id: `a-${reqId}`,
                at: new Date().toISOString(),
                role: 'assistant',
                text: 'finished without desktop',
                cursor: ++cursorSeq,
              });
            });
          } else {
            const reply = text === '回复 OK' ? 'OK' : 'synthetic remote reply';
            conv.events.push({
              id: `a-${reqId}`,
              at: new Date().toISOString(),
              role: 'assistant',
              text: reply,
              cursor: ++cursorSeq,
            });
          }
        }
        return json(res, 200, { accepted: true });
      }
      return json(res, 400, { message: 'unknown action' });
    }

    if (reqUrl.pathname.startsWith('/api/bot/v1/files/')) {
      const authHeader = req.headers.authorization ?? '';
      if (forceUnauthenticated) {
        return json(res, 401, {
          code: 'BOT_UNAUTHENTICATED',
          message: 'unauthorized',
        });
      }
      if (authHeader === `Bearer ${auth.token}` && !phase2Token) {
        return json(res, 403, {
          code: 'BOT_CLIENT_FORBIDDEN',
          message: 'oauth client token is not allowed',
        });
      }
      if (authHeader !== `Bearer ${memberToken}`) {
        return json(res, 401, {
          code: 'BOT_UNAUTHENTICATED',
          message: 'unauthorized',
        });
      }
      if (forceQuotaExceeded) {
        return json(res, 413, {
          code: 'BOT_QUOTA_EXCEEDED',
          message: 'attachment quota exceeded',
        });
      }
      const shaHex = reqUrl.pathname.slice('/api/bot/v1/files/'.length);
      if (req.method === 'PUT') {
        const bytes = await readBytes(req);
        const actualSha = createHash('sha256').update(bytes).digest('hex');
        if (actualSha !== shaHex) {
          return json(res, 400, { message: 'sha mismatch' });
        }
        storedFiles.set(shaHex, bytes);
        return json(res, 200, { sha256: shaHex, size: bytes.length });
      }
      if (req.method === 'GET') {
        const bytes = storedFiles.get(shaHex);
        if (!bytes) return json(res, 404, { message: 'not found' });
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
        });
        res.end(bytes);
        return;
      }
      return json(res, 405, { message: 'method not allowed' });
    }

    auth.server.emit('request', req, res);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  auth.origin = origin;
  auth.peer.origin = origin;

  return {
    url: origin,
    memberToken,
    logs,
    seenBotHeaders,
    setForceUnauthenticated: (value) => {
      forceUnauthenticated = value;
    },
    setForceVersionMismatch: (value) => {
      forceVersionMismatch = value;
    },
    setForceQuotaExceeded: (value) => {
      forceQuotaExceeded = value;
    },
    async approveOAuth() {
      auth.deviceApproved = true;
    },
    async enableDirectToken() {
      phase2Token = true;
      auth.token = memberToken;
      auth.peer.token = memberToken;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      await auth.close();
    },
  };
}

async function startPairedBackend(repoRoot) {
  const hubModule = (path) =>
    import(pathToFileURL(resolve(repoRoot, path)).href);
  const { createTestServer, testConsoleCredentials } = await hubModule(
    'hub/server/testing.ts',
  );
  const { callBot } = await hubModule('hub/server/personal-bot.ts');
  const { startPostgres } = await hubModule('hub/testing/postgres.ts');
  const { createCommandBridge } = await hubModule(
    'hub/server/command-bridge.ts',
  );
  const postgres = await startPostgres({ socket: true, passwordless: true });
  const hub = await createTestServer({
    postgres,
    bridge: (kit) =>
      createCommandBridge({
        cwd: kit.dataDir,
        env: {
          CIRCLE_HUB_DATA_DIR: kit.dataDir,
          CIRCLE_HUB_PORT: '0',
          CIRCLE_HUB_DATABASE_SOCKET_DIR: postgres.socketDir,
          CIRCLE_HUB_DATABASE_PORT: String(kit.database.port),
          CIRCLE_HUB_DATABASE_NAME: kit.database.database,
          CIRCLE_HUB_DATABASE_USER: kit.database.user,
        },
        overrides: { keyProvider: () => kit.keyProvider },
      }),
  });
  const member = await hub.createUser('合成首次登录成员');
  const key = 'synthetic-model-key-A';
  let acceptedKey = key;
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.headers.authorization !== 'Bearer ' + acceptedKey) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_api_key' } }));
      return;
    }
    if (body.model !== 'scripted-model') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'model_not_found' } }));
      return;
    }
    issued.push(body);
    if (body.messages.at(-1)?.content === afterExit) await held.promise;
    const answer =
      body.messages.at(-1)?.content === '回复 OK'
        ? 'OK'
        : body.messages.at(-1)?.content === afterExit
          ? 'finished without desktop'
          : 'synthetic remote reply';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [
      [{ role: 'assistant', content: answer }, null],
      [{}, 'stop'],
    ])
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'scripted',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          '\n\n',
      );
    res.end('data: [DONE]\n\n');
  });
  await new Promise((ok) => model.listen(0, '127.0.0.1', ok));
  const endpoint = 'http://127.0.0.1:' + model.address().port + '/v1';
  const config = {
    name: 'Synthetic Member Bot',
    protocol: 'openai',
    model: 'scripted-model',
    endpoint,
    key,
  };
  const directory = join(hub.deps.config.dataDir, 'bot-runtime');
  const host = spawn(
    process.execPath,
    [join(desktop, '../../dist/cli.js'), 'remote-bot', directory],
    { env: { PATH: process.env.PATH, HOME: scratch }, stdio: 'ignore' },
  );
  const exited = once(host, 'exit');

  async function waitForHost(check, label) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const v = await check();
      if (v) return v;
      await delay(60);
    }
    throw new Error('waiting for ' + label);
  }

  await waitForHost(
    async () =>
      (
        await callBot(hub.deps.config.dataDir, {
          owner: 'probe',
          op: { action: 'discover' },
        })
      ).status === 200,
    'host',
  );

  for (const [change, status, code, message] of [
    [
      { key: 'synthetic-bad' },
      422,
      'model_auth_failed',
      'model endpoint rejected credentials',
    ],
    [
      { model: 'absent-model' },
      422,
      'model_not_found',
      'model id is unavailable',
    ],
    [{}, 200, null, null],
  ]) {
    const result = await callBot(hub.deps.config.dataDir, {
      owner: hub.admin.principal.id,
      op: { action: 'test' },
      config: { ...config, ...change },
    });
    assert.equal(result.status, status);
    if (message) {
      assert.equal(result.body.code, code);
      assert.equal(result.body.message, message);
    } else {
      assert.equal(result.body.tested, true);
    }
  }

  const admin = await request.newContext({
    baseURL: hub.url,
    extraHTTPHeaders: { origin: hub.url },
  });
  try {
    const token = (text) => /name="csrf" value="([^"]+)"/.exec(text)?.[1];
    const login = await admin.get('/console/login');
    const signed = await admin.post('/console/login', {
      form: {
        ...testConsoleCredentials(hub.admin.token),
        csrf: token(await login.text()),
      },
      maxRedirects: 0,
    });
    assert.equal(signed.status(), 303);
    const setup = async (changes = {}) => {
      const settings = await admin.get('/console/settings?tab=bot');
      const body = await settings.text();
      assert.ok(!body.includes(acceptedKey));
      assert.ok(body.includes('/console/admin/do/bot-set'));
      const result = await admin.post('/console/admin/do/bot-set', {
        form: {
          csrf: token(body),
          name: config.name,
          endpoint: config.endpoint,
          protocol: config.protocol,
          model: config.model,
          value: acceptedKey,
          ...changes,
        },
      });
      const rendered = await result.text();
      assert.ok(rendered.includes('机器人模型配置已保存'));
      assert.ok(!rendered.includes(acceptedKey));
    };
    const testBot = async (phrase) => {
      const body = await (await admin.get('/console/settings?tab=bot')).text();
      const result = await admin.post('/console/admin/do/bot-test', {
        form: { csrf: token(body) },
      });
      const rendered = await result.text();
      assert.ok(
        rendered.includes(phrase),
        'model connection result: ' + phrase,
      );
      assert.ok(!rendered.includes(acceptedKey));
    };
    await setup();
    await testBot('机器人已用指定模型收到回复');
    acceptedKey = 'synthetic-model-key-B';
    await testBot('model endpoint rejected credentials');
    await setup({ model: 'missing-model' });
    await testBot('model id is unavailable');
    const closed = createServer();
    await new Promise((done) => closed.listen(0, '127.0.0.1', done));
    const closedPort = closed.address().port;
    await new Promise((done) => closed.close(done));
    await setup({ endpoint: 'http://127.0.0.1:' + closedPort });
    await testBot('model endpoint unreachable or timed out');
    await setup();
    await testBot('机器人已用指定模型收到回复');
  } finally {
    await admin.dispose();
  }

  let web;
  return {
    url: hub.url,
    memberToken: member.token,
    secretKey: key,
    logs: hub.logs,
    async approveOAuth(code) {
      web = await request.newContext({
        baseURL: hub.url,
        extraHTTPHeaders: { origin: hub.url },
      });
      const csrf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];
      const post = (path, form) => web.post(path, { form, maxRedirects: 0 });
      const login = await web.get('/console/login');
      assert.equal(
        (
          await post('/console/login', {
            csrf: csrf(await login.text()),
            ...testConsoleCredentials(member.token),
          })
        ).status(),
        303,
      );
      const device = await web.get('/console/device');
      const typed = await post('/console/device', {
        csrf: csrf(await device.text()),
        user_code: code,
      });
      assert.equal(typed.status(), 303);
      const location = typed.headers().location;
      const confirmation = await (await web.get(location)).text();
      const account = /name="account" value="([^"]+)"/.exec(confirmation)?.[1];
      assert.equal(account, member.principal.id);
      assert.equal(
        (
          await post(location, {
            csrf: csrf(confirmation),
            step: 'decide',
            decision: 'approve',
            account,
          })
        ).status(),
        303,
      );
    },
    async enableDirectToken() {},
    async close() {
      await web?.dispose();
      host.kill('SIGTERM');
      await exited;
      await new Promise((ok) => model.close(ok));
      await hub.close();
      await postgres.stop();
    },
  };
}

const backend = standalone
  ? await startStandaloneBackend()
  : await startPairedBackend(hubRepo);

let app, page;
async function waitFor(check, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const v = await check();
    if (v) return v;
    await delay(60);
  }
  throw new Error('waiting for ' + label);
}

try {
  const inputFile = join(scratch, 'fixture.txt');
  const outputFile = join(scratch, 'downloaded.txt');
  await writeFile(inputFile, 'synthetic private attachment');
  const data = join(scratch, 'desktop');
  const settingsPath = join(data, 'runtime-home', 'settings.json');
  await mkdir(data, { recursive: true });
  const require = createRequire(import.meta.url);
  const packaged =
    process.argv[3] === 'packaged' ||
    Boolean(process.env.CIRCLE_DESKTOP_EXECUTABLE);
  const bundle = join(desktop, 'out/Circle-darwin-arm64/Circle.app');
  const executablePath =
    process.env.CIRCLE_DESKTOP_EXECUTABLE ??
    (packaged ? join(bundle, 'Contents/MacOS/Circle') : require('electron'));
  const launchArgs = process.env.CIRCLE_DESKTOP_EXECUTABLE
    ? [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? desktop)]
    : process.argv[3] === 'packaged'
      ? []
      : [desktop];

  const env = {
    ...process.env,
    HOME: scratch,
    CIRCLE_HOME: join(scratch, 'circle'),
    CIRCLE_WORKBENCH_DATA_DIR: data,
    CIRCLE_WORKBENCH_MODE: 'live',
    CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
    CIRCLE_NO_UPDATE_CHECK: '1',
    CIRCLE_NO_MODELS_REFRESH: '1',
    CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
      files: [inputFile],
      exportPath: outputFile,
    }),
    CIRCLE_WORKBENCH_BACKGROUND_TEST: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const launchElectron = async (language = 'en-US') => {
    const launched = await electron.launch({
      chromiumSandbox: true,
      executablePath,
      args: launchArgs,
      cwd: desktop,
      env: { ...env, CIRCLE_WORKBENCH_LANGUAGE: language },
      timeout: 45000,
    });
    const win = await launched.firstWindow();
    win.setDefaultTimeout(20000);
    await win.waitForFunction(
      () =>
        location.hash.startsWith('#/session/') ||
        location.hash.startsWith('#/home'),
    );
    return { launched, win };
  };

  // Phase 1: OAuth device login connects MCP; Hub H5 rejects OAuth token with 403 BOT_CLIENT_FORBIDDEN.
  ({ launched: app, win: page } = await launchElectron());
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    location.hash = '/page/extensions?plugin=hub';
  });
  const card = page.locator('#hub-connection');
  await card.getByRole('checkbox', { name: 'enable Hub', exact: true }).check();
  await card
    .getByRole('textbox', { name: 'hub IP address', exact: true })
    .fill(backend.url);
  await card.getByRole('button', { name: 'connect', exact: true }).click();
  const code = await waitFor(
    async () =>
      page.evaluate(
        async () =>
          (await window.circleDesktop.runtimeState()).snapshot.mcp.find(
            (r) => r.name === 'Hub',
          )?.signIn?.code,
      ),
    'device code',
  );
  await backend.approveOAuth(code);
  await waitFor(
    async () =>
      page.evaluate(async () =>
        (await window.circleDesktop.runtimeState()).snapshot.mcp.some(
          (r) => r.name === 'Hub' && r.status === 'connected',
        ),
      ),
    'Hub OAuth authorization',
  );
  await page.keyboard.press('Escape');
  await page
    .getByRole('link', { name: 'my bot', exact: true })
    .first()
    .click({ timeout: 30000 });
  await page
    .locator('[data-bot-error-kind="oauth-forbidden"]')
    .waitFor({ timeout: 20000 });
  await page
    .getByRole('heading', { name: 'direct member token required', exact: true })
    .waitFor();
  const enForbiddenText =
    (await page
      .locator('[data-bot-error-kind="oauth-forbidden"]')
      .textContent()) ?? '';
  assert.ok(enForbiddenText.includes(settingsPath), enForbiddenText);
  assert.ok(enForbiddenText.includes('Bearer <token>'), enForbiddenText);
  if (standalone) {
    assert.ok(backend.seenBotHeaders.length >= 1);
    assert.equal(backend.seenBotHeaders[0]['bot-client-version'], VERSION);
    assert.equal(backend.seenBotHeaders[0]['circle-version'], undefined);
  }

  // Verify zh-CN error localization on native Electron for 403 BOT_CLIENT_FORBIDDEN (and 401 / 400 BOT_VERSION_MISMATCH in standalone).
  await Promise.race([app.close().catch(() => {}), delay(4000)]);
  try {
    app.process()?.kill('SIGKILL');
  } catch {}
  app = undefined;
  page = undefined;
  ({ launched: app, win: page } = await launchElectron('zh-CN'));
  await page.keyboard.press('Escape');
  await page
    .getByRole('link', { name: '我的机器人', exact: true })
    .first()
    .click({ timeout: 30000 });
  const zhForbidden = page.locator('[data-bot-error-kind="oauth-forbidden"]');
  await zhForbidden.waitFor({ timeout: 20000 });
  const zhForbiddenText = (await zhForbidden.textContent()) ?? '';
  assert.match(zhForbiddenText, /需要使用直接成员令牌/);
  assert.ok(zhForbiddenText.includes(settingsPath), zhForbiddenText);
  assert.ok(zhForbiddenText.includes('Bearer <令牌>'), zhForbiddenText);
  assert.match(zhForbiddenText, /headers\.Authorization/);
  if (standalone) {
    backend.setForceUnauthenticated(true);
    await zhForbidden
      .getByRole('button', { name: '重试', exact: true })
      .click();
    const zhAuth = page.locator('[data-bot-error-kind="auth"]');
    await zhAuth.waitFor({ timeout: 20000 });
    assert.match((await zhAuth.textContent()) ?? '', /机器人登录已过期/);
    backend.setForceUnauthenticated(false);

    backend.setForceVersionMismatch(true);
    await zhAuth.getByRole('button', { name: '重试', exact: true }).click();
    const zhVersionMismatch = page.locator(
      '[data-bot-error-kind="version-mismatch"]',
    );
    await zhVersionMismatch.waitFor({ timeout: 20000 });
    assert.match(
      (await zhVersionMismatch.textContent()) ?? '',
      /需要更新 Circle/,
    );
    backend.setForceVersionMismatch(false);
  }

  // Phase 2: Direct member Bearer token configured on Hub MCP entry completes full round trip.
  await Promise.race([app.close().catch(() => {}), delay(4000)]);
  try {
    app.process()?.kill('SIGKILL');
  } catch {}
  app = undefined;
  page = undefined;

  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  settings.mcpServers.Hub = {
    ...settings.mcpServers.Hub,
    type: 'http',
    enabled: true,
    headers: { Authorization: 'Bearer ' + backend.memberToken },
  };
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  await backend.enableDirectToken();

  ({ launched: app, win: page } = await launchElectron());
  await waitFor(
    async () =>
      page.evaluate(async () =>
        (await window.circleDesktop.runtimeState()).snapshot.mcp.some(
          (r) => r.name === 'Hub' && r.status === 'connected',
        ),
      ),
    'Hub direct Bearer connection',
  );
  await page.keyboard.press('Escape');
  await page
    .getByRole('link', { name: 'my bot', exact: true })
    .first()
    .click({ timeout: 30000 });
  const input = page.getByRole('textbox', { name: 'message your bot' });
  await input.fill('synthetic first message');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await page.getByText('synthetic remote reply', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('synthetic remote reply', { exact: true }).waitFor();
  assert.equal(
    issued.filter(
      (call) => call.messages.at(-1)?.content === 'synthetic first message',
    ).length,
    1,
  );
  await page.getByRole('button', { name: 'attach files', exact: true }).click();
  await page.getByText('fixture.txt', { exact: true }).waitFor();
  await input.fill('read my attachment');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await waitFor(
    () =>
      issued.some((call) =>
        String(call.messages.at(-1)?.content).includes(
          'synthetic private attachment',
        ),
      ),
    'verified attachment reaching the remote model',
  );
  await page.getByRole('button', { name: /fixture\.txt ·/ }).click();
  await waitFor(
    async () =>
      (await readFile(outputFile, 'utf8').catch(() => null)) ===
      'synthetic private attachment',
    'verified native download',
  );
  const domTextPhase2 = await page.locator('body').innerText();
  if (!standalone && backend.secretKey) {
    assert.ok(!domTextPhase2.includes(backend.secretKey));
  }
  assert.ok(!domTextPhase2.includes(backend.memberToken));
  await input.fill(afterExit);
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await waitFor(
    () => issued.some((call) => call.messages.at(-1)?.content === afterExit),
    'host accepted turn',
  );
  await Promise.race([app.close().catch(() => {}), delay(4000)]);
  try {
    app.process()?.kill('SIGKILL');
  } catch {}
  app = undefined;
  page = undefined;
  held.resolve();

  const application = async (op) =>
    (
      await fetch(backend.url + '/api/bot/v1', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + backend.memberToken,
          'bot-client-version': VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(op),
      })
    ).json();
  const found = await application({ action: 'discover' });
  await waitFor(
    async () =>
      (
        await application({
          action: 'history',
          conversation: found.current,
          after: 0,
        })
      ).events.some((e) => e.text === 'finished without desktop'),
    'host completed after Mac exit',
  );
  if (standalone) {
    // T2: exercise real main.ts -> preload.ts unwrapBotTransfer IPC failure path on saveBotFile & attachBotFiles.
    backend.setForceQuotaExceeded(true);
    ({ launched: app, win: page } = await launchElectron('zh-CN'));
    await page.keyboard.press('Escape');
    await page
      .getByRole('link', { name: '我的机器人', exact: true })
      .first()
      .click({ timeout: 30000 });
    const saveChip = page
      .getByRole('button', { name: /fixture\.txt ·/ })
      .first();
    await saveChip.waitFor({ timeout: 20000 });
    await saveChip.click();
    await waitFor(
      async () =>
        (
          (await page
            .locator('.composer-area [role="status"]')
            .textContent()
            .catch(() => '')) ?? ''
        ).includes('机器人附件配额已满'),
      'localized saveBotFile 413 BOT_QUOTA_EXCEEDED error',
    );
    await page.reload();
    await page.locator('#remote-bot-input').waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: '附加文件…', exact: true }).click();
    await waitFor(
      async () =>
        (
          (await page
            .locator('.composer-area [role="status"]')
            .textContent()
            .catch(() => '')) ?? ''
        ).includes('机器人附件配额已满'),
      'localized attachBotFiles 413 BOT_QUOTA_EXCEEDED error',
    );
    const zhDomText = await page.locator('body').innerText();
    assert.ok(!zhDomText.includes(backend.memberToken));
    await Promise.race([app.close().catch(() => {}), delay(4000)]);
    try {
      app.process()?.kill('SIGKILL');
    } catch {}
    app = undefined;
    page = undefined;
    backend.setForceQuotaExceeded(false);
  }
  async function readLogFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await readLogFiles(full)));
      } else if (entry.isFile()) {
        files.push({ path: full, text: await readFile(full, 'utf8') });
      }
    }
    return files;
  }
  const logFiles = await readLogFiles(join(data, 'logs'));
  for (const file of logFiles) {
    assert.ok(
      !file.text.includes(backend.memberToken),
      `memberToken leaked into log file: ${file.path}`,
    );
  }
  if (!standalone && backend.secretKey) {
    assert.ok(!JSON.stringify(issued).includes(backend.secretKey));
    assert.ok(!backend.logs.join('').includes(backend.secretKey));
    assert.ok(
      !(await readFile(settingsPath, 'utf8')).includes(backend.secretKey),
    );
    for (const file of logFiles) {
      assert.ok(
        !file.text.includes(backend.secretKey),
        `secretKey leaked into log file: ${file.path}`,
      );
    }
  }
  console.log(
    (packaged ? 'Packaged' : 'Development') +
      (standalone
        ? ' (standalone): OAuth H5 refusal, direct Bearer chat, scripted remote reply, reload, attachment round trip, member token redaction and completion after app exit passed (model secret redaction not checked in standalone mode).'
        : ' (paired): OAuth H5 refusal, direct Bearer chat, scripted remote reply, reload, attachment round trip and completion after app exit passed.'),
  );
} catch (error) {
  if (page)
    console.error(
      await page
        .evaluate(async () => ({
          connections: (
            await window.circleDesktop.runtimeState()
          ).snapshot.mcp.map(({ name, status, error }) => ({
            name,
            status,
            error,
          })),
          links: [...document.querySelectorAll('a[href]')].map((a) =>
            a.textContent?.slice(0, 45),
          ),
        }))
        .catch(() => null),
    );
  if (page)
    console.error(
      await page
        .evaluate(() => ({
          route: location.hash,
          headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(
            (e) => e.textContent,
          ),
          notices: Array.from(document.querySelectorAll('[role=alert]')).map(
            (e) => e.textContent,
          ),
          statuses: Array.from(document.querySelectorAll('[role=status]')).map(
            (e) => e.textContent,
          ),
          composerHtml:
            document.querySelector('.composer-area')?.innerHTML ?? null,
        }))
        .catch(() => null),
    );
  throw error;
} finally {
  held.resolve();
  if (app) {
    await Promise.race([app.close().catch(() => {}), delay(4000)]);
    try {
      app.process()?.kill('SIGKILL');
    } catch {}
  }
  await Promise.race([backend.close().catch(() => {}), delay(3000)]);
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
