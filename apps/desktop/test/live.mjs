import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';
import {
  assertViewport,
  readViewport,
  setViewport,
} from './helpers/viewport.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/live');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-native-live-'));
const fixturePath = join(temp, 'model.json');
const requestsPath = join(temp, 'requests.jsonl');
const exportPath = join(temp, 'export.jsonl');
const defaultTarget = join(temp, 'default-target');
await mkdir(defaultTarget);
const appPath = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root);
const fixture = {
  requestsPath,
  replies: [
    {
      message: {
        id: 'call-write',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'write-native',
            name: 'write_file',
            args: {
              file_path: 'native.txt',
              content: 'native runtime bytes\n',
            },
          },
        ],
      },
    },
    {
      chunks: ['native ', 'answer ', 'completed'],
      delayMs: 60,
      message: {
        id: 'answer-native',
        role: 'assistant',
        content: 'native answer completed',
      },
    },
    {
      message: {
        id: 'call-question',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'question-native',
            name: 'question',
            args: {
              questions: [
                { question: 'Choose a target', options: ['local', 'staging'] },
              ],
            },
          },
        ],
      },
    },
    {
      message: {
        id: 'answer-question',
        role: 'assistant',
        content: 'staging target received',
      },
    },
    { waitForAbort: true },
  ],
};
await writeFile(fixturePath, JSON.stringify(fixture));
const env = {
  ...process.env,
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
    exportPath,
    workspace: defaultTarget,
  }),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';
const checks = [];
const errors = [];
let app;
let page;
let gateway;
let viewportSizing;
const state = () =>
  page
    .evaluate(() => window.circleDesktop.runtimeState())
    .then((update) => update.snapshot);
const command = (name, payload = {}, sessionId) =>
  page.evaluate(
    async ({ name, payload, sessionId }) => {
      const current = await window.circleDesktop.runtimeState();
      return window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        name,
        payload,
        sessionId: sessionId ?? current.snapshot.activeSessionId,
      });
    },
    { name, payload, sessionId },
  );
async function waitFor(check, name, milliseconds = 12_000) {
  const deadline = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(`timed out: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function send(value) {
  await page.getByRole('textbox', { name: 'message', exact: true }).fill(value);
  await page.getByRole('button', { name: 'send message', exact: true }).click();
}
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [appPath],
    cwd: root,
    env,
    timeout: 45_000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  if (process.env.CIRCLE_DESKTOP_TEST_WIDTH) {
    viewportSizing = await setViewport(
      app,
      page,
      { width: Number(process.env.CIRCLE_DESKTOP_TEST_WIDTH), height: 768 },
      { show: true },
    );
  }
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.frontendOnly, false);
  assert.equal(info.name, 'Circle');
  assert.equal(await page.title(), 'Circle');
  assert.equal(await page.locator('.brand').innerText(), 'circle');
  for (const name of ['knowledge', 'work', 'execution', 'methods'])
    assert.equal(
      await page.getByRole('link', { name, exact: true }).count(),
      0,
    );
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem('circle.workbench.platform-preview.v1'),
    ),
    null,
  );
  assert.equal(info.runtimeConnected, true);
  const initial = await state();
  assert.equal(initial.sessions.length, 1);
  assert.equal(initial.sessions[0].messages.length, 0);
  checks.push(
    'native app starts its bundled Circle core with an empty isolated workspace',
  );
  const sessionId = initial.activeSessionId;
  const workspace = initial.workspaces.find(
    (row) => row.id === initial.sessions[0].workspaceId,
  ).path;
  await send('write native file');
  await waitFor(
    async () =>
      (await state()).interactions.some((row) => row.status === 'pending'),
    'approval',
  );
  assert.equal(existsSync(join(workspace, 'native.txt')), false);
  checks.push(
    'frontend prompt reaches core but actual write waits for approval',
  );
  // The request waits in the conversation, under the call, with the change it makes.
  const request = page.locator('.inline-request');
  await request.waitFor();
  assert.match(await request.locator('.diff-block').innerText(), /new file/);
  checks.push('approval shows inline in the conversation with its diff');
  await request
    .getByRole('button', { name: 'allow once', exact: true })
    .click();
  await page.getByText('native answer completed', { exact: true }).waitFor();
  if (
    process.env.CIRCLE_DESKTOP_TEST_WIDTH &&
    Number(process.env.CIRCLE_DESKTOP_TEST_WIDTH) <= 1050
  ) {
    assertViewport(
      await readViewport(page),
      viewportSizing.target,
      viewportSizing.scaleFactor,
    );
    await page
      .getByRole('dialog', { name: 'inspector', exact: true })
      .waitFor({ state: 'hidden', timeout: 1500 });
  }
  assert.equal(
    await readFile(join(workspace, 'native.txt'), 'utf8'),
    'native runtime bytes\n',
  );
  const requests = (await readFile(requestsPath, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert(
    requests[1].messages.some(
      (row) => row.role === 'tool' && row.content.includes('native.txt'),
    ),
  );
  checks.push(
    'native approval releases the real tool and its result reaches the next model request',
  );
  await send('choose target');
  await waitFor(
    async () =>
      (await state()).interactions.some(
        (row) => row.kind === 'question' && row.status === 'pending',
      ),
    'question',
  );
  // The question waits in the conversation too, and is answered there.
  const question = page
    .locator('.inline-request')
    .filter({ hasText: 'Choose a target' });
  await question.getByRole('radio', { name: 'staging' }).check();
  await question
    .getByRole('button', { name: 'send answer', exact: true })
    .click();
  await page.getByText('staging target received', { exact: true }).waitFor();
  const afterQuestion = (await readFile(requestsPath, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert(
    afterQuestion[3].messages.some(
      (row) => row.role === 'tool' && row.content.includes('staging'),
    ),
  );
  checks.push('native question answer resumes the same core turn');
  await page.reload();
  await page.getByText('staging target received', { exact: true }).waitFor();
  assert.equal((await state()).activeSessionId, sessionId);
  checks.push(
    'renderer reload resynchronizes without replacing the runtime or session',
  );
  await send('please wait');
  await waitFor(
    async () =>
      (await state()).sessions.find((s) => s.id === sessionId).state ===
      'waiting',
    'model waiting',
  );
  await page
    .getByRole('button', { name: 'pause conversation', exact: true })
    .click();
  await waitFor(
    async () =>
      (await state()).sessions.find((s) => s.id === sessionId).state === 'idle',
    'cancel',
  );
  checks.push('native stop awaits the actual model abort');
  await page
    .getByRole('button', { name: 'new session', exact: true })
    .first()
    .click();
  await waitFor(
    async () => (await state()).activeSessionId !== sessionId,
    'new session',
  );
  const created = (await state()).activeSessionId;
  assert.notEqual(created, sessionId);
  assert.equal((await command('select-session', { id: sessionId })).ok, true);
  await page.getByText('native answer completed', { exact: true }).waitFor();
  const exported = await command('export');
  assert.equal(exported.ok, true);
  assert(exported.data.content.includes('circle-session'));
  assert.equal(
    (await command('import', { content: exported.data.content })).ok,
    true,
  );
  const imported = (await state()).activeSessionId;
  assert.notEqual(imported, sessionId);
  checks.push(
    'native session create/select and checksum-bearing graph export/import use the core store',
  );
  if (process.platform !== 'win32') {
    const marker = join(workspace, 'shell.pid');
    const running = command('shell', {
      command: `echo $$ > '${marker.replaceAll("'", "'\\''")}' ; /bin/sleep 90`,
    });
    await waitFor(() => existsSync(marker), 'actual shell pid');
    const pid = Number(await readFile(marker, 'utf8'));
    assert(Number.isSafeInteger(pid) && pid > 1);
    process.kill(pid, 0);
    assert.equal((await command('abort')).ok, true);
    await running;
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 'actual shell exit');
    checks.push(
      'native cancellation stops the actual shell process, not only its displayed row',
    );
  }
  await page.screenshot({ path: join(output, 'live-native.png') });
  assert.deepEqual(errors, []);
  const firstSource = await sourceEvidence(root);
  const renderer = await rendererEvidence(root);
  await app.close();
  app = undefined;
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [appPath],
    cwd: root,
    env,
    timeout: 45_000,
  });
  page = await app.firstWindow();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const restored = await state();
  assert.equal(restored.activeSessionId, imported);
  assert(
    restored.sessions
      .find((s) => s.id === imported)
      .messages.some((m) => m.text === 'native answer completed'),
  );
  assert.equal(restored.sessions.find((s) => s.id === imported).auto, false);
  checks.push(
    'application restart restores the persisted native checkpoint graph and resets auto mode',
  );
  await app.close();
  app = undefined;
  const gatewayRequests = [];
  const modelListKeys = [];
  let modelListDown = false;
  gateway = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      modelListKeys.push(req.headers.authorization);
      if (modelListDown) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'native-fixture-model' }] }));
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    gatewayRequests.push(data);
    assert.equal(req.headers.authorization, 'Bearer native-local-key');
    const last = data.messages.at(-1);
    const said = Array.isArray(last.content)
      ? last.content.find((part) => part.type === 'text')?.text
      : last.content;
    if (said === 'refuse this') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: 'bad request from fixture' } }),
      );
      return;
    }
    if (said === 'stream a long answer') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let line = 1; line <= 60; line++) {
        res.write(
          `data: ${JSON.stringify({ id: 'native-gateway', object: 'chat.completion.chunk', model: data.model, choices: [{ index: 0, delta: { content: `line ${line}\n\n` }, finish_reason: null }] })}\n\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      res.write(
        `data: ${JSON.stringify({ id: 'native-gateway', object: 'chat.completion.chunk', model: data.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'native-gateway', object: 'chat.completion.chunk', model: data.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'native gateway response' }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'native-gateway', object: 'chat.completion.chunk', model: data.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayEnv = {
    ...env,
    CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'gateway-data'),
  };
  delete gatewayEnv.CIRCLE_DESKTOP_RUNTIME_FIXTURE;
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [appPath],
    cwd: root,
    env: gatewayEnv,
    timeout: 45_000,
  });
  page = await app.firstWindow();
  // Nothing is set up yet, so the connection form opens by itself.
  await page.getByRole('textbox', { name: 'base url', exact: true }).waitFor();
  assert.equal((await state()).runtime.configured, false);
  checks.push('a first start without a model opens the connection form');
  await page
    .getByRole('textbox', { name: 'base url', exact: true })
    .fill(`http://127.0.0.1:${gateway.address().port}/v1`);
  // Nothing saved: the key is required
  assert.equal(
    await page
      .getByRole('textbox', { name: 'api key', exact: true })
      .getAttribute('placeholder'),
    'required',
  );
  await page
    .getByRole('textbox', { name: 'api key', exact: true })
    .fill('native-local-key');
  // First the URL and the key; the endpoint is asked for its models, as setup does
  await page.getByRole('button', { name: 'next', exact: true }).click();
  await page
    .getByRole('option', { name: 'native-fixture-model', exact: true })
    .waitFor();
  await page
    .getByText('discovered 1 model (openai)', { exact: true })
    .waitFor();
  assert.deepEqual(modelListKeys, ['Bearer native-local-key']);
  assert.equal((await state()).runtime.configured, false);
  await page
    .getByRole('option', { name: 'native-fixture-model', exact: true })
    .click();
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await waitFor(
    async () => (await state()).runtime.configured,
    'saved connection',
  );
  assert.equal(
    (await state()).settings.endpoint,
    `http://127.0.0.1:${gateway.address().port}/v1`,
  );
  checks.push(
    'the connection form asks for the URL and key, lists the models the endpoint answered with, and saves the chosen one',
  );
  // Again: the saved key is kept only while the URL stays on the saved endpoint's host
  await send('/login');
  const keyBox = page.getByRole('textbox', { name: 'api key', exact: true });
  await keyBox.waitFor();
  assert.equal(
    await keyBox.getAttribute('placeholder'),
    'leave empty to keep the saved key',
  );
  await page
    .getByRole('textbox', { name: 'base url', exact: true })
    .fill('https://another-provider.example/v1');
  assert.equal(await keyBox.getAttribute('placeholder'), 'required');
  assert.equal(await keyBox.evaluate((input) => input.required), true);
  await page.getByRole('button', { name: 'cancel', exact: true }).click();
  await keyBox.waitFor({ state: 'detached' });
  checks.push(
    'an empty key keeps the saved one only for the saved host; another host needs its key',
  );
  // An endpoint that stops listing its models: refresh says so instead of failing
  modelListDown = true;
  await page.evaluate(() => {
    location.hash = '/page/models';
  });
  await page
    .getByRole('button', { name: 'refresh models', exact: true })
    .click();
  await page
    .getByText(
      'The endpoint did not list its models (http 404). Search for the model id below and use it.',
      { exact: true },
    )
    .waitFor();
  assert.equal(modelListKeys.at(-1), 'Bearer native-local-key');
  assert.equal((await state()).runtime.error, undefined);
  assert(
    (await state()).models.some((model) => model.id === 'native-fixture-model'),
  );
  modelListDown = false;
  await page.evaluate(
    (id) => {
      location.hash = '/session/' + id;
    },
    (await state()).activeSessionId,
  );
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  checks.push(
    'refreshing models from an endpoint that does not list them explains it and keeps the list',
  );
  assert.equal(
    await page.evaluate(() =>
      Object.values(localStorage).join('').includes('native-local-key'),
    ),
    false,
  );
  checks.push(
    'clean first launch supports native login and excludes the API key from frontend storage',
  );
  await send('/effort high');
  await waitFor(
    async () => (await state()).sessions[0].effort === 'high',
    'effort',
  );
  await send('call the local gateway');
  await page.getByText('native gateway response', { exact: true }).waitFor();
  assert.equal(gatewayRequests.length, 1);
  assert.equal(gatewayRequests[0].model, 'native-fixture-model');
  assert.equal(gatewayRequests[0].reasoning_effort, 'high');
  checks.push(
    'normal native GatewayModel sends a real request to the isolated HTTP fixture with selected model and effort',
  );
  // Times read as the local clock once the reply is stored; the usage row has no empty part
  await waitFor(
    async () =>
      (await state()).sessions[0].state === 'idle' &&
      (await page.locator('article.message time').last().innerText()) !==
        'streaming',
    'stored answer',
  );
  const stamp = page.locator('article.message time').last();
  assert.match(await stamp.innerText(), /^\d{2}:\d{2}$/);
  assert.ok(await stamp.getAttribute('title'));
  // The turn's last answer shows the whole turn: its time, then its tokens
  const usage = await page.locator('article.message footer').last().innerText();
  assert.match(usage, /^\d+s · ↑ \d+ · ↓ \d+ · /);
  checks.push(
    'message times show as the local clock, and the turn line under the last answer gives its time and tokens with no empty part',
  );
  // A picture pasted in the box goes to the model as an image
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    document.querySelector('textarea[aria-label="message"]').dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
  await page.getByText('pasted image 1.png').waitFor();
  await send('what is in the picture');
  await page.getByText('native gateway response').nth(1).waitFor();
  const pictured = gatewayRequests.at(-1).messages.at(-1);
  assert(Array.isArray(pictured.content));
  assert(
    pictured.content.some(
      (part) =>
        part.type === 'image_url' &&
        part.image_url.url.startsWith('data:image/png;base64,'),
    ),
  );
  checks.push('a pasted picture reaches the next model request as an image');
  // A screenshot-sized picture of several megabytes goes too, scaled down by the core
  const pastedBytes = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(2000, 1500);
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(2000, 1500);
    // xorshift noise, which PNG cannot compress
    let seed = 2463534242;
    for (let at = 0; at < pixels.data.length; at++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels.data[at] = at % 4 === 3 ? 255 : seed & 255;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'screen.png', { type: 'image/png' }));
    document.querySelector('textarea[aria-label="message"]').dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
    return blob.size;
  });
  assert.ok(pastedBytes > 5_000_000, `pasted ${pastedBytes} bytes`);
  await page.getByText('screen.png', { exact: true }).waitFor();
  const before = gatewayRequests.length;
  await send('and this screenshot');
  await waitFor(
    async () =>
      gatewayRequests.length > before &&
      (await state()).sessions[0].state === 'idle',
    'large picture sent',
  );
  const large = gatewayRequests.at(-1).messages.at(-1);
  const largeText = large.content.find((part) => part.type === 'text').text;
  assert.match(
    largeText,
    /\[Scaled down to send: screen\.png 2000×1500, sent as \d+×\d+\]$/,
  );
  assert(large.content.some((part) => part.type === 'image_url'));
  checks.push(
    'a pasted picture of several megabytes is sent, scaled down by the core with both sizes named',
  );
  // A long answer is followed while it streams; scrolled up, the view stays put
  const fromEnd = () =>
    page.evaluate(() => {
      const box = document.querySelector('.transcript');
      return box.scrollHeight - box.scrollTop - box.clientHeight;
    });
  await send('stream a long answer');
  await page.getByText('line 20', { exact: true }).waitFor();
  await waitFor(async () => (await fromEnd()) < 48, 'follows while streaming');
  assert.equal(
    await page.getByText('line 60', { exact: true }).count(),
    0,
    'still streaming',
  );
  // Scrolled up as by hand, with the scroll event a window in the background may get late
  await page.evaluate(() => {
    const box = document.querySelector('.transcript');
    box.scrollTo({ top: 0, behavior: 'instant' });
    box.dispatchEvent(new Event('scroll'));
  });
  await page.getByText('line 40', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => document.querySelector('.transcript').scrollTop),
    0,
  );
  await page.evaluate(() => {
    const box = document.querySelector('.transcript');
    box.scrollTo({ top: box.scrollHeight, behavior: 'instant' });
    box.dispatchEvent(new Event('scroll'));
  });
  await page.getByText('line 60', { exact: true }).waitFor();
  await waitFor(
    async () => (await state()).sessions[0].state === 'idle',
    'long answer',
  );
  await waitFor(async () => (await fromEnd()) < 48, 'follows the end again');
  checks.push('the conversation follows a streaming answer unless scrolled up');
  // A request the endpoint refuses stays in the conversation
  await send('refuse this');
  await page.locator('.transcript-notice').filter({ hasText: '✖' }).waitFor();
  assert.match(
    await page.locator('.transcript-notice').last().innerText(),
    /400/,
  );
  checks.push('a failed turn leaves its error in the conversation');
  // The default workspace moves only through the settings page and the native
  // dialog's grant, never through a renderer-supplied path.
  const gatewayHome = join(temp, 'gateway-data', 'runtime-home');
  const scratch = join(gatewayHome, 'workspace');
  assert.equal((await state()).settings.workspaceFolder, scratch);
  assert.equal((await state()).settings.oldWorkspaceFolder, undefined);
  await assert.rejects(
    command('set-default-workspace', { path: defaultTarget }),
    /not selected through the native dialog/,
  );
  await assert.rejects(
    command('set-default-workspace', { workspaceGrant: 'forged' }),
    /not selected through the native dialog/,
  );
  assert.equal((await state()).settings.workspaceFolder, scratch);
  // Files from the run stay behind: the settings page names the folder to delete.
  await writeFile(join(scratch, 'leftover.txt'), 'earlier work');
  await page.evaluate(() => {
    location.hash = '/page/settings';
  });
  await page.waitForURL((url) => url.hash === '#/page/settings');
  await page
    .getByRole('heading', { name: 'default workspace', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'change…', exact: true }).click();
  // The move crosses three processes, and perform() shows a failure only as a
  // toast for four seconds: collect them so a timeout says what the app saw.
  const toasts = new Set();
  try {
    await waitFor(
      async () => {
        for (const text of await page.locator('.toast').allInnerTexts())
          toasts.add(text);
        return (
          (await state()).settings.workspaceFolder ===
          realpathSync(defaultTarget)
        );
      },
      'the moved default workspace',
      30_000,
    );
  } catch (error) {
    const current = await state();
    throw Error(
      `${error.message}: workspaceFolder stayed ${current.settings.workspaceFolder}, toasts: ${[...toasts].join(' | ') || 'none'}`,
    );
  }
  const moved = await state();
  assert.equal(moved.settings.oldWorkspaceFolder, scratch);
  assert.equal(
    moved.workspaces.find((row) => row.path === realpathSync(defaultTarget))
      .trusted,
    false,
  );
  await page
    .getByText('keeps its sessions until you delete it by hand')
    .waitFor();
  assert.equal(
    JSON.parse(await readFile(join(gatewayHome, 'settings.json'), 'utf8'))
      .workspace_folder,
    realpathSync(defaultTarget),
  );
  checks.push(
    'the default workspace moves through the settings page and the native dialog grant, keeps the old folder and needs trust',
  );
  await writeFile(
    join(
      output,
      process.env.CIRCLE_DESKTOP_EXECUTABLE
        ? 'packaged-receipt.json'
        : 'development-receipt.json',
    ),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode: 'live',
        packaged: info.packaged,
        appPath,
        viewportSizing,
        dataIsolation: true,
        scriptedModel: true,
        externalNodeRequired: false,
        source: firstSource,
        renderer,
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { checks: checks.length, packaged: info.packaged, output },
      null,
      2,
    ),
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
