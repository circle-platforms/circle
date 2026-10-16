import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
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
  const page = await browser.newPage();
  await page.goto(
    server.resolvedUrls.local[0] +
      'test/paste-default-ui.html#/session/session1',
  );
  const box = page.getByRole('textbox', { name: 'message', exact: true });
  await box.waitFor();
  await page.evaluate(() => {
    window.keys = [];
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key.toLowerCase() !== 'v') return;
        const record = {
          key: event.key,
          code: event.code,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          alt: event.altKey,
          shift: event.shiftKey,
          composing: event.isComposing,
          trusted: event.isTrusted,
        };
        setTimeout(
          () =>
            window.keys.push({ ...record, prevented: event.defaultPrevented }),
          0,
        );
      },
      true,
    );
  });
  await box.fill('preserved draft');
  for (const chord of ['Meta+v', 'Control+v']) {
    await box.press(chord);
    await page.waitForFunction(
      (n) => window.keys.length >= n,
      chord === 'Meta+v' ? 1 : 2,
    );
  }
  const keys = await page.evaluate(() => window.keys);
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => k.trusted && !k.prevented));
  await page.evaluate(() =>
    window.pasteRuntime.change((state) => {
      state.settings.keybindings = { 'image.paste': 'alt+v' };
    }),
  );
  await box.press('Alt+v');
  await page.waitForFunction(() => window.keys.length === 3);
  assert.equal(
    (await page.evaluate(() => window.keys))[2].prevented,
    false,
    'custom paste binding does not pretend to read clipboard',
  );
  // Clipboard delivery is controlled here: this is not a claim of trusted OS paste.
  // Actual native CUA shortcut -> trusted PNG -> attachment is a separate native gate.
  await box.evaluate(async (node) => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'fixture.png', { type: 'image/png' }));
    node.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });
  await page.waitForFunction(() =>
    window.pasteRuntime
      .getSnapshot()
      .sessions.find((s) => s.id === 'session1')
      .attachments.some((a) => a.name === 'fixture.png'),
  );
  let state = await page.evaluate(() =>
    window.pasteRuntime.getSnapshot().sessions.find((s) => s.id === 'session1'),
  );
  assert.equal(state.draft, 'preserved draft');
  assert.equal(
    state.attachments.filter((a) => a.name === 'fixture.png').length,
    1,
  );
  assert.match(
    state.attachments.find((a) => a.name === 'fixture.png').content,
    /^data:image\/png;base64,/,
  );
  await box.evaluate((node) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'ordinary short text');
    node.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });
  state = await page.evaluate(() =>
    window.pasteRuntime.getSnapshot().sessions.find((s) => s.id === 'session1'),
  );
  assert.equal(
    state.attachments.filter((a) => a.kind === 'image').length,
    1,
    'plain text is not misclassified as an image',
  );
  console.log(
    JSON.stringify({
      passed: true,
      keys,
      customBinding:
        'unhandled native default; no clipboard read or synthetic paste shortcut',
      attachmentDelivery:
        'controlled untrusted ClipboardEvent only; native trusted acceptance separate',
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
