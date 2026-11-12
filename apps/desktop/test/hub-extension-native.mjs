// Native check of the Hub extension: it ships off and with no address; switched on, its page takes a Hub's address,
// the Hub's sign-in page opens with the code, the card shows the code, and once a person approves on the Hub the card
// says connected; disconnecting revokes the sign-in and removes the entry. Isolated data folder, scripted model and a
// loopback authorization server that offers the device code; no real data, model or network.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { defaultSettings, saveSettings } from '../../../src/settings.ts';
import { AuthorizedServer } from '../../../tests/fixtures/knowledge-sync/authorized-server.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/hub-extension');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-native-hub-'));
const data = join(temp, 'data');
const home = join(data, 'runtime-home');
await mkdir(home, { recursive: true });
const fixturePath = join(temp, 'model.json');
// The scripted model needs a reply to start with; nothing here asks it.
await writeFile(
  fixturePath,
  JSON.stringify({
    requestsPath: join(temp, 'model-requests.jsonl'),
    replies: [{ message: { id: 'idle', role: 'assistant', content: 'idle' } }],
  }),
);
const peer = new AuthorizedServer(join(temp, 'peer'));
peer.device = true;
await peer.start();
saveSettings(defaultSettings(), home);
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
const hub = async () => (await state()).mcp.find((row) => row.name === 'Hub');
const saved = async () =>
  JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
async function waitFor(check, what) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const route = async (path) => {
  await page.evaluate((value) => {
    location.hash = value;
  }, path);
  await page.waitForURL((url) => url.hash === '#' + path);
};
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

  await route('/page/extensions?plugin=hub');
  const card = page.locator('#hub-connection');
  await card.getByRole('heading', { name: 'Hub connection' }).waitFor();
  const toggle = card.getByRole('checkbox', {
    name: 'enable Hub',
    exact: true,
  });
  assert.equal(await toggle.isChecked(), false, 'the extension ships off');
  assert.equal(await card.getByRole('textbox').count(), 0);
  assert.equal((await saved()).mcp_servers.length, 0, 'no address is built in');
  await toggle.check();
  const address = card.getByRole('textbox', {
    name: 'hub address',
    exact: true,
  });
  await address.waitFor();
  assert.equal(await address.inputValue(), '');
  checks.push(
    'the Hub extension ships off, and on asks for an address with none built in',
  );

  await address.fill(peer.origin);
  await card.getByRole('button', { name: 'connect', exact: true }).click();
  await waitFor(
    async () => (await hub())?.signIn?.code === 'BCDF-GHJK',
    'the Hub entry waiting with its code',
  );
  assert.deepEqual((await saved()).mcp_servers, [
    {
      name: 'Hub',
      url: peer.origin + '/mcp',
      transport: 'streamable_http',
      enabled: true,
      placeholders: { url: 'HUB_URL', token: 'HUB_TOKEN' },
    },
  ]);
  // The Hub's page for the code opened beside the conversation
  const sessionId = (await state()).activeSessionId;
  await waitFor(async () => {
    const browser = await page.evaluate(
      (id) => window.circleDesktop.browserState(id),
      sessionId,
    );
    return String(browser.url).startsWith(peer.origin + '/device');
  }, 'the Hub page opened in the browser panel');
  await route('/page/extensions?plugin=hub');
  await card.getByText('BCDF-GHJK', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'copy code', exact: true }).waitFor();
  checks.push(
    'connecting opens the Hub page and the card shows the code to enter',
  );

  peer.deviceApproved = true;
  await waitFor(
    async () => (await hub())?.status === 'connected',
    'the Hub connected',
  );
  await card.getByText('connected', { exact: true }).waitFor();
  assert.equal(await card.getByText('BCDF-GHJK', { exact: true }).count(), 0);
  checks.push('once approved on the Hub the card says connected');

  await card.getByRole('button', { name: 'disconnect', exact: true }).click();
  await waitFor(async () => !(await hub()), 'the Hub entry removed');
  assert.equal((await saved()).mcp_servers.length, 0);
  assert.ok(peer.revocations.length >= 1, 'the sign-in was revoked at the Hub');
  await address.waitFor();
  checks.push(
    'disconnecting revokes the sign-in and asks for an address again',
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(output, 'hub-extension.png') });
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks: checks.length, output }, null, 2));
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
    await writeFile(
      join(output, 'failure.json'),
      JSON.stringify(
        {
          hub: await hub().catch(() => undefined),
          requests: peer.requests.map((request) => request.path),
          errors,
        },
        null,
        2,
      ),
    ).catch(() => {});
  }
  throw error;
} finally {
  if (app) await app.close();
  await peer.close();
  await rm(temp, { recursive: true, force: true });
}
