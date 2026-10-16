import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output =
  process.env.CIRCLE_TERMINAL_CONTEXT_EVIDENCE ||
  '/tmp/circle-native-terminal-context-ui';
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
    ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
    : {}),
});
const checks = [];
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
    });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    let stage = 'initialization';
    try {
      await page.goto(
        server.resolvedUrls.local[0] +
          'test/native-terminal-context-ui.html?theme=' +
          theme +
          '#/session/A',
      );
      const message = page.getByRole('textbox', {
        name: 'message',
        exact: true,
      });
      await message.waitFor();
      assert.equal(await message.inputValue(), 'unsent A draft');
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      const terminal = page.locator('#inspector-terminal-terminal');
      await terminal.waitFor();
      const find = terminal.getByRole('textbox', {
        name: 'find in terminal',
        exact: true,
      });
      await find.fill('CIRCLE_SELECTED_中文');
      await find.press('Enter');
      await page.waitForFunction(
        () =>
          document.querySelector(
            '#inspector-terminal-terminal .xterm-selection',
          )?.children.length > 0,
      );
      const add = terminal.getByRole('button', {
        name: 'add selection to chat',
        exact: true,
      });
      stage = 'first attachment';
      await add.click();
      await page
        .getByText('fixture terminal · selection', { exact: true })
        .waitFor();
      const observed = await page.evaluate(() =>
        window.__terminalContextFixture.observe(),
      );
      const a = observed.sessions.find((s) => s.id === 'A');
      assert.equal(a.draft, 'unsent A draft');
      assert.equal(a.messages.length, 0);
      assert.equal(observed.sends, 0);
      assert.equal(a.attachments.length, 1);
      const attachment = a.attachments[0];
      assert.equal(attachment.kind, 'file');
      assert.equal(attachment.mime, 'text/plain');
      assert(
        attachment.content.startsWith(
          'CIRCLE_SELECTED_中文\n\n--- terminal capture source ---\n',
        ),
      );
      const metadata = JSON.parse(
        attachment.content.split('\n\n--- terminal capture source ---\n')[1],
      );
      assert.equal(metadata.sessionId, 'A');
      assert.equal(metadata.terminalId, 'A-terminal');
      assert.equal(metadata.terminalEpoch, 'fixture-epoch');
      assert.equal(metadata.cwd, '/synthetic/workspace');
      assert.equal(metadata.origin, 'user-selected capture');
      assert.equal(metadata.outputSequence, 1);
      assert.equal(
        metadata.capturedBufferRange.coordinates,
        'zero-based, end exclusive',
      );
      await page.screenshot({
        path: output + '/' + theme + '-selection-chip.png',
      });
      await page
        .getByRole('button', {
          name: 'fixture terminal · selection',
          exact: true,
        })
        .click();
      const original = page.locator('.inspector .context-source').filter({
        has: page.locator('summary', {
          hasText: 'fixture terminal · selection',
        }),
      });
      if (!(await original.evaluate((node) => node.open)))
        await original.locator('summary').click();
      assert.equal(
        await original.locator('pre').textContent(),
        attachment.content,
        'existing context panel exposes the complete original selection and metadata',
      );
      await page.screenshot({
        path: output + '/' + theme + '-original-context-preview.png',
      });
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      await find.waitFor();
      assert.equal(
        await terminal.locator('#terminal-A-terminal').count(),
        1,
        'return to the same original terminal resource',
      );
      await page
        .getByRole('button', { name: 'close inspector', exact: true })
        .click();
      assert.equal(
        (await page.evaluate(() => window.__terminalContextFixture.observe()))
          .closeCalls,
        0,
      );
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      await find.waitFor();
      assert.equal(
        (await page.evaluate(() => window.__terminalContextFixture.observe()))
          .closeCalls,
        0,
      );
      await page
        .getByRole('button', {
          name: 'remove fixture terminal · selection',
          exact: true,
        })
        .click();
      await page.waitForFunction(
        () =>
          window.__terminalContextFixture
            .observe()
            .sessions.find((s) => s.id === 'A').attachments.length === 0,
      );
      assert.equal(await message.inputValue(), 'unsent A draft');
      await find.fill('CIRCLE_SELECTED_中文');
      await find.press('Enter');
      await page.waitForFunction(
        () =>
          document.querySelector(
            '#inspector-terminal-terminal .xterm-selection',
          )?.children.length > 0,
      );
      await page.waitForFunction(() => {
        const button = document.querySelector(
          '#inspector-terminal-terminal button[aria-label="add selection to chat"]',
        );
        return button && !button.disabled;
      });
      stage = 'repeat selection after hide/remove';
      await page.evaluate(() =>
        window.__terminalContextFixture.deferSelectionReplay(),
      );
      await add.click();
      await page.waitForFunction(
        () => window.__terminalContextFixture.observe().pending,
      );
      await page.getByRole('link', { name: 'context B', exact: true }).click();
      await page.waitForFunction(
        () => window.__terminalContextFixture.observe().activeSessionId === 'B',
      );
      assert.equal(await message.inputValue(), 'unsent B draft');
      await page.getByRole('link', { name: 'context A', exact: true }).click();
      await page.waitForFunction(
        () => window.__terminalContextFixture.observe().activeSessionId === 'A',
      );
      await page.evaluate(() => window.__terminalContextFixture.release());
      await page
        .getByText('terminal selection expired; select it again', {
          exact: true,
        })
        .waitFor();
      const final = await page.evaluate(() =>
        window.__terminalContextFixture.observe(),
      );
      assert(final.sessions.every((s) => s.attachments.length === 0));
      assert.equal(final.closeCalls, 0);
      assert.equal(final.sends, 0);
      assert(final.sessions.every((s) => s.messages.length === 0));
      assert.deepEqual(errors, []);
      checks.push({ theme, status: 'passed', attachment, final });
    } catch (error) {
      checks.push({
        theme,
        stage,
        status: 'failed',
        error: String(error),
        actual: await page.evaluate(() =>
          window.__terminalContextFixture?.observe(),
        ),
      });
      await page.screenshot({ path: output + '/' + theme + '-failure.png' });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
  await writeFile(
    output + '/receipt.json',
    JSON.stringify(
      {
        kind: 'actual full App, original terminal inspector, real xterm and existing Conversation FileChip; controlled native transport',
        checks,
      },
      null,
      2,
    ),
  );
}
assert(
  checks.every((c) => c.status === 'passed'),
  JSON.stringify(checks),
);
console.log(
  'PASS terminal selection enters original unsent conversation context',
);
