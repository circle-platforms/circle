import { cleanupNativeTest } from './helpers/native-failure.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { captureFailure } from './helpers/diagnostics.mjs';
import { answerTitle, isTitleRequest } from './helpers/title-requests.mjs';
import { patience } from './helpers/patience.mjs';
import { listenForBrowser } from '../../../tests/browser-port.mjs';

// The person points at an element of the page in the browser panel, the element reaches
// the message box, and a scripted model acts on the ref the page itself gave it. A local
// gateway answers; no real model is called.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-pick-live-'));
const output = join(root, 'artifacts/browser-pick-live');
await mkdir(output, { recursive: true });

const requests = [];
let effects = 0;
let step = 0;
let url;
// The ref the page gave the element the person pointed at, read from their own message.
let pickedRef = '';
const server = createServer(async (req, res) => {
  if (req.url === '/effect') {
    effects++;
    res.end('yes');
    return;
  }
  if (req.url === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>Pick fixture</title><button id="apply" style="margin:100px;width:220px;height:60px">Apply changes</button><script>document.querySelector("#apply").addEventListener("click",()=>fetch("/effect"));</script>',
    );
    return;
  }
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'pick-fixture' }] }));
    return;
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  if (isTitleRequest(request)) {
    answerTitle(res, request);
    return;
  }
  requests.push(request);
  const text = (message) =>
    typeof message?.content === 'string'
      ? message.content
      : (message?.content ?? []).map((part) => part.text ?? '').join('');
  const tool = (id, name, args) => ({
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  let delta;
  let finish = 'tool_calls';
  if (step === 0)
    delta = tool('open', 'browser_navigate', { url: url + 'page' });
  else if (step === 1) {
    delta = { role: 'assistant', content: 'pick fixture page open' };
    finish = 'stop';
  } else if (step === 2) {
    // What the person pointed at arrives in their own message: the page's own ref.
    const last = request.messages.findLast(
      (message) => message.role === 'user',
    );
    const words = text(last);
    assert.match(
      words,
      /circle\.browser-element/,
      'the picked element reaches the model request',
    );
    assert.match(
      words,
      /element: \[e\d+\] button "Apply changes"/,
      'the model is told which element and its ref: ' + words.slice(0, 400),
    );
    assert.match(
      words,
      /The user pointed at this element in the conversation.s browser/,
    );
    assert.match(words, /tag: <button>/);
    assert.match(words, /point: 218, 138 of \d+ × \d+ CSS pixels/);
    assert.match(words, /"url": "http:\/\/127\.0\.0\.1:\d+\/page"/);
    assert.match(words, /"screenshotId"/);
    assert.ok(
      !words.includes('data:image'),
      'the picture’s bytes do not travel with the element',
    );
    pickedRef = /element: \[(e\d+)\]/.exec(words)?.[1] ?? '';
    assert.ok(pickedRef, 'the message carries a ref the browser can act on');
    delta = tool('act', 'browser_click', {
      ref: pickedRef,
      element: 'Apply changes',
    });
  } else {
    delta = { role: 'assistant', content: 'pick fixture completed' };
    finish = 'stop';
  }
  step++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta) =>
    `data: ${JSON.stringify({ id: 'local-pick-gateway', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  res.write(chunk(delta));
  res.write(
    `data: ${JSON.stringify({ id: 'local-pick-gateway', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
});
await listenForBrowser(server);
url = `http://127.0.0.1:${server.address().port}/`;
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
};
for (const key of Object.keys(env))
  if (
    /^(https?_proxy|all_proxy|node_use_env_proxy|circle_desktop_runtime_fixture)$/i.test(
      key,
    )
  )
    delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
const errors = [];
try {
  app = await electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    chromiumSandbox: true,
    timeout: 45000,
  });
  app.context().on('page', (page) => page.on('dialog', () => {}));
  page = await app.firstWindow();
  page.setDefaultTimeout(patience(20000));
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.setContentSize(1400, 900);
  });
  const endpoint = page.getByRole('textbox', { name: 'base url', exact: true });
  await endpoint.fill(url + 'v1');
  await page
    .getByRole('textbox', { name: 'api key', exact: true })
    .fill('pick-fixture-key');
  await page.getByRole('button', { name: 'next', exact: true }).click();
  await page.getByRole('option', { name: 'pick-fixture', exact: true }).click();
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  const send = async (text) => {
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(text);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
  };
  const state = async () =>
    (await page.evaluate(() => window.circleDesktop.runtimeState())).snapshot;
  // What the person sees in the message box is the chip; what the model gets is the
  // gateway's own copy of their message, checked in the scripted step above.
  const chips = () => page.locator('.attachment-strip .file-chip');
  const chipNames = async () => {
    const found = [];
    const count = await chips().count();
    for (let index = 0; index < count; index++)
      found.push((await chips().nth(index).textContent()).trim());
    return found;
  };
  await send('open the local page');
  await page
    .locator('.inline-request')
    .filter({ hasText: 'browser_navigate' })
    .last()
    .getByRole('button', {
      name: `allow on ${new URL(url).origin} for this session`,
      exact: true,
    })
    .click();
  await page.getByText('pick fixture page open', { exact: true }).waitFor();
  const menu = page.getByRole('button', { name: 'browser menu', exact: true });
  await menu.waitFor();
  // The button's own place in the page, in CSS pixels: 8 + 100 margin, half of 220 × 60.
  const css = { x: 218, y: 138 };
  const openPick = async () => {
    await menu.click();
    await page
      .getByRole('menuitem', { name: 'pick element', exact: true })
      .click();
    const layer = page.getByTestId('browser-pick');
    await layer.waitFor();
    const box = await layer.boundingBox();
    assert(box && box.width > 200 && box.height > 150, 'the picture has room');
    return { box, x: box.x + css.x, y: box.y + css.y };
  };

  const setTheme = async (theme) => {
    const snapshot = await state();
    await page.evaluate(
      async ({ id, theme }) => {
        await window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name: 'save-settings',
          sessionId: id,
          payload: { settings: { theme } },
        });
      },
      { id: snapshot.activeSessionId, theme },
    );
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
  };
  // Dark: the cursor names what it is over, and the ring sits on the element's own box.
  await setTheme('dark');
  let at = await openPick();
  const label = page.getByTestId('browser-pick-label');
  await pointUntilNamed(
    page.mouse,
    label,
    at.x,
    at.y,
    'button “Apply changes”',
  );
  const ring = await page.getByTestId('browser-pick-box').boundingBox();
  assert(
    ring &&
      Math.abs(ring.x - (at.box.x + 108)) <= 3 &&
      Math.abs(ring.y - (at.box.y + 108)) <= 3 &&
      Math.abs(ring.width - 220) <= 3 &&
      Math.abs(ring.height - 60) <= 3,
    `the ring is the button's own box: ${JSON.stringify(ring)}`,
  );
  assert.deepEqual(
    await chipNames(),
    [],
    'pointing adds nothing until the person clicks',
  );
  await page.screenshot({ path: join(output, 'pick-dark.png') });
  await page.keyboard.press('Escape');
  await page.getByTestId('browser-pick').waitFor({ state: 'hidden' });
  assert.deepEqual(
    await chipNames(),
    [],
    'escape stops pointing without adding anything',
  );
  // Light, and then the click that commits.
  await setTheme('light');
  at = await openPick();
  await pointUntilNamed(
    page.mouse,
    label,
    at.x,
    at.y,
    'button “Apply changes”',
  );
  await page.screenshot({ path: join(output, 'pick-light.png') });
  await page.mouse.click(at.x, at.y);
  await page.getByTestId('browser-pick').waitFor({ state: 'hidden' });
  await chips().first().waitFor();
  assert.deepEqual(
    await chipNames(),
    ['127.0.0.1 · element'],
    'the element the person pointed at is in the message box',
  );
  // The model acts on what the person pointed at, and the page feels it.
  await send('change what I pointed at');
  await page.getByText('pick fixture completed', { exact: true }).waitFor();
  assert.equal(
    effects,
    1,
    'the picked element is the one the real click reached',
  );
  const result = requests
    .at(-1)
    .messages.findLast(
      (message) => message.role === 'tool' && message.tool_call_id === 'act',
    );
  assert.match(
    String(result?.content),
    new RegExp(`Clicked .*Apply changes`),
    'the click names ' +
      pickedRef +
      ': ' +
      String(result?.content).slice(0, 300),
  );
  // The browser in a window of its own reaches the main window's message box through the
  // popout channel — the path a docked panel does not take.
  const chipsBeforeWindow = await chips().count();
  await page
    .locator('.inspector .browser-address')
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  const popped = await (async () => {
    const deadline = Date.now() + patience(20000);
    for (;;) {
      const found = app
        .windows()
        .find((one) => one.url().includes('#/popout/browser/'));
      if (found) return found;
      if (Date.now() > deadline) throw Error('the browser window did not open');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  await popped
    .getByRole('button', { name: 'browser menu', exact: true })
    .click();
  await popped
    .getByRole('menuitem', { name: 'pick element', exact: true })
    .click();
  const poppedLayer = popped.getByTestId('browser-pick');
  await poppedLayer.waitFor();
  const poppedBox = await poppedLayer.boundingBox();
  assert(
    poppedBox && poppedBox.width > 200 && poppedBox.height > 150,
    'the popped picture has room',
  );
  await pointUntilNamed(
    popped.mouse,
    popped.getByTestId('browser-pick-label'),
    poppedBox.x + css.x,
    poppedBox.y + css.y,
    'button “Apply changes”',
  );
  await popped.mouse.click(poppedBox.x + css.x, poppedBox.y + css.y);
  await poppedLayer.waitFor({ state: 'hidden' });
  assert.equal(
    await chips().count(),
    chipsBeforeWindow + 1,
    'the element picked in the window of its own reaches the main message box',
  );
  await popped.getByRole('button', { name: 'put back in the drawer' }).click();
  const popoutGone = async () =>
    app.windows().every((one) => !one.url().includes('#/popout/browser/'));
  const popoutDeadline = Date.now() + patience(20000);
  while (!(await popoutGone())) {
    if (Date.now() > popoutDeadline)
      throw Error('the browser window did not close');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(errors, []);
  const info = await page.evaluate(() => window.circleDesktop.info());
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(
      {
        packaged: info.packaged,
        checks: [
          'a picture of the page replaces it while pointing',
          'the cursor names the element it is over and rings its box',
          'escape leaves the draft untouched',
          'the click puts the page’s own ref in the message box',
          'a scripted model acts on that ref and the page sees the click',
          'dark and light pointing overlay',
          'a popped-out window reaches the main message box',
        ],
        effects,
        pickedRef,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks: 7, packaged: info.packaged, output }));
} catch (error) {
  await captureFailure(page, error, errors, output);
  throw error;
} finally {
  if (
    !(await cleanupNativeTest([
      async () => {
        if (app) await app.close();
      },
      () => server.closeAllConnections(),
      () =>
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
      () => rm(temp, { recursive: true, force: true, maxRetries: 5 }),
    ]))
  )
    process.exitCode = 1;
}
/**
 * Points and re-points until the overlay names `wanted`: the first move may land before
 * the picture's handlers are attached, so a single move is not an answer.
 */
async function pointUntilNamed(mouse, label, x, y, wanted) {
  const deadline = Date.now() + patience(20000);
  for (;;) {
    await mouse.move(x, y);
    await mouse.move(x + 1, y + 1);
    try {
      await expectLabel(label, wanted);
      return;
    } catch {
      if (Date.now() > deadline)
        throw Error(`the overlay never says ${wanted}`);
    }
  }
}
async function expectLabel(locator, wanted) {
  const deadline = Date.now() + patience(20000);
  for (;;) {
    const shown = (await locator.textContent().catch(() => null))?.trim();
    if (shown === wanted) return;
    if (Date.now() > deadline)
      throw Error(`the overlay names ${JSON.stringify(shown)}, not ${wanted}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
