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
    // A command Circle runs in the foreground has a terminal and no tab; the terminal
    // button counts the commands that run in the background.
    assert.equal((await names(page)).includes('ls -la'), false);
    assert.equal(
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .locator('.drawer-mode-badge')
        .textContent(),
      '1',
    );
    // A command Circle runs in the background: in front, ringed in blue, with its dot and
    // its stop, and no way to close it while it runs.
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

    // Circle in your shells. Its question about the shell is an orange dot on the tab, an
    // orange ring and a card in the conversation headed by the tab; its work is blue and
    // puts take over and stop at the end of the row; a shell you hold gives back.
    const card = page.locator('.inline-request[data-kind="approval"]');
    assert.equal(
      await card.locator('header strong').textContent(),
      'terminal 1',
    );
    assert.match(
      await card.locator('header span').first().textContent(),
      /runs a shell command/,
    );
    assert.equal(
      await card.locator('.approval-command').textContent(),
      'npm run test -- reconnect',
    );
    const shellOne = page.getByRole('tab', { name: 'terminal 1' });
    await shellOne.click();
    await page.evaluate(() =>
      window.terminalModeFixture.circle(1, { state: 'waiting' }),
    );
    await shellOne.locator('.term-dot[data-state="wait"]').waitFor();
    assert.equal(
      await page.locator('.term-frame').getAttribute('data-frame'),
      'wait',
    );
    for (const name of ['take over', 'give back'])
      assert.equal(
        await page.getByRole('button', { name, exact: true }).count(),
        0,
        `no ${name} while Circle waits for your answer`,
      );
    await page.screenshot({ path: `${output}/tab-waiting-light-en.png` });
    await page.evaluate(() =>
      window.terminalModeFixture.circle(1, { state: 'operating' }),
    );
    await shellOne.locator('.term-dot[data-state="run"]').waitFor();
    assert.equal(
      await page.locator('.term-frame').getAttribute('data-frame'),
      'run',
    );
    await page.screenshot({ path: `${output}/tab-operating-light-en.png` });
    await page
      .getByRole('button', { name: 'stop Circle in terminal 1' })
      .click();
    assert.deepEqual(await calls(page, 'terminalStop'), [['local:terminal-1']]);
    await page.waitForFunction(
      () => !document.querySelector('.term-tab.on .term-dot'),
    );
    assert.equal(
      await page.locator('.term-frame').getAttribute('data-frame'),
      '',
    );
    await page.evaluate(() =>
      window.terminalModeFixture.circle(1, { state: 'operating' }),
    );
    await page.getByRole('button', { name: 'take over', exact: true }).click();
    await page
      .getByRole('button', { name: 'give back', exact: true })
      .waitFor();
    assert.deepEqual((await calls(page, 'terminalAttach')).at(-1), [
      'local:terminal-1',
    ]);
    assert.equal(
      await page.locator('.term-frame').getAttribute('data-frame'),
      '',
    );
    await page.getByRole('button', { name: 'give back', exact: true }).click();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('button')].some(
          (node) => node.textContent.trim() === 'give back',
        ),
    );
    assert.deepEqual((await calls(page, 'terminalDetach')).at(-1), [
      'local:terminal-1',
    ]);
    // A shell Circle handed to you says why.
    await page.evaluate(() =>
      window.terminalModeFixture.circle(1, {
        state: 'held',
        held: 'handoff',
        reason: 'the build asks for your password',
      }),
    );
    await page
      .getByText(
        'Circle hands you terminal 1: the build asks for your password',
      )
      .waitFor();
    await page
      .getByRole('button', { name: 'give back', exact: true })
      .waitFor();
    await page.evaluate(() =>
      window.terminalModeFixture.circle(1, {
        state: 'idle',
        held: undefined,
        reason: undefined,
      }),
    );

    // Closing a shell stops it and takes its tab out of the row.
    await page.getByRole('tab', { name: 'terminal 2' }).click();
    await page.getByRole('button', { name: 'stop terminal 2' }).click();
    // By id: with the numbers compacted, another shell takes the name
    // "terminal 2" as soon as this one leaves the row.
    await page.waitForFunction(
      () => !document.querySelector('[aria-controls="terminal-terminal-2"]'),
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
    // The card for Circle's first command in a shell is headed by the shell's tab, and
    // while Circle works in it the row offers to take it over or stop Circle.
    assert.equal(
      await page
        .locator('.inline-request[data-kind="approval"] header strong')
        .textContent(),
      zh ? '终端 1' : 'terminal 1',
    );
    await page.getByRole('tab', { name: zh ? '终端 1' : 'terminal 1' }).click();
    await page.evaluate(() =>
      window.terminalModeFixture.circle(1, { state: 'operating' }),
    );
    await page
      .getByRole('button', { name: zh ? '接管' : 'take over', exact: true })
      .waitFor();
    await page
      .getByRole('button', {
        name: zh
          ? '停止 Circle 在 终端 1 里的操作'
          : 'stop Circle in terminal 1',
      })
      .waitFor();
    assert.equal(
      await page.locator('.term-frame').getAttribute('data-frame'),
      'run',
    );
    await page.screenshot({
      path: `${output}/tab-operating-${theme}-${locale}.png`,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
console.log('terminal mode: ok');
