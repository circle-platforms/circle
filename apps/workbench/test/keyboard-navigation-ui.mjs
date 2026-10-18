import { runNativeKeyboardJourney } from '../../desktop/test/helpers/native-keyboard-journey.mjs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.addInitScript(() =>
    localStorage.setItem('circle.workbench.language', 'en'),
  );
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
  page.setDefaultTimeout(8000);
  const checks = [];
  await runNativeKeyboardJourney({ page, checks });
  assert.equal(checks.length, 1);
  assert.equal(
    await page
      .getByRole('button', { name: 'developer layout', exact: true })
      .count(),
    0,
  );
  const transcript = page.locator('.transcript');
  const frame = () =>
    page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  await transcript.evaluate((node) =>
    node.scrollTo({
      top: Math.max(0, node.scrollHeight - node.clientHeight - 15),
      behavior: 'instant',
    }),
  );
  await frame();
  const geometry = () =>
    transcript.evaluate((node) => ({
      top: node.scrollTop,
      max: node.scrollHeight - node.clientHeight,
    }));
  const before = await geometry();
  assert.ok(before.max > 15);
  const files = page.getByRole('button', { name: 'files panel', exact: true });
  await files.click();
  await frame();
  await files.click();
  await frame();
  const after = await geometry();
  assert.ok(
    Math.abs(before.top - after.top) <= 2,
    'manual reading15px above end survives original Inspector resize ' +
      JSON.stringify({ before, after }),
  );
  await transcript.evaluate((node) =>
    node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }),
  );
  await frame();
  await page.setViewportSize({ width: 1000, height: 900 });
  await frame();
  await page.setViewportSize({ width: 1280, height: 900 });
  await frame();
  const following = await geometry();
  assert.ok(
    Math.abs(following.top - following.max) <= 2,
    'actual bottom follows viewport reflow ' + JSON.stringify(following),
  );
  await page.keyboard.press('ControlOrMeta+p');
  const sourceSearch = page.getByRole('textbox', {
    name: 'global search',
    exact: true,
  });
  await sourceSearch.fill('README.md');
  await sourceSearch.press('Enter');
  await page.getByRole('button', { name: 'source code', exact: true }).click();
  const sourceInput = page
    .locator(
      '.native-code-editor .native-edit-context, .native-code-editor textarea.inputarea',
    )
    .first();
  await sourceInput.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.insertText('ξ');
  await page.waitForFunction(() =>
    document
      .querySelector('.native-code-editor .view-lines')
      ?.textContent.includes('ξ'),
  );
  await page.getByText('unsaved changes', { exact: true }).waitFor();
  await page.keyboard.press('Shift+ArrowLeft');
  const sourceSelection = () =>
    sourceInput.evaluate((node) =>
      node.editContext
        ? [node.editContext.selectionStart, node.editContext.selectionEnd]
        : [node.selectionStart, node.selectionEnd],
    );
  await page.waitForFunction(() => {
    const node = document.querySelector(
      '.native-code-editor .native-edit-context, .native-code-editor textarea.inputarea',
    );
    const state = node?.editContext ?? node;
    return state && state.selectionStart !== state.selectionEnd;
  });
  const selected = await sourceSelection();
  assert.notEqual(selected[0], selected[1]);
  const sourceText = await page
    .locator('.native-code-editor .view-lines')
    .first()
    .textContent();
  await page
    .locator('.native-code-editor .monaco-editor')
    .evaluate((node) => (window.localeAppEditor = node));
  await page.evaluate(async () => {
    const { setLanguage } = await import('/src/i18n/index.ts');
    setLanguage('zh-CN');
  });
  await page.getByRole('button', { name: '源码', exact: true }).waitFor();
  assert.equal(
    await page
      .locator('.native-code-editor .monaco-editor')
      .evaluate((node) => node === window.localeAppEditor),
    true,
    'real App language switch preserves the editor view',
  );
  assert.equal(
    await page.locator('.native-code-editor .view-lines').first().textContent(),
    sourceText,
  );
  assert.deepEqual(await sourceSelection(), selected);
  await page.evaluate(async () => {
    const { setLanguage } = await import('/src/i18n/index.ts');
    setLanguage('en');
  });
  await page
    .getByRole('button', { name: 'source code', exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator('.native-code-editor .monaco-editor')
      .evaluate((node) => node === window.localeAppEditor),
    true,
  );
  await sourceInput.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForFunction(
    () =>
      !document
        .querySelector('.native-code-editor .view-lines')
        ?.textContent.includes('ξ'),
  );
  assert.deepEqual(errors, []);
  console.log(
    'original-shell quick open, file/Inspector continuity, palette focus, draft/selection and exact reading scroll passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
