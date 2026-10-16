import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_EXTENSION_FEEDBACK_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-extension-feedback-')));
await mkdir(output, { recursive: true });
let browser, currentPage;
const cases = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      for (const width of [375, 1280]) {
        const page = await browser.newPage({
          viewport: { width, height: 1000 },
        });
        currentPage = page;
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.setDefaultTimeout(5000);
        await page.goto(
          `${server.resolvedUrls.local[0]}test/extension-feedback-ui.html?language=${language}&theme=${theme}`,
        );
        await page
          .getByRole('heading', { name: 'github', exact: true })
          .waitFor();
        const labels = await page.evaluate(
            () => window.extensionFeedbackFixture.labels,
          ),
          row = page.locator('.extension-card').filter({
            has: page.getByRole('heading', { name: 'github', exact: true }),
          }),
          toggle = row.getByRole('checkbox');
        const count = async (number) =>
          page.waitForFunction(
            (n) =>
              window.extensionFeedbackFixture.commands.filter(
                (command) => command.name === 'save-settings',
              ).length === n,
            number,
          );
        const reply = async (index, failure = false) =>
          page.evaluate(
            ({ index, failure }) =>
              window.extensionFeedbackFixture.reply(index, failure),
            { index, failure },
          );
        const status = async (key) =>
          row.getByText(labels[key], { exact: true }).waitFor();
        await toggle.click();
        await count(1);
        await status('savingOn');
        assert.equal(await toggle.isChecked(), true);
        assert.equal(
          (
            await page.evaluate(() =>
              window.extensionFeedbackFixture.snapshot(),
            )
          ).extensions[0].enabled,
          false,
          'saving alone cannot activate runtime',
        );
        await reply(0, true);
        await status('saveError');
        assert.equal(await toggle.isChecked(), false);
        await row.getByRole('alert').locator('summary').click();
        assert.match(
          await row.getByRole('alert').locator('pre').textContent(),
          /synthetic local settings write failure/,
        );
        await toggle.click();
        await count(2);
        await reply(1);
        await status('loading');
        assert.equal(
          await row.getByText(labels.enabled, { exact: true }).count(),
          0,
          'saved/boolean true is not loaded',
        );
        await page.evaluate(() => window.extensionFeedbackFixture.load(true));
        await status('loadError');
        await toggle.click();
        await count(3);
        await reply(2);
        await status('disabled');
        await toggle.click();
        await count(4);
        await reply(3);
        await status('loading');
        await page.evaluate(() => window.extensionFeedbackFixture.load());
        await status('enabled');
        await page.screenshot({
          path: `${output}/${language}-${theme}-${width}-enabled.png`,
        });
        await toggle.click();
        await count(5);
        await reply(4);
        await status('disabled');
        // Turn off while module registration is pending; no global UI lock and no
        // stale success/error from the earlier on intent may overwrite the off row.
        await toggle.click();
        await count(6);
        await reply(5);
        await status('loading');
        await toggle.click();
        await count(7);
        await status('savingOff');
        const observer = page.locator('.extension-card').filter({
          has: page.getByRole('heading', { name: 'observer', exact: true }),
        });
        await observer.getByRole('checkbox').click();
        await count(8);
        await reply(6);
        await status('disabled');
        await page.evaluate(() => window.extensionFeedbackFixture.load());
        await status('disabled');
        assert.equal(await toggle.isChecked(), false);
        await reply(7);
        // Generic extensions retain the explicit reload contract; save success alone
        // is deliberately not reported as module activation.
        await observer.getByRole('checkbox').click();
        await count(9);
        await reply(8);
        await observer.getByText(labels.reload, { exact: true }).waitFor();
        await page
          .getByRole('button', { name: labels.reloadButton, exact: true })
          .click();
        await observer.getByText(labels.enabled, { exact: true }).waitFor();
        // The existing paired interface switch uses the exact same request lifecycle.
        await page
          .getByRole('button', { name: labels.interface, exact: true })
          .click();
        const paired = page.locator('.extension-card').filter({
          has: page.getByRole('heading', { name: /GitHub/, exact: false }),
        });
        await paired.getByRole('checkbox').click();
        await count(10);
        await reply(10);
        await paired.getByText(labels.loading, { exact: true }).waitFor();
        await page.evaluate(() => window.extensionFeedbackFixture.load());
        await paired.getByText(labels.enabled, { exact: true }).waitFor();
        await page.screenshot({
          path: `${output}/${language}-${theme}-${width}-paired.png`,
        });
        // A new off intention also remains responsive while the earlier local
        // settings reply itself is deferred; its late failure stays superseded.
        await paired.getByRole('checkbox').click();
        await count(11);
        await reply(11);
        await paired.getByText(labels.disabled, { exact: true }).waitFor();
        await paired.getByRole('checkbox').click();
        await count(12);
        await paired.getByRole('checkbox').click();
        await count(13);
        await reply(13);
        await paired.getByText(labels.disabled, { exact: true }).waitFor();
        await reply(12, true);
        await paired.getByText(labels.disabled, { exact: true }).waitFor();
        assert.equal(
          await paired.getByRole('alert').count(),
          0,
          'superseded on failure does not replace off status',
        );
        assert.ok(
          (
            await page.evaluate(() =>
              window.extensionFeedbackFixture.snapshot(),
            )
          ).sessions.every((item) => !item.actionError),
        );
        const commands = await page.evaluate(
          () => window.extensionFeedbackFixture.commands,
        );
        assert.deepEqual(
          commands
            .filter((command) => command.name === 'save-settings')
            .map((command) => command.payload.settings),
          Array(13).fill({}),
        );
        assert.equal(
          commands.filter((command) => command.name === 'reload').length,
          1,
          'only explicit reload reloads all extensions',
        );
        assert.deepEqual(errors, []);
        cases.push({ language, theme, width, passed: true });
        await page.close();
      }
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify(
      {
        scope:
          'actual LiveRuntime + full original Extensions page; controlled native command and module registration replies, not real extension execution',
        cases,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: `${output}/failure.png` });
    await writeFile(
      `${output}/failure.json`,
      JSON.stringify(
        {
          error: String(error),
          state: await currentPage.evaluate(() => ({
            commands: window.extensionFeedbackFixture.commands,
            extensions: window.extensionFeedbackFixture.snapshot().extensions,
            body: document.body.innerText,
          })),
        },
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
