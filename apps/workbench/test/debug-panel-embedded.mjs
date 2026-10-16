import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { port: 0, host: '127.0.0.1' },
});
let browser;
const evidenceRoot = fileURLToPath(
  new URL('../artifacts/debug-embedded/', import.meta.url),
);
await mkdir(evidenceRoot, { recursive: true });
const output =
  process.env.CIRCLE_DEBUG_EMBEDDED_EVIDENCE ||
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ||
  (await mkdtemp(join(evidenceRoot, 'attempt-')));
await mkdir(output, { recursive: true });
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const locale of ['en', 'zh-CN'])
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({
        viewport: { width: 380, height: 760 },
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(
        `${server.resolvedUrls.local[0]}test/debug-panel-embedded.html?locale=${locale}&theme=${theme}`,
      );
      await page.getByRole('button', { name: /frame-A/ }).waitFor();
      const debug = page.locator('.debug-panel');
      await page
        .getByLabel(locale === 'en' ? 'program path' : '程序路径')
        .fill('/fixture/very long project path/app.cjs');
      await page
        .getByText(locale === 'en' ? 'launch options' : '启动选项', {
          exact: true,
        })
        .click();
      await page
        .getByRole('button', {
          name: locale === 'en' ? 'add argument' : '添加参数',
          exact: true,
        })
        .click();
      const arg = debug.locator('.debug-argument input');
      await arg.fill('literal "quoted" value');
      await page.getByRole('button', { name: 'toggle debug' }).click();
      await page.getByRole('button', { name: 'toggle debug' }).click();
      assert.equal(await arg.inputValue(), 'literal "quoted" value');
      assert.equal(
        await debug.locator('h2').count(),
        0,
        'Inspector owns the only heading',
      );
      const geometry = await debug.evaluate((el) => ({
        width: el.clientWidth,
        scroll: el.scrollWidth,
        overflow: getComputedStyle(el).overflowY,
        bg: getComputedStyle(el).backgroundColor,
        buttonClass: el.querySelector('button').className,
        sections: [...el.querySelectorAll('.debug-inspection>section')].map(
          (x) => x.getBoundingClientRect().left,
        ),
      }));
      assert.ok(
        geometry.scroll <= geometry.width + 1,
        JSON.stringify(geometry),
      );
      assert.equal(geometry.overflow, 'visible');
      assert.equal(geometry.bg, 'rgba(0, 0, 0, 0)');
      assert.match(geometry.buttonClass, /button/);
      assert.equal(
        geometry.sections[0],
        geometry.sections[1],
        'narrow Inspector stacks sections',
      );
      await page.screenshot({
        path: `${output}/${locale}-${theme}.png`,
        fullPage: true,
      });
      assert.deepEqual(errors, []);
      await page.close();
    }
  console.log(
    'debug embedded: four localized theme cases passed; draft survives hidden tab; no nested scroll or horizontal overflow',
  );
} finally {
  await browser?.close();
  await server.close();
}
