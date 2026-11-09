import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// A linked file opens by its type: a picture is drawn, never put in the text editor; a file
// that is not text says so in the interface language, with the folder it is in a click away;
// a page or PDF of the workspace opens in the browser as a local file. The decoder's words
// never show.
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
    // A page and a PDF of the workspace open in the conversation's browser, at the
    // addresses the desktop made for them, and the address bar names them as local files
    const sessionId = await page.evaluate(
      () => window.fileTypesFixture.sessionId,
    );
    const opened = async (name, path, url) => {
      await answer.getByRole('link', { name, exact: true }).click();
      await page.waitForFunction(
        (wanted) =>
          window.fileTypesFixture.calls.some(
            (c) => c.call === 'browserNavigate' && c.params.url === wanted,
          ),
        url,
      );
      assert.deepEqual(
        await page.evaluate(() =>
          window.fileTypesFixture.calls
            .filter((c) => c.call === 'browserLocalPage')
            .at(-1),
        ),
        {
          call: 'browserLocalPage',
          params: { sessionId, path, ownerSessionId: undefined },
        },
      );
      const local = page.getByTestId('browser-local');
      await local.waitFor();
      assert.equal(
        (await local.textContent()).trim(),
        word('local file', '本地文件'),
      );
    };
    await opened(
      'the page',
      '.tmp/designs/editor-a.html',
      `circle-local://${'a'.repeat(32)}/.tmp/designs/editor-a.html`,
    );
    // Not being typed in, the address bar shows the page's path in the workspace, never
    // the token it is served under
    await page.locator('.browser-url input').evaluate((node) => node.blur());
    const shown = page.locator('.browser-url-display');
    await shown.waitFor();
    assert.equal(
      (await shown.textContent()).trim(),
      '.tmp/designs/editor-a.html',
    );
    await opened(
      'the spec',
      'docs/spec.pdf',
      'file:///workspace/orbit-api/docs/spec.pdf',
    );
    // Opened from the files mode, the PDF is a file that is not text, and offers the
    // browser, where it opens as from a link
    const navigations = async () =>
      (await calls()).filter((call) => call === 'browserNavigate').length;
    const before = await navigations();
    await page
      .getByRole('button', {
        name: word('files panel', '文件 面板'),
        exact: true,
      })
      .click();
    const item = (name) =>
      page.getByRole('treeitem').filter({ hasText: name }).first();
    if (!(await item('spec.pdf').isVisible())) await item('docs').click();
    await item('spec.pdf').click();
    const notText = page.getByRole('alert').filter({ hasText: 'spec.pdf' });
    await notText.waitFor();
    await notText
      .getByRole('button', {
        name: word('open in browser', '在浏览器中打开'),
        exact: true,
      })
      .click();
    await page.waitForFunction(
      (count) =>
        window.fileTypesFixture.calls.filter(
          (c) => c.call === 'browserNavigate',
        ).length > count,
      before,
    );
    assert.equal(await navigations(), before + 1);
    // Neither link was read as a text file
    assert.equal(
      (await calls()).filter((call) => call === 'documents.read').length,
      2,
      'only the binary file and the PDF opened from the files mode were read as text',
    );
    await page.screenshot({
      path: `${output}/file-types-${locale}-${theme}.png`,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'file types: a linked picture is drawn from its bytes, a file that is not text says so and shows its folder, and a page or PDF opens in the browser as a local file, in English and Chinese',
  );
} finally {
  await browser?.close();
  await server.close();
}
