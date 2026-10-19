import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// A screenshot Circle took is a small picture under the tool line, and a press on it opens
// the whole picture with a way to copy it and a way to keep it.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-screenshot-thumb-')));
await mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const theme of ['light', 'dark'])
    for (const locale of ['en', 'zh-CN']) {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(
        `${server.resolvedUrls.local[0]}test/screenshot-thumb-ui.html?theme=${theme}&locale=${locale}`,
      );
      const thumbs = page.locator('.tool-shots .image-thumb');
      const thumb = thumbs.first();
      await thumb.waitFor();
      assert.equal(
        await thumbs.count(),
        2,
        'each picture of the call, shown under the line',
      );
      // It shows with the tool line folded: nobody has to open the call to see it.
      assert.equal(
        await page.locator('.tool-group-calls').count(),
        0,
        'the calls are still folded',
      );
      const box = await thumb.boundingBox();
      assert.ok(
        box && box.width <= 180 && box.width > 20 && box.height > 0,
        `a thumbnail, not the whole picture (${box?.width}x${box?.height})`,
      );
      await page.screenshot({
        path: `${output}/thumb-${theme}-${locale}.png`,
      });
      await thumb.click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      assert.equal(
        (await dialog.getByText('app.example.test 12:04.png').count()) > 0,
        true,
        'the window names the picture',
      );
      assert.equal(await dialog.locator('.lightbox img').count(), 1);
      await page.screenshot({
        path: `${output}/lightbox-${theme}-${locale}.png`,
      });
      const words =
        locale === 'zh-CN'
          ? { copy: '复制图片', save: '保存到文件' }
          : { copy: 'copy image', save: 'save to file' };
      await dialog.getByRole('button', { name: words.copy }).click();
      await dialog.getByRole('button', { name: words.save }).click();
      const calls = await page.evaluate(
        () => window.screenshotThumbFixture.calls,
      );
      assert.deepEqual(
        calls.map((entry) => entry.call),
        ['copyImage', 'saveImage'],
      );
      assert.match(calls[0].args[0], /^data:image\/png;base64,/);
      assert.equal(calls[1].args[0], 'app.example.test 12:04.png');
      assert.equal(calls[1].args[1], calls[0].args[0]);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      // A GIF goes to the clipboard as a PNG, which the system takes, and is saved as it is
      await page
        .getByRole('button', {
          name: locale === 'zh-CN' ? '放大 spinner.gif' : 'enlarge spinner.gif',
        })
        .click();
      await dialog.waitFor();
      await dialog.getByRole('button', { name: words.copy }).click();
      await dialog.getByRole('button', { name: words.save }).click();
      await page.waitForFunction(
        () => window.screenshotThumbFixture.calls.length === 4,
      );
      const gif = (
        await page.evaluate(() => window.screenshotThumbFixture.calls)
      ).slice(2);
      assert.match(gif[0].args[0], /^data:image\/png;base64,/);
      assert.equal(gif[1].args[0], 'spinner.gif');
      assert.match(gif[1].args[1], /^data:image\/gif;base64,/);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      await page.close();
    }
} finally {
  await browser?.close();
  await server.close();
}
console.log('screenshot thumbnails: ok');
