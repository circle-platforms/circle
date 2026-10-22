// Native check of the extension features in the application: a UI plugin paired with a
// runtime extension (the bundled hub), the view that extension publishes, and a
// link an extension opens arriving in the application's own browser panel. Isolated data
// folder, scripted model, a local page; no real data, model or network.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { listenForBrowser } from '../../../tests/browser-port.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/extensions');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-native-extensions-'));
const data = join(temp, 'data');
const fixturePath = join(temp, 'model.json');
const requestsPath = join(temp, 'model-requests.jsonl');
// The scripted model needs a reply to start with; nothing here asks it.
await writeFile(
  fixturePath,
  JSON.stringify({
    requestsPath,
    replies: [{ message: { id: 'idle', role: 'assistant', content: 'idle' } }],
  }),
);
const site = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(
    '<!doctype html><title>extension link fixture</title><h1>opened by an extension</h1>',
  );
});
await listenForBrowser(site);
const siteUrl = `http://127.0.0.1:${site.address().port}/live`;
// A user extension in the runtime's own home whose command opens the local page.
const extension = join(data, 'runtime-home', 'extensions', 'linker');
await mkdir(extension, { recursive: true });
await writeFile(
  join(extension, 'extension.mjs'),
  `export function register(api){api.registerCommand('openlab','open the lab page',async()=>{await api.openUrl(${JSON.stringify(siteUrl)})})}`,
);
const env = {
  ...process.env,
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
  // A scripted model is accepted only in an explicit test profile.
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
};
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
const errors = [];
let app;
let page;
const state = () =>
  page
    .evaluate(() => window.circleDesktop.runtimeState())
    .then((update) => update.snapshot);
const command = (name, payload = {}) =>
  page.evaluate(
    async ({ name, payload }) => {
      const current = await window.circleDesktop.runtimeState();
      return window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        name,
        payload,
        sessionId: current.snapshot.activeSessionId,
      });
    },
    { name, payload },
  );
async function waitFor(check, name) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(`timed out: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const route = async (path) => {
  await page.evaluate((value) => {
    location.hash = value;
  }, path);
  await page.waitForURL((url) => url.hash === '#' + path);
};
const row = async (name) =>
  (await state()).extensions.find((item) => item.name === name);
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 45_000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  // The application-owned scratch workspace is trusted at startup. Neither a
  // prompt, an explicit trust command nor a reload may be needed to discover it.
  await waitFor(
    async () => Boolean(await row('linker')),
    'cold-start extensions loaded',
  );
  assert.equal(existsSync(requestsPath), false);
  const bundled = await row('hub');
  assert.equal(bundled.scope, 'bundled');
  assert.equal(bundled.version, '0.1.0');
  assert.equal(bundled.enabled, false);
  assert.equal(
    await page.getByRole('link', { name: 'hub', exact: true }).count(),
    0,
  );
  checks.push('the bundled hub extension ships off, and its page is hidden');

  await route('/page/extensions');
  await page
    .getByRole('button', { name: 'interface components', exact: true })
    .click();
  const toggle = page.getByRole('checkbox', {
    name: 'enable hub interface',
    exact: true,
  });
  assert.equal(await toggle.isChecked(), false);
  const pairedNotes = page.getByText(
    /paired with runtime extension hub · 0\.1\.0 · runtime extension hub is off/,
  );
  await pairedNotes.first().waitFor();
  // hub and the four platform objects share one runtime extension.
  assert.equal(await pairedNotes.count(), 5);
  // Generic extensions save first and require the existing explicit reload action.
  // GitHub alone supports scoped hot loading; do not confuse a checked preference
  // with an extension that has actually registered.
  await toggle.click();
  await page
    .getByText('extension setting saved; reload required', { exact: true })
    .first()
    .waitFor();
  assert.equal((await row('hub')).enabled, false);
  assert.equal(
    JSON.parse(
      await readFile(join(data, 'runtime-home', 'settings.json'), 'utf8'),
    ).extensions.hub.enabled,
    true,
  );
  await page.getByRole('button', { name: 'reload', exact: true }).click();
  await waitFor(
    async () => (await row('hub'))?.enabled === true,
    'runtime extension on',
  );
  const saved = JSON.parse(
    await readFile(join(data, 'runtime-home', 'settings.json'), 'utf8'),
  );
  assert.equal(saved.extensions['hub'].enabled, true);
  await page.getByRole('link', { name: 'hub', exact: true }).waitFor();
  for (const id of ['knowledge', 'work', 'execution', 'methods']) {
    assert.equal(
      await page
        .getByRole('checkbox', {
          name: `enable ${id} interface`,
          exact: true,
        })
        .isChecked(),
      false,
    );
    assert.equal(
      await page.getByRole('link', { name: id, exact: true }).count(),
      0,
    );
  }
  checks.push(
    'turning the paired interface on turns its runtime extension on, saved, and shows its page',
  );
  checks.push(
    'opening hub does not open knowledge, work, execution or methods',
  );

  await page.getByRole('link', { name: 'hub', exact: true }).click();
  await page.getByRole('heading', { name: 'hub', exact: true }).waitFor();
  await page.getByText('signed out', { exact: true }).waitFor();
  const view = (await row('hub')).view;
  assert.equal(view.signedIn, false);
  assert.deepEqual(view.tasks, []);
  checks.push('the page shows the view the runtime extension published');

  const reply = await command('custom-command', { name: 'openlab' });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const sessionId = (await state()).activeSessionId;
  await waitFor(async () => {
    const browser = await page.evaluate(
      (id) => window.circleDesktop.browserState(id),
      sessionId,
    );
    return !browser.loading && browser.title === 'extension link fixture';
  }, 'browser panel opened the link');
  await page
    .getByRole('button', { name: 'browser menu', exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'browser address', exact: true })
      .inputValue(),
    siteUrl,
  );
  checks.push(
    "a link an extension opens arrives in the application's browser panel",
  );

  await route('/page/extensions');
  await page
    .getByRole('button', { name: 'interface components', exact: true })
    .click();
  await page
    .getByRole('checkbox', {
      name: 'enable hub interface',
      exact: true,
    })
    .click();
  // Disabling this generic extension also becomes effective on explicit reload.
  await page
    .getByText('disabling extension', { exact: true })
    .first()
    .waitFor();
  assert.equal((await row('hub')).enabled, true);
  assert.equal(
    JSON.parse(
      await readFile(join(data, 'runtime-home', 'settings.json'), 'utf8'),
    ).extensions.hub.enabled,
    false,
  );
  await page.getByRole('button', { name: 'reload', exact: true }).click();
  await waitFor(
    async () => (await row('hub'))?.enabled === false,
    'runtime extension off',
  );
  await waitFor(
    async () =>
      (await page.getByRole('link', { name: 'hub', exact: true }).count()) ===
      0,
    'page hidden',
  );
  for (const id of ['knowledge', 'work', 'execution', 'methods'])
    assert.equal(
      await page.getByRole('link', { name: id, exact: true }).count(),
      0,
    );
  checks.push(
    'turning it off turns the runtime extension off and hides the page',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks: checks.length, output }, null, 2));
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections();
  await new Promise((resolve) => site.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
