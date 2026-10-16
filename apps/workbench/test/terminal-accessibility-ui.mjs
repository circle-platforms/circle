import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
    ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
    : {}),
  headless: true,
});
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page.goto(
      server.resolvedUrls.local[0] +
        `test/native-terminal-tabs-ui.html?theme=${theme}&accessibility=1`,
    );
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    await page.locator('#inspector-terminal-tab-terminal').click();
    const surface = page.locator('.native-terminal-surface:not([hidden])');
    await surface.locator('.xterm-accessibility-tree').waitFor();
    const input = await surface
      .locator('.xterm-helper-textarea')
      .elementHandle();
    await page.evaluate(() => window.terminalTabsFixture.accessibility(false));
    await surface
      .locator('.xterm-accessibility-tree')
      .waitFor({ state: 'detached' });
    await page.evaluate(() => window.terminalTabsFixture.accessibility(true));
    await surface.locator('.xterm-accessibility-tree').waitFor();
    assert.equal(
      await surface
        .locator('.xterm-helper-textarea')
        .evaluate((n, old) => n === old, input),
      true,
    );
    await page.evaluate(() =>
      window.terminalTabsFixture.accessibilityChoice('always'),
    );
    await page.evaluate(() => window.terminalTabsFixture.accessibility(false));
    assert.equal(await surface.locator('.xterm-accessibility-tree').count(), 1);
    await page.evaluate(() =>
      window.terminalTabsFixture.accessibilityChoice('auto'),
    );
    await surface
      .locator('.xterm-accessibility-tree')
      .waitFor({ state: 'detached' });
    await page.evaluate(() =>
      window.terminalTabsFixture.accessibility(false, false),
    );
    await surface.locator('.xterm-accessibility-tree').waitFor();
    await surface.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('still-input');
    await page.waitForFunction(
      () =>
        window.terminalTabsFixture.writes.map((x) => x.data).join('') ===
        'still-input',
    );
    assert.equal(
      await surface
        .locator('.xterm-helper-textarea')
        .evaluate((n, old) => n === old, input),
      true,
    );
    assert.equal(
      await page
        .locator(
          '.native-terminal-surface[hidden] .xterm-accessibility-tree:visible',
        )
        .count(),
      0,
    );
    await page.close();
  }
  console.log(
    'actual NativeTerminal AUTO host changes, ALWAYS override, unknown host fallback, same DOM and keyboard PASS',
  );
} finally {
  await browser.close();
  await server.close();
}
