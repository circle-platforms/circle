import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import {
  chooseTerminalMenu,
  openTerminalMode,
} from './helpers/terminal-mode.mjs';

// A terminal tab's right-click menu, its name and the row's order, as a person uses them:
// a name is the tab's own, a name the main process refuses keeps the dialog open with why,
// a drag works both ways and the order is the one the main process keeps for every window,
// and a restart keeps the tab's place and name.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 700 },
  });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(
    `${server.resolvedUrls.local[0]}test/terminal-tab-menu-ui.html`,
  );
  await openTerminalMode(page);
  const names = () =>
    page
      .locator('.term-tab .term-tab-main')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
  const calls = (method) =>
    page.evaluate(
      (method) =>
        window.tabMenuFixture.calls
          .filter((call) => call.method === method)
          .map((call) => call.params),
      method,
    );
  const tab = (name) => page.getByRole('tab', { name, exact: true });
  const until = async (check, what) => {
    const deadline = Date.now() + 5000;
    while (!(await check())) {
      assert(Date.now() < deadline, what);
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  const same = (expected) => async () =>
    JSON.stringify(await names()) === JSON.stringify(expected);
  await until(same(['terminal 1', 'terminal 2', 'terminal 3']), 'three shells');

  // The right-click menu of a shell's tab
  await tab('terminal 2').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await menu.waitFor();
  assert.deepEqual(
    await menu
      .getByRole('menuitem')
      .evaluateAll((items) => items.map((item) => item.textContent.trim())),
    ['rename…', 'close', 'close others', 'close all', 'new terminal'],
  );
  await menu.getByRole('menuitem', { name: 'rename…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'rename terminal' });
  await dialog.waitFor();
  const field = dialog.getByRole('textbox');
  // A tab called by its number starts with an empty name, its number as the hint
  assert.equal(await field.inputValue(), '');
  assert.equal(await field.getAttribute('placeholder'), 'terminal 2');
  await field.fill('build logs');
  await dialog.getByRole('button', { name: 'rename', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(await calls('rename'), [
    { id: 'term-2', label: 'build logs' },
  ]);
  await until(
    same(['terminal 1', 'build logs', 'terminal 3']),
    'the tab has its name',
  );

  // A name the main process refuses: the dialog stays, saying why, and the name stays
  await tab('build logs').click({ button: 'right' });
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'rename…', exact: true })
    .click();
  await dialog.waitFor();
  assert.equal(await field.inputValue(), 'build logs');
  await field.fill('build\tlogs');
  await dialog.getByRole('button', { name: 'rename', exact: true }).click();
  await dialog
    .getByRole('alert')
    .getByText('the terminal name cannot hold tabs or control characters')
    .waitFor();
  await dialog.getByRole('button', { name: 'cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(await names(), ['terminal 1', 'build logs', 'terminal 3']);
  assert.equal(
    await page.locator('.native-terminal-error[role="alert"]').count(),
    0,
    'the refusal does not stay behind the dialog',
  );

  // A drag to the right takes the tab past the one it is dropped on, to the end
  await tab('terminal 1').dragTo(tab('terminal 3'));
  await until(
    same(['build logs', 'terminal 3', 'terminal 1']),
    'the tab went to the end',
  );
  assert.deepEqual((await calls('arrange')).at(-1), [
    'local:term-2',
    'local:term-3',
    'local:term-1',
  ]);
  // and a drag to the left takes it before the one it is dropped on
  await tab('terminal 1').dragTo(tab('build logs'));
  await until(
    same(['terminal 1', 'build logs', 'terminal 3']),
    'the tab went back to the start',
  );
  // The order is the main process's: another window's drag shows here too
  await page.evaluate(() =>
    window.tabMenuFixture.arrangedElsewhere([
      'local:term-3',
      'local:term-1',
      'local:term-2',
    ]),
  );
  await until(
    same(['terminal 3', 'terminal 1', 'build logs']),
    'the order another window chose',
  );

  // A restart keeps the tab's place, its number and its name
  await tab('build logs').click();
  await chooseTerminalMenu(page, 'restart terminal');
  assert.deepEqual(await calls('restart'), [{ id: 'term-2' }]);
  await until(
    async () =>
      (await page.locator('[aria-controls="terminal-term-4"]').count()) === 1 &&
      (await page.locator('[aria-controls="terminal-term-2"]').count()) === 0,
    "the new shell took the old one's tab",
  );
  assert.deepEqual(await names(), ['terminal 3', 'terminal 1', 'build logs']);

  // close others leaves only the tab it was chosen on
  await tab('terminal 1').click({ button: 'right' });
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'close others', exact: true })
    .click();
  await until(same(['terminal 1']), 'only terminal 1 is left');

  // Home has no conversation, so no terminals: the open mode says so
  await page.evaluate(() => {
    location.hash = '/home';
  });
  await page
    .getByText('terminals belong to a conversation; start one to open them', {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log('terminal tab menu: ok');
} finally {
  await browser?.close();
  await server.close();
}
