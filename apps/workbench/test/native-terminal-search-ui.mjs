import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openNativeTerminalInspector } from '../../desktop/test/helpers/native-terminal-journey.mjs';
const output = process.env.CIRCLE_TERMINAL_SEARCH_EVIDENCE;
if (output) await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
});
const checks = [];
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });
  page.setDefaultTimeout(3000);
  const errors = [];
  await page.addInitScript(() => {
    window.__terminalErrors = [];
    window.addEventListener('error', (event) =>
      window.__terminalErrors.push(event.message),
    );
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  for (const profile of [
    { name: 'standalone-light', embedded: false, theme: 'light', width: 1200 },
    { name: 'inspector-light', embedded: true, theme: 'light', width: 420 },
    { name: 'inspector-dark', embedded: true, theme: 'dark', width: 420 },
  ])
    for (const scenario of [
      'search waits for real xterm parsed output',
      'new query supersedes pending search',
      'session switch rejects old search',
      'unmount safely discards pending search',
    ]) {
      try {
        await page.setViewportSize({ width: profile.width, height: 800 });
        await page.goto(
          server.resolvedUrls.local[0] +
            'test/native-terminal-search-ui.html?' +
            new URLSearchParams({
              embedded: String(profile.embedded),
              theme: profile.theme,
            }),
        );
        if (profile.embedded) {
          await openNativeTerminalInspector(page);
          // A repeated request must not close the original toggle-based Inspector.
          await openNativeTerminalInspector(page);
          assert.equal(
            await page
              .getByRole('button', { name: 'terminal panel', exact: true })
              .getAttribute('aria-pressed'),
            'true',
          );
        }
        const find = page.getByRole('textbox', {
          name: 'find in terminal',
          exact: true,
        });
        await find.waitFor();
        await page.waitForFunction(
          () => window.__terminalFixture.requests() > 0,
        );
        await find.fill('CIRCLE_TERMINAL_LINE_0001_中文');
        await find.press('Enter');
        if (scenario.startsWith('new query')) {
          await find.fill('NO_SUCH_MATCH');
          await find.press('Enter');
        } else if (scenario.startsWith('session')) {
          await page.evaluate(() => window.__terminalFixture.switchSession());
          await page
            .getByRole('tabpanel', { name: 'fixture terminal' })
            .last()
            .waitFor();
          await find.fill('NO_SUCH_MATCH');
          await find.press('Enter');
        } else if (scenario.startsWith('unmount'))
          await page.evaluate(() => window.__terminalFixture.unmount());
        await page.evaluate(() => window.__terminalFixture.release());
        if (scenario.startsWith('search waits')) {
          await page.waitForFunction(
            () =>
              document.querySelector('.xterm-selection')?.children.length > 0,
          );
          await find.press('Escape');
          await page.keyboard.press('Meta+c');
          await page.waitForFunction(
            () =>
              window.__terminalFixture.copied() ===
              window.__terminalFixture.lines[0],
          );
          assert.equal(
            await page.getByText('no matches', { exact: true }).isVisible(),
            false,
          );
          await page
            .getByRole('button', { name: 'copy complete output', exact: true })
            .click();
          await page.waitForFunction(() =>
            window.__terminalFixture
              .copied()
              .includes(window.__terminalFixture.lines[599]),
          );
          assert.deepEqual(
            (await page.evaluate(() => window.__terminalFixture.copied()))
              .trim()
              .split(/\r?\n/),
            await page.evaluate(() => window.__terminalFixture.lines),
          );
          if (profile.embedded) {
            const input = await page
              .locator('.xterm-helper-textarea')
              .elementHandle();
            await page
              .getByRole('button', { name: 'terminal panel', exact: true })
              .click();
            await openNativeTerminalInspector(page);
            assert.equal(
              await input.evaluate(
                (element) =>
                  element.isConnected &&
                  element === document.querySelector('.xterm-helper-textarea'),
              ),
              true,
              'hiding the original Inspector must preserve the mounted terminal',
            );
            assert.equal(
              await page
                .locator('.native-terminal')
                .evaluate((element) => element.classList.contains('embedded')),
              true,
            );
            assert.equal(
              await page
                .locator('.native-terminal')
                .getByRole('heading')
                .count(),
              0,
              'embedded terminal inherits the original Inspector heading',
            );
            assert.equal(
              await page
                .locator('.native-terminal')
                .evaluate(
                  (element) => element.scrollWidth <= element.clientWidth,
                ),
              true,
              'narrow original Inspector must not introduce horizontal page overflow',
            );
            assert.ok(
              await page
                .locator('.native-terminal .segmented button.active')
                .count(),
              'terminal tabs use the original segmented control',
            );
            assert.ok(
              await page.locator('.native-terminal .status').count(),
              'terminal state uses the original status component',
            );
          }
          if (output)
            await page.screenshot({
              path: join(output, profile.name + '.png'),
            });
        } else if (!scenario.startsWith('unmount')) {
          await page.waitForFunction(() =>
            [...document.querySelectorAll('.xterm-accessibility-tree')].some(
              (node) => node.textContent.includes('0600_中文'),
            ),
          );
          await page.getByText('no matches', { exact: true }).waitFor();
        } else
          await page
            .getByRole('region', { name: 'interactive terminal' })
            .waitFor({ state: 'detached' });
        assert.deepEqual(
          errors,
          [],
          'pending search must not throw after identity changes',
        );
        assert.deepEqual(
          await page.evaluate(() => window.__terminalErrors),
          [],
          'terminal resizing must not produce unhandled browser errors',
        );
        checks.push({ profile: profile.name, scenario, status: 'passed' });
      } catch (error) {
        checks.push({
          profile: profile.name,
          scenario,
          status: 'failed',
          error: String(error),
        });
        if (output)
          await page.screenshot({
            path: join(output, `failure-${checks.length}.png`),
          });
      }
    }
} finally {
  await browser?.close();
  await server.close();
  if (output)
    await writeFile(
      join(output, 'receipt.json'),
      JSON.stringify(
        {
          kind: 'actual React NativeTerminal and xterm SearchAddon with controlled replay transport',
          checks,
        },
        null,
        2,
      ),
    );
}
assert.equal(
  checks.filter((item) => item.status === 'failed').length,
  0,
  JSON.stringify(checks),
);
console.log('PASS native terminal search UI scenarios');
