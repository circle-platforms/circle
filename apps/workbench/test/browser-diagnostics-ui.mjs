import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const output = process.env.CIRCLE_BROWSER_UI_EVIDENCE;
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
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  const setup = async () => {
    await page.goto(
      server.resolvedUrls.local[0] + 'test/browser-diagnostics-ui.html',
    );
    await page
      .getByRole('button', { name: 'page diagnostics', exact: true })
      .click();
    await page.getByRole('tab', { name: 'page debugger', exact: true }).click();
    await page
      .locator('.browser-diagnostic-results details summary')
      .first()
      .click();
  };
  for (const scenario of [
    'step refreshes selected locals across merged pauses',
    'resumed and paused transitions refresh selected scope without another click',
    'old asynchronous scope reply cannot restore an obsolete pause',
    'hidden debug scopes do not keep requesting variables',
    'evaluation uses current frame and displays its reply',
    'evaluation obsolete pause reply cannot restore a result',
    'evaluation same pause latest request wins out of order',
  ]) {
    try {
      await setup();
      if (
        scenario ===
        'resumed and paused transitions refresh selected scope without another click'
      ) {
        await page.getByRole('button', { name: 'local', exact: true }).click();
        await page.getByText('count: 1', { exact: true }).waitFor();
        await page.evaluate(() => window.__browserFixture.deferStep());
        await page
          .getByRole('button', { name: 'step over', exact: true })
          .click();
        await page.getByText('page running', { exact: true }).waitFor();
        await page.evaluate(() => window.__browserFixture.paused());
        await page
          .getByText('fixture-3 http://localhost/fixture.js:3', { exact: true })
          .waitFor();
        await page.getByText('count: 3', { exact: true }).waitFor();
        await page.evaluate(() => {
          window.__browserFixture.releaseStep();
          return new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        assert.equal(
          await page.getByText('count: 3', { exact: true }).count(),
          1,
          'late resumed step reply cannot erase the new paused scope',
        );
      } else if (
        scenario === 'evaluation same pause latest request wins out of order'
      ) {
        await page.evaluate(() => window.__browserFixture.deferEvaluation());
        const input = page.getByLabel('debug expression', { exact: true });
        const evaluate = page.getByRole('button', {
          name: 'evaluate',
          exact: true,
        });
        await input.fill('count = 7');
        await evaluate.click();
        await input.fill('count = 8');
        await evaluate.click();
        await page
          .locator('.debug-evaluate output')
          .getByText('8', { exact: true })
          .waitFor();
        await page.evaluate(() => {
          window.__browserFixture.release();
          return new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        assert.equal(
          await page.locator('.debug-evaluate output').innerText(),
          '8',
          'late A must not overwrite same-pause B',
        );
      } else if (scenario.startsWith('evaluation')) {
        if (scenario.includes('obsolete'))
          await page.evaluate(() => window.__browserFixture.deferEvaluation());
        await page
          .getByLabel('debug expression', { exact: true })
          .fill('count = 7');
        await page
          .getByRole('button', { name: 'evaluate', exact: true })
          .click();
        if (scenario.includes('obsolete')) {
          await page.evaluate(() => window.__browserFixture.next());
          await page
            .getByText('fixture-2 http://localhost/fixture.js:2', {
              exact: true,
            })
            .waitFor();
          await page.evaluate(() => window.__browserFixture.release());
          assert.equal(
            await page.locator('.debug-evaluate output').innerText(),
            '',
          );
        } else
          await page
            .locator('.debug-evaluate output')
            .getByText('7', { exact: true })
            .waitFor();
      } else if (scenario.startsWith('step')) {
        await page.getByRole('button', { name: 'local', exact: true }).click();
        await page.getByText('count: 1', { exact: true }).waitFor();
        await page
          .getByRole('button', { name: 'step over', exact: true })
          .click();
        await page
          .getByText('count: 2', { exact: true })
          .waitFor({ timeout: 1500 });
      } else if (scenario.startsWith('hidden')) {
        await page.getByRole('button', { name: 'local', exact: true }).click();
        await page.getByText('count: 1', { exact: true }).waitFor();
        const before = await page.evaluate(() =>
          window.__browserFixture.requests(),
        );
        await page.getByRole('tab', { name: 'console', exact: true }).click();
        await page.evaluate(() => window.__browserFixture.next());
        await page.waitForTimeout(100);
        assert.equal(
          await page.evaluate(() => window.__browserFixture.requests()),
          before,
        );
        await page
          .getByRole('tab', { name: 'page debugger', exact: true })
          .click();
        await page.getByText('count: 2', { exact: true }).waitFor();
      } else {
        await page.evaluate(() => window.__browserFixture.defer());
        await page.getByRole('button', { name: 'local', exact: true }).click();
        await page.evaluate(() => window.__browserFixture.next());
        await page
          .getByText('fixture-2 http://localhost/fixture.js:2', { exact: true })
          .waitFor();
        await page.evaluate(() => window.__browserFixture.release());
        await page
          .getByText('count: 2', { exact: true })
          .waitFor({ timeout: 1500 });
        await page.waitForTimeout(80);
        assert.equal(
          await page
            .getByText('fixture-1 http://localhost/fixture.js:1', {
              exact: true,
            })
            .count(),
          0,
        );
      }
      checks.push({ scenario, status: 'passed' });
    } catch (error) {
      checks.push({
        scenario,
        status: 'failed',
        error: String(error),
        actual: await page.locator('.browser-diagnostics').innerText(),
      });
      if (output)
        await page.screenshot({
          animations: 'disabled',
          path: join(output, 'failure-' + checks.length + '.png'),
        });
    }
  }
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['dark', 'light'])
      for (const width of [500, 375]) {
        await page.setViewportSize({ width, height: 800 });
        const words =
          language === 'en'
            ? {
                open: 'page diagnostics',
                loading: 'loading diagnostics',
                unknown: 'page status unavailable',
                running: 'page running',
                empty: 'no console messages',
                storage: 'storage',
                key: 'storage key',
                value: 'storage value',
              }
            : {
                open: '页面诊断',
                loading: '正在加载诊断',
                unknown: '页面状态未知',
                running: '页面运行中',
                empty: '暂无控制台消息',
                storage: '存储',
                key: '存储键',
                value: '存储值',
              };
        for (const mode of ['pending', 'error', 'empty']) {
          const scenario = `${language} ${theme} ${width} ${mode} diagnostic state`;
          try {
            await page.goto(
              server.resolvedUrls.local[0] +
                'test/browser-diagnostics-ui.html?status=' +
                mode,
            );
            await page.locator('.browser-diagnostics').waitFor();
            await page.evaluate(
              async ({ language, theme, width }) => {
                (await import('/src/i18n/index.ts')).setLanguage(language);
                (await import('/src/theme.ts')).applyTheme(theme);
                document.querySelector('.native-browser').style.width =
                  width + 'px';
              },
              { language, theme, width },
            );
            await page
              .getByRole('button', { name: words.open, exact: true })
              .click();
            if (mode === 'pending') {
              await page.getByText(words.loading, { exact: true }).waitFor();
              assert.equal(
                await page.getByText(words.running, { exact: true }).count(),
                0,
              );
              assert.equal(
                await page.getByText(words.empty, { exact: true }).count(),
                0,
              );
            } else if (mode === 'error') {
              await page
                .getByRole('alert')
                .getByText(words.unknown, { exact: true })
                .waitFor();
              assert.equal(await page.getByRole('alert').count(), 1);
              assert.equal(
                await page.getByText(words.unknown, { exact: true }).count(),
                1,
                'one visible error summary is shown',
              );
              assert.equal(
                await page.getByRole('status').count(),
                0,
                'error has no duplicate status summary',
              );
              assert.equal(
                await page
                  .getByRole('alert')
                  .locator('details')
                  .evaluate((node) => node.open),
                false,
              );
              const alert = page.getByRole('alert');
              await alert.locator(':scope > details > summary').click();
              await alert
                .getByText('synthetic diagnostics unavailable', { exact: true })
                .waitFor();
              assert.equal(
                await page
                  .getByText('synthetic diagnostics unavailable', {
                    exact: true,
                  })
                  .count(),
                1,
                'the original diagnostic is available once in error details',
              );
              await alert.locator(':scope > details > summary').click();
              assert.equal(
                await alert.locator('details').evaluate((node) => node.open),
                false,
              );
              assert.equal(
                await page.getByText(words.running, { exact: true }).count(),
                0,
              );
              assert.equal(
                await page.getByText(words.empty, { exact: true }).count(),
                0,
              );
            } else await page.getByText(words.empty, { exact: true }).waitFor();
            if (output)
              await page.screenshot({
                animations: 'disabled',
                path: join(output, `${language}-${theme}-${width}-${mode}.png`),
              });
            if (mode === 'empty') {
              await page
                .getByRole('tab', { name: words.storage, exact: true })
                .click();
              for (const placeholder of [words.key, words.value]) {
                const input = page.getByPlaceholder(placeholder, {
                  exact: true,
                });
                assert.equal(await input.count(), 1);
                await input.waitFor({ state: 'visible' });
                await input.scrollIntoViewIfNeeded();
                assert.equal(
                  await input.inputValue(),
                  '',
                  'empty storage field displays its purpose',
                );
                assert.equal(
                  await input.getAttribute('aria-label'),
                  placeholder,
                );
              }
              if (output)
                await page.screenshot({
                  animations: 'disabled',
                  path: join(
                    output,
                    `${language}-${theme}-${width}-storage-placeholders.png`,
                  ),
                });
            }
            checks.push({ scenario, status: 'passed' });
          } catch (error) {
            checks.push({ scenario, status: 'failed', error: String(error) });
            if (output)
              await page.screenshot({
                animations: 'disabled',
                path: join(output, `state-failure-${checks.length}.png`),
              });
          }
        }
      }
  await page.goto(
    server.resolvedUrls.local[0] + 'test/browser-diagnostics-ui.html',
  );
  await page
    .getByRole('button', { name: 'page diagnostics', exact: true })
    .click();
  await page.setViewportSize({ width: 375, height: 800 });
  const assertToolbarGap = async (container) => {
    const rects = await container.locator('button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const r = button.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
    );
    for (let i = 1; i < rects.length; i++) {
      const previous = rects[i - 1],
        current = rects[i];
      const gap =
        Math.abs(current.top - previous.top) < 1
          ? current.left - previous.right
          : current.top - previous.bottom;
      assert(gap >= 8, `toolbar buttons require 8px spacing; actual ${gap}`);
    }
  };
  await assertToolbarGap(
    page.locator('.browser-diagnostic-results > .browser-diagnostic-tools'),
  );
  await page.getByRole('button', { name: 'view log', exact: true }).click();
  const savedLog = page
    .locator('details.context-source')
    .filter({ has: page.getByText('saved browser log', { exact: true }) });
  await savedLog.locator('pre').waitFor();
  await assertToolbarGap(savedLog.locator('.browser-diagnostic-tools'));
  assert.equal(
    (await savedLog.locator('pre').innerText()).split('\n').length,
    256,
  );
  await savedLog
    .getByRole('button', { name: 'next page', exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector('.browser-diagnostic-results pre')
      ?.textContent?.includes('日志 257'),
  );
  await savedLog
    .getByRole('button', { name: 'copy complete log', exact: true })
    .click();
  await page.waitForFunction(
    () => window.__copiedBrowserLog?.split('\n').length === 620,
  );
  const archived = await page.evaluate(() =>
    window.__copiedBrowserLog.split('\n').map(JSON.parse),
  );
  assert.equal(archived[0].data.text, '日志 1\n完整原文');
  assert.equal(archived[619].data.text, '日志 620\n完整原文');
  checks.push({
    scenario: 'saved log pagination and complete 620-row copy',
    status: 'passed',
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(
    server.resolvedUrls.local[0] + 'test/browser-diagnostics-ui.html?layout',
  );
  const geometry = await page.evaluate(() => {
    const bottom = (selector) =>
      document.querySelector(selector).getBoundingClientRect().bottom;
    const children = [...document.querySelector('.native-browser').children]
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    return {
      footerGap: bottom('.inspector-body') - bottom('.native-browser-footer'),
      blank:
        bottom('.inspector-body') -
        Math.max(...children.map((rect) => rect.bottom)),
      diagnosticsHeight: document
        .querySelector('.browser-diagnostics')
        .getBoundingClientRect().height,
    };
  });
  assert(
    geometry.footerGap > 32,
    'old footer reference counts newly added diagnostic controls as blank',
  );
  assert(
    geometry.blank <= 32,
    'actual empty gap after all visible browser controls remains bounded',
  );
  checks.push({
    scenario:
      'closed diagnostic controls occupy the area below the page footer',
    status: 'passed',
    geometry,
  });
  if (output)
    await writeFile(
      join(output, 'receipt.json'),
      JSON.stringify(
        {
          kind: 'actual headless React BrowserDiagnostics interactions',
          checks,
        },
        null,
        2,
      ),
    );
  assert(
    checks.every((check) => check.status === 'passed'),
    JSON.stringify(checks),
  );
  console.log(
    'PASS real React browser debugger pause and stale variable reply scenarios',
  );
} finally {
  await browser?.close();
  await server.close();
}
