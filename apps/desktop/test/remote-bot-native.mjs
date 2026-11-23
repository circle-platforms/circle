import { _electron as electron, request } from 'playwright';
import { VERSION } from '../../../src/version.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const desktop = fileURLToPath(new URL('..', import.meta.url));
const hubModule = (path) =>
  import(pathToFileURL(resolve(process.argv[2], path)).href);
const { createTestServer, testConsoleCredentials } = await hubModule(
  'hub/server/testing.ts',
);
const { callBot } = await hubModule('hub/server/personal-bot.ts');
const { startPostgres } = await hubModule('hub/testing/postgres.ts');
const { createCommandBridge } = await hubModule('hub/server/command-bridge.ts');
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
const scratch = await mkdtemp(join(tmpdir(), 'circle-bot-native-'));
const member = await hub.createUser('合成首次登录成员');
const issued = [];
const key = 'synthetic-model-key-A';
let acceptedKey = key;
const held = Promise.withResolvers();
const afterExit = 'finish after desktop exits';
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
let app, web, page;
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
  await waitFor(
    async () =>
      (
        await callBot(hub.deps.config.dataDir, {
          owner: 'probe',
          op: { action: 'discover' },
        })
      ).status === 200,
    'host',
  );
  for (const [change, status, message] of [
    [{ key: 'synthetic-bad' }, 422, '模型端点拒绝凭据'],
    [{ model: 'absent-model' }, 422, '模型 ID 不可用'],
    [{}, 200, null],
  ]) {
    const result = await callBot(hub.deps.config.dataDir, {
      owner: hub.admin.principal.id,
      op: { action: 'test' },
      config: { ...config, ...change },
    });
    assert.equal(result.status, status);
    if (message) assert.equal(result.body.message, message);
    else assert.equal(result.body.tested, true);
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
      assert.ok(
        rendered.includes('机器人模型配置已保存'),
        JSON.stringify({
          status: result.status(),
          error: [...rendered.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map(
            (m) =>
              m[1].replace(/<[^>]+>/g, '').replaceAll(acceptedKey, '[masked]'),
          ),
          logs: hub.logs.slice(-2),
        }),
      );
      assert.ok(!rendered.includes(acceptedKey));
    };
    const test = async (phrase) => {
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
    await test('机器人已用指定模型收到回复');
    acceptedKey = 'synthetic-model-key-B';
    await test('模型端点拒绝凭据');
    await setup({ model: 'missing-model' });
    await test('模型 ID 不可用');
    const closed = createServer();
    await new Promise((done) => closed.listen(0, '127.0.0.1', done));
    const closedPort = closed.address().port;
    await new Promise((done) => closed.close(done));
    await setup({ endpoint: 'http://127.0.0.1:' + closedPort });
    await test('模型端点未能建立连接或响应超时');
    await setup();
    await test('机器人已用指定模型收到回复');
  } finally {
    await admin.dispose();
  }

  const inputFile = join(scratch, 'fixture.txt'),
    outputFile = join(scratch, 'downloaded.txt');
  await writeFile(inputFile, 'synthetic private attachment');
  const data = join(scratch, 'desktop');
  await mkdir(data);
  const require = createRequire(import.meta.url);
  const packaged = process.argv[3] === 'packaged';
  const bundle = join(desktop, 'out/Circle-darwin-arm64/Circle.app');
  const env = {
    ...process.env,
    HOME: scratch,
    CIRCLE_HOME: join(scratch, 'circle'),
    CIRCLE_WORKBENCH_DATA_DIR: data,
    CIRCLE_WORKBENCH_MODE: 'live',
    CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
    CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
      files: [inputFile],
      exportPath: outputFile,
    }),
    CIRCLE_WORKBENCH_BACKGROUND_TEST: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath: packaged
      ? join(bundle, 'Contents/MacOS/Circle')
      : require('electron'),
    args: packaged ? [] : [desktop],
    cwd: desktop,
    env,
    timeout: 45000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForFunction(
    () =>
      location.hash.startsWith('#/session/') ||
      location.hash.startsWith('#/home'),
  );
  await page.evaluate(() => {
    location.hash = '/page/extensions?plugin=hub';
  });
  const card = page.locator('#hub-connection');
  await card.getByRole('checkbox', { name: 'enable Hub', exact: true }).check();
  await card
    .getByRole('textbox', { name: 'hub IP address', exact: true })
    .fill(hub.url);
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
  await waitFor(
    async () =>
      page.evaluate(async () =>
        (await window.circleDesktop.runtimeState()).snapshot.mcp.some(
          (r) => r.name === 'Hub' && r.status === 'connected',
        ),
      ),
    'Hub authorization',
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
  await input.fill(afterExit);
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await waitFor(
    () => issued.some((call) => call.messages.at(-1)?.content === afterExit),
    'host accepted turn',
  );
  await app.close();
  app = undefined;
  page = undefined;
  held.resolve();
  const application = async (op) =>
    (
      await fetch(hub.url + '/api/bot/v1', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + member.token,
          'circle-version': VERSION,
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
  assert.ok(!JSON.stringify(issued).includes(key));
  assert.ok(!hub.logs.join('').includes(key));
  assert.ok(
    !(
      await readFile(join(data, 'runtime-home', 'settings.json'), 'utf8')
    ).includes(key),
  );
  console.log(
    (packaged ? 'Packaged' : 'Development') +
      ' Mac: first OAuth sign-in, private chat, scripted remote reply, reconnect, attachment round trip and completion after app exit passed.',
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
        }))
        .catch(() => null),
    );
  throw error;
} finally {
  held.resolve();
  await web?.dispose();
  await app?.close();
  host.kill('SIGTERM');
  await exited;
  await new Promise((ok) => model.close(ok));
  await hub.close();
  await postgres.stop();
  await rm(scratch, { recursive: true, force: true });
}
