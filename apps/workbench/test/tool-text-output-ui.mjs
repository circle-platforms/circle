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
  process.env.CIRCLE_TOOL_TEXT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-tool-text-ui-')));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
    ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
    : {}),
});
const cases = [];
let page;
try {
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['dark', 'light'])
      for (const width of [1280, 375]) {
        page = await browser.newPage({ viewport: { width, height: 850 } });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(
          server.resolvedUrls.local[0] +
            `test/tool-text-output-ui.html?language=${language}&theme=${theme}`,
        );
        await page.locator('.tool-summary').click();
        const card = page.locator('.tool-call');
        if (!(await card.locator('.tool-content').isVisible()))
          await card.locator('.tool-head').click();
        const pre = card.locator('.tool-text-preview pre');
        await pre.waitFor();
        const value = await pre.textContent();
        assert.equal(value.split('\n').length, 601);
        assert(value.includes('test\tRun npm test\t'));
        assert(value.includes('第600行'));
        assert(!value.includes('\x1b'));
        assert.equal(await pre.locator('img,a,script').count(), 0);
        const geometry = await pre.evaluate((n) => ({
          width: n.clientWidth,
          full: n.scrollWidth,
          whiteSpace: getComputedStyle(n).whiteSpace,
          scrolling: getComputedStyle(n).overflowX,
        }));
        assert.equal(geometry.whiteSpace, 'pre');
        assert(geometry.full > geometry.width);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          true,
          'long log remains inside original card',
        );
        await card
          .locator('.tool-head')
          .evaluate((n) =>
            n.scrollIntoView({ block: 'start', behavior: 'instant' }),
          );
        await page.screenshot({
          path: join(output, `${language}-${theme}-${width}-preview.png`),
        });
        await pre.evaluate((n) => {
          n.scrollLeft = n.scrollWidth;
          n.scrollTop = n.scrollHeight;
        });
        assert((await pre.evaluate((n) => n.scrollLeft)) > 0);
        await pre.evaluate((n) => (n.scrollLeft = 0));
        await pre.focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(
          () => document.querySelector('.tool-text-preview pre').scrollLeft > 0,
        );
        assert((await pre.evaluate((n) => n.scrollTop)) > 0);
        const textCopy =
          language === 'en' ? 'copy text output' : '复制完整文本输出';
        const rawCopy = language === 'en' ? 'copy tool output' : '复制工具输出';
        await card.getByRole('button', { name: textCopy, exact: true }).click();
        await page.waitForFunction(
          () => window.textOutputFixture.copied.length === 1,
        );
        assert.equal(
          await page.evaluate(
            () =>
              window.textOutputFixture.copied[0] ===
              window.textOutputFixture.text,
          ),
          true,
        );
        await card.locator('details > summary').click();
        assert.equal(
          await card.locator('details .data-block pre').textContent(),
          await page.evaluate(() => window.textOutputFixture.raw),
        );
        assert(
          (await card.locator('details pre').textContent()).includes(
            'candidate-exact-head',
          ),
        );
        await card.getByRole('button', { name: rawCopy, exact: true }).click();
        await page.waitForFunction(
          () => window.textOutputFixture.copied.length === 2,
        );
        assert.equal(
          await page.evaluate(
            () =>
              window.textOutputFixture.copied[1] ===
              window.textOutputFixture.raw,
          ),
          true,
        );
        await card
          .getByRole('button', {
            name: language === 'en' ? 'input' : '输入',
            exact: true,
          })
          .click();
        assert.equal(
          await card.locator('.data-block pre').textContent(),
          JSON.stringify({ runId: 314 }, null, 2),
        );
        assert.deepEqual(errors, []);
        await page.screenshot({
          path: join(output, `${language}-${theme}-${width}.png`),
        });
        cases.push({ language, theme, width, status: 'passed', geometry });
        await page.close();
        page = undefined;
      }
  console.log(
    'tool JSON text preview, 600 complete lines, exact text/raw copies, inert ANSI/HTML and input controls PASS (8 cases)',
  );
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(output, 'receipt.json'), JSON.stringify(cases, null, 2));
  await browser.close();
  await server.close();
}
