import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-browser-address-'));
const output = join(
  root,
  'artifacts/browser-address',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
const site = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(
    '<!doctype html><title>Circle address fixture</title><h1>local address fixture</h1>',
  );
});
await new Promise((done) => site.listen(0, '127.0.0.1', done));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'preview',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const cases = [];
const errors = [];
let app;
let page;
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(String(error)));
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.dataPath, env.CIRCLE_WORKBENCH_DATA_DIR);
  assert.equal(info.frontendOnly, true);
  const route = async (path) => {
    await page.evaluate((path) => {
      location.hash = path;
    }, path);
    await page.waitForURL((url) => url.hash === '#' + path);
  };
  for (const theme of ['light', 'dark']) {
    await route('/page/settings');
    await page.getByRole('button', { name: theme, exact: true }).click();
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    await route('/session/session1');
    const panel = page.getByRole('button', {
      name: 'browser panel',
      exact: true,
    });
    await panel.waitFor();
    if ((await panel.getAttribute('aria-pressed')) !== 'true')
      await panel.click();
    const address = page.getByRole('textbox', {
      name: 'browser address',
      exact: true,
    });
    await address.fill(siteUrl);
    await address.press('Enter');
    await page.waitForFunction(async () => {
      const state = await window.circleDesktop.browserState('session1');
      return !state.loading && state.title === 'Circle address fixture';
    });
    for (const target of [
      'file:///circle-invalid-address-fixture.txt',
      'invalid://fixture',
    ]) {
      const rejected = await page.evaluate(async (target) => {
        try {
          await window.circleDesktop.browserNavigate('session1', target);
          return '';
        } catch (error) {
          return error.message;
        }
      }, target);
      assert.equal(
        rejected,
        "Error invoking remote method 'circle:browser-navigate': Error: invalid browser address",
      );
      const toast = page.locator('.toast[role="status"]');
      if (await toast.isVisible()) await toast.waitFor({ state: 'hidden' });
      await address.fill(target);
      await address.press('Enter');
      await toast.waitFor();
      assert.equal(await toast.innerText(), 'invalid address');
      assert.equal(await address.inputValue(), target);
      const state = await page.evaluate(() =>
        window.circleDesktop.browserState('session1'),
      );
      assert.equal(
        state.url,
        siteUrl,
        'invalid input must preserve the actual loaded page',
      );
      assert.equal(state.title, 'Circle address fixture');
      cases.push({
        theme,
        target,
        rejected,
        notification: await toast.innerText(),
        loadedUrl: state.url,
      });
      await page.screenshot({
        path: join(
          output,
          `${theme}-${target.startsWith('file:') ? 'file' : 'scheme'}.png`,
        ),
      });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      { packaged: info.packaged, dataIsolation: true, cases, errors },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      packaged: info.packaged,
      checks: cases.length,
      errors,
      output,
    }),
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections();
  await new Promise((done) => site.close(done));
  await rm(temp, { recursive: true, force: true });
}
