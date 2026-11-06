// Every publication renders the rows on screen. Their words are parsed when they change,
// not each time, and a source link still opens through the window's latest handler.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
  resolve: {
    alias: [
      {
        find: /^react-markdown$/,
        replacement: fileURLToPath(
          new URL('./markdown-render-counter.tsx', import.meta.url),
        ),
      },
    ],
  },
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(
    server.resolvedUrls.local[0] + 'test/markdown-render-ui.html',
  );
  const link = page.getByRole('link', { name: 'source', exact: true });
  await link.waitFor();
  const parses = () => page.evaluate(() => window.markdownParses);
  const first = await parses();
  assert.ok(first >= 1);

  for (let render = 1; render <= 5; render++) {
    await page.evaluate(() => window.renderAgain());
    await page
      .getByTestId('render')
      .getByText(String(render), { exact: true })
      .waitFor();
  }
  assert.equal(
    await parses(),
    first,
    'the same words are not parsed again when the window renders',
  );

  await link.click();
  assert.deepEqual(
    await page.evaluate(() => window.opened),
    [{ path: 'README.md', render: 5 }],
    'the link goes to the handler of the latest render, not of the first',
  );

  await page.evaluate(() => window.setText('**changed** words'));
  await page.locator('.markdown strong').getByText('changed').waitFor();
  assert.ok((await parses()) > first, 'changed words are parsed');

  // What the row says in the interface's own words follows the language.
  await page.evaluate(() => window.setText('| a |\n| - |\n| b |'));
  await page.getByRole('region', { name: 'response table' }).waitFor();
  await page.evaluate(() => window.setLanguage('zh-CN'));
  await page.getByRole('region', { name: '回答表格' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('markdown renders only when its words change');
} finally {
  await browser?.close();
  await server.close();
}
