import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// The terminal mode: shells, a command Circle runs and device consoles are tabs of one
// row, with a menu to make a terminal or reach a device, and what the tab in front can be
// told to do at the end of the row.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-terminal-mode-')));
await mkdir(output, { recursive: true });
const open = async (browser, theme, locale) => {
  const page = await browser.newPage({
    viewport: { width: 1680, height: 900 },
  });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(
    `${server.resolvedUrls.local[0]}test/terminal-mode-ui.html?theme=${theme}&locale=${locale}`,
  );
  await page
    .getByRole('button', {
      name: locale === 'zh-CN' ? '终端面板' : 'terminal panel',
      exact: true,
    })
    .click();
  await page.locator('.term-tabs').waitFor();
  return { page, errors };
};
const names = (page) =>
  page
    .locator('.term-tab-main')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
const calls = (page, kind) =>
  page.evaluate(
    (kind) =>
      window.terminalModeFixture.calls
        .filter((entry) => entry.call === kind)
        .map((entry) => entry.args),
    kind,
  );
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  {
    const { page, errors } = await open(browser, 'light', 'en');
    await page.waitForFunction(
      () => document.querySelectorAll('.term-tab-main').length === 5,
    );
    assert.deepEqual(await names(page), [
      'terminal 1',
      'terminal 2',
      'npm run test -- reconnect',
      'core-switch · SSH',
      'rack-pdu · Telnet',
    ]);
    // A command Circle runs: in front, ringed in blue, with its dot and its stop, and no
    // way to close it while it runs.
    const command = page.getByRole('tab', {
      name: 'npm run test -- reconnect',
    });
    assert.equal(await command.getAttribute('aria-selected'), 'true');
    assert.equal(
      await page.locator('.term-frame').getAttribute('data-frame'),
      'run',
    );
    assert.equal(
      await command.locator('.term-dot').getAttribute('data-state'),
      'run',
    );
    assert.equal(
      await page.locator('.term-tab.on .term-tab-x').count(),
      0,
      'a running command has no close',
    );
    await page.screenshot({ path: `${output}/command-light-en.png` });
    // A shell of yours: no ring, no dot, a close; its menu has the terminal's own actions.
    await page.getByRole('tab', { name: 'terminal 1' }).click();
    assert.equal(
      await page.locator('.term-frame').getAttribute('data-frame'),
      '',
    );
    assert.equal(
      await page.getByRole('button', { name: 'stop', exact: true }).count(),
      0,
    );
    assert.equal(
      (await page.getByRole('button', { name: 'stop terminal' }).count()) > 0,
      true,
    );
    await page
      .getByRole('button', { name: 'terminal menu', exact: true })
      .click();
    for (const item of [
      'find in terminal',
      'copy complete output',
      'restart terminal',
      'interrupt command',
      'start service',
    ])
      await page.getByRole('menuitem', { name: item }).waitFor();
    await page.keyboard.press('Escape');

    // + : a local terminal, a saved device, a new device.
    await page.getByRole('button', { name: 'new terminal or device' }).click();
    await page.getByRole('menuitem', { name: /new local terminal/ }).waitFor();
    await page.getByRole('menuitem', { name: /edge-router/ }).waitFor();
    await page.screenshot({ path: `${output}/plus-light-en.png` });
    await page.getByRole('menuitem', { name: /new local terminal/ }).click();
    await page.getByRole('tab', { name: 'terminal 3' }).waitFor();
    assert.equal(
      (await calls(page, 'terminal.create')).length,
      1,
      'one shell was made',
    );

    // A new device, by address: nothing is saved, and a failure is said in the form.
    await page.getByRole('button', { name: 'new terminal or device' }).click();
    await page.getByRole('menuitem', { name: /connect new device/ }).click();
    const form = page.locator('.term-connect');
    await form.waitFor();
    await form.getByLabel('address').fill('unreachable.invalid');
    await form.getByRole('button', { name: 'connect', exact: true }).click();
    await form.getByText('could not reach unreachable.invalid').waitFor();
    await form.getByLabel('address').fill('10.0.0.7');
    await form.getByLabel('user name').fill('admin');
    await page.screenshot({ path: `${output}/connect-light-en.png` });
    await form.getByRole('button', { name: 'connect', exact: true }).click();
    await page.getByRole('tab', { name: '10.0.0.7 · SSH' }).waitFor();
    assert.deepEqual((await calls(page, 'terminalConnectTarget')).at(-1), [
      { transport: 'ssh', host: '10.0.0.7', user: 'admin' },
    ]);
    assert.equal(await form.count(), 0, 'the form closes once connected');

    // A device console: take it, give it back, disconnect it.
    await page.getByRole('tab', { name: 'core-switch · SSH' }).click();
    await page.getByRole('button', { name: 'take over', exact: true }).click();
    await page
      .getByRole('button', { name: 'give back', exact: true })
      .waitFor();
    assert.deepEqual(await calls(page, 'terminalAttach'), [['t1']]);
    await page.getByRole('button', { name: 'give back', exact: true }).click();
    await page
      .getByRole('button', { name: 'take over', exact: true })
      .waitFor();
    assert.deepEqual(await calls(page, 'terminalDetach'), [['t1']]);
    await page.screenshot({ path: `${output}/device-light-en.png` });
    await page.getByRole('button', { name: 'disconnect core-switch' }).click();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('.term-tab-main')].some((node) =>
          node.textContent.includes('core-switch'),
        ),
    );
    assert.deepEqual(await calls(page, 'terminalDisconnect'), [['t1']]);

    // Closing a shell stops it and takes its tab out of the row.
    await page.getByRole('tab', { name: 'terminal 2' }).click();
    await page.getByRole('button', { name: 'stop terminal 2' }).click();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('.term-tab-main')].some(
          (node) => node.textContent.trim() === 'terminal 2',
        ),
    );
    assert.equal((await calls(page, 'terminal.close')).length, 1);

    // The command ends: its dot is a ring, the stop goes, the close comes, the blue goes.
    await page.getByRole('tab', { name: 'npm run test -- reconnect' }).click();
    await page.evaluate(() => window.terminalModeFixture.endCommand(0));
    await page.waitForFunction(
      () =>
        document
          .querySelector('.term-tab.on .term-dot')
          ?.getAttribute('data-state') === 'done',
    );
    assert.equal(
      await page.getByRole('button', { name: 'stop', exact: true }).count(),
      0,
    );
    assert.equal(
      await page.locator('.term-frame').getAttribute('data-frame'),
      '',
    );
    await page
      .getByRole('button', { name: 'close npm run test -- reconnect' })
      .click();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('.term-tab-main')].some((node) =>
          node.textContent.includes('npm run test'),
        ),
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  for (const [theme, locale] of [
    ['dark', 'en'],
    ['light', 'zh-CN'],
  ]) {
    const { page, errors } = await open(browser, theme, locale);
    await page.waitForFunction(
      () => document.querySelectorAll('.term-tab-main').length === 5,
    );
    const zh = locale === 'zh-CN';
    assert.deepEqual(await names(page), [
      zh ? '终端 1' : 'terminal 1',
      zh ? '终端 2' : 'terminal 2',
      'npm run test -- reconnect',
      'core-switch · SSH',
      'rack-pdu · Telnet',
    ]);
    await page.getByRole('tab', { name: /rack-pdu/ }).click();
    await page
      .getByRole('button', { name: zh ? '接管' : 'take over', exact: true })
      .waitFor();
    await page.screenshot({ path: `${output}/device-${theme}-${locale}.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
console.log('terminal mode: ok');
