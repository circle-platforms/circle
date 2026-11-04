// Sign in with ChatGPT through the native connection form, restricted bridge and worker,
// against a local stand-in for OpenAI. The test plays the system browser: the form's
// address is followed to the loopback callback, as a browser on this machine would.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { patience } from './helpers/patience.mjs';
import { openai } from '../../../tests/chatgpt-fixture.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-chatgpt-native-'));
const output = resolve(
  root,
  '../../outputs/chatgpt-signin',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
const dataDir = join(temp, 'data');
const home = join(dataDir, 'runtime-home');
await mkdir(join(home, 'cache'), { recursive: true });
await writeFile(
  join(home, 'cache', 'models-dev.json'),
  JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
);
const closers = [];
const gateway = await openai({ after: (fn) => closers.push(fn) });
const errors = [];
const checks = [];
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: dataDir,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_CHATGPT_ISSUER: gateway.base,
  CIRCLE_CHATGPT_API_URL: gateway.base + '/v1',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CIRCLE_DESKTOP_RUNTIME_FIXTURE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';
let application;
try {
  application = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 45000,
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(patience(12000));
  page.on('pageerror', (error) => errors.push(String(error)));
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.frontendOnly, false);
  const state = () =>
    page.evaluate(
      async () => (await window.circleDesktop.runtimeState()).snapshot,
    );
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
  await page.getByRole('textbox', { name: 'base url', exact: true }).waitFor();
  await page
    .getByRole('combobox', { name: 'provider', exact: true })
    .selectOption('chatgpt');
  // No URL or key: the plan signs in.
  assert.equal(
    await page.getByRole('textbox', { name: 'api key', exact: true }).count(),
    0,
  );
  await page
    .getByRole('button', { name: 'Continue with ChatGPT', exact: true })
    .click();
  const address = page.locator('.sign-in-address');
  await address.waitFor();
  const url = await address.innerText();
  assert.match(
    url,
    /\/api\/accounts\/authorize\?client_id=dynamic_agent_client/,
  );
  // The long address stays inside the dialog, and nothing reported a failure to open it.
  const fits = await address.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const dialog = element.closest('[role="dialog"]').getBoundingClientRect();
    return (
      box.right <= dialog.right && element.scrollWidth <= element.clientWidth
    );
  });
  assert.ok(fits, 'the sign-in address fits the dialog');
  assert.equal(await page.getByText(/external links require/).count(), 0);
  for (const theme of ['dark', 'light']) {
    await command('save-settings', { settings: { theme } });
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    await page.screenshot({ path: join(output, `waiting-${theme}.png`) });
  }
  // The browser signs in and returns to the loopback address.
  await gateway.browser(url);
  await page
    .getByText('discovered 1 model (chatgpt)', { exact: true })
    .waitFor();
  await page.getByRole('option', { name: 'gpt-6.1-sol', exact: true }).click();
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  // The first sign-in confirms plan use once.
  await page
    .getByRole('heading', { name: "You're using your ChatGPT plan" })
    .waitFor();
  await page.screenshot({ path: join(output, 'welcome.png') });
  await page.getByRole('button', { name: 'Got it', exact: true }).click();
  checks.push(
    'the native form signs in with ChatGPT through the system-browser flow, lists the account model and confirms plan use',
  );
  const saved = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  assert.equal(saved.auth.protocol, 'chatgpt');
  assert.equal(saved.auth.model, 'gpt-6.1-sol');
  assert.equal(saved.auth.base_url, gateway.base + '/v1');
  assert.equal(existsSync(join(home, 'credentials.json')), false);
  // The ChatGPT host ID of a test profile stays in its data folder.
  assert.ok(existsSync(join(dataDir, 'agent-host-id')));
  await page.getByText('Using ChatGPT plan', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'plan-in-use.png') });
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('hello over the plan');
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await page.getByText('hello', { exact: true }).first().waitFor();
  const request = gateway.seen.find(
    (item) =>
      item.path === '/v1/responses' &&
      JSON.stringify(item.json?.input ?? '').includes('hello over the plan'),
  );
  assert.ok(request, 'the turn reached the plan route');
  assert.equal(request.headers.authorization, 'Bearer access-1');
  assert.equal(request.headers['content-encoding'], 'zstd');
  checks.push(
    'the turn goes to the plan Responses route with the access token, compressed, and no key is saved',
  );
  const snapshot = await state();
  assert.doesNotMatch(JSON.stringify(snapshot), /access-\d|refresh-\d/);
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      { checks, packaged: info.packaged, pageErrors: errors },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ checks: checks.length, packaged: info.packaged, output }),
  );
} finally {
  await application?.close();
  for (const close of closers) await close();
  await rm(temp, { recursive: true, force: true });
}
