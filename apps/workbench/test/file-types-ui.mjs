import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// A linked file opens by its type: a picture is drawn, never put in the text editor, and a
// file that is not text says so in the interface language, with the folder it is in a click
// away; the decoder's words never show.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const output = process.env.CIRCLE_COMPONENT_UI_EVIDENCE ?? 'artifacts';
await mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const [locale, theme] of [
    ['en', 'light'],
    ['zh-CN', 'dark'],
  ]) {
    const word = (en, zh) => (locale === 'zh-CN' ? zh : en);
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/file-types-ui.html?locale=${locale}&theme=${theme}`,
    );
    const answer = page.locator('[data-message-id="links"]');
    await answer.waitFor();
    const calls = () =>
      page.evaluate(() => window.fileTypesFixture.calls.map((c) => c.call));
    // A picture: found without reading it as text, then drawn from its bytes
    await answer
      .getByRole('link', { name: 'the picture', exact: true })
      .click();
    const picture = page.locator('.picture-view');
    const image = picture
      .getByRole('region', { name: 'a-light.png', exact: true })
      .locator('img');
    await image.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('.picture-view img')?.naturalWidth === 2 &&
        document.querySelector('.picture-view img')?.complete,
    );
    assert.equal(await image.getAttribute('alt'), 'a-light.png');
    assert.match(
      await picture.locator('.file-source-summary').textContent(),
      /\.tmp\/designs.*2 × 1 · 71 B/,
    );
    assert.deepEqual(
      (await calls()).filter((call) => call.startsWith('documents.')),
      ['documents.resolveSource', 'documents.readImage'],
      'a picture is never read as text',
    );
    assert.equal(await page.locator('.file-source-editor').count(), 0);
    // A file that is not text: named as such in words, not as missing and not in the
    // decoder's words, and shown in its folder on request
    await answer.getByRole('link', { name: 'the data', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'blob.bin' });
    await alert.waitFor();
    assert.equal(
      await alert.locator('h3').textContent(),
      word('blob.bin is not a text file', 'blob.bin 不是文本文件'),
    );
    const text = await page
      .locator('.drawer-document-content > .session-resource-view')
      .textContent();
    assert.doesNotMatch(text, /not valid for encoding|file not found|未找到/);
    await alert
      .getByRole('button', {
        name: word(/show in (finder|folder)/, /在 ?(Finder|文件夹) ?中显示/),
      })
      .click();
    assert.deepEqual(
      await page.evaluate(() =>
        window.fileTypesFixture.calls
          .filter((c) => c.call === 'revealWorkspace')
          .map((c) => c.params),
      ),
      [
        {
          workspaceId: await page.evaluate(
            () => window.fileTypesFixture.workspaceId,
          ),
          path: 'data/blob.bin',
        },
      ],
    );
    await page.screenshot({
      path: `${output}/file-types-${locale}-${theme}.png`,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'file types: a linked picture is drawn from its bytes and a file that is not text says so and shows its folder, in English and Chinese',
  );
} finally {
  await browser?.close();
  await server.close();
}
