import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
let activePage;
const output =
  process.env.CIRCLE_INSPECTOR_WIDTH_EVIDENCE || '/tmp/circle-inspector-width';
await mkdir(output, { recursive: true });
const receipts = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 950 },
    });
    page.setDefaultTimeout(8000);
    activePage = page;
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/response-readability-ui.html?theme=${theme}#/session/session1`,
    );
    const input = page.getByRole('textbox', { name: 'message', exact: true });
    await input.waitFor();
    await input.fill('inspector width retained draft');
    await input.evaluate((el) => el.setSelectionRange(3, 11));
    const inputOwner = await input.elementHandle();
    const frames = () =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    const geometry = () =>
      page.evaluate(() => {
        const group = document
          .getElementById('workbench-columns')
          .getBoundingClientRect();
        const main = document.getElementById('main').getBoundingClientRect();
        const inspector = document
          .querySelector('.inspector-column')
          .getBoundingClientRect();
        return {
          mode: document.getElementById('workbench-columns').dataset
            .inspectorMode,
          group: { left: group.left, width: group.width, right: group.right },
          main: { left: main.left, width: main.width, right: main.right },
          inspector: {
            left: inspector.left,
            width: inspector.width,
            right: inspector.right,
          },
        };
      });
    const full = async () => {
      await frames();
      const actual = await geometry();
      if (Math.abs(actual.group.width - actual.main.width) > 1)
        console.log(
          JSON.stringify(
            await page.evaluate(() =>
              [...document.getElementById('workbench-columns').children].map(
                (el) => ({
                  tag: el.tagName,
                  id: el.id,
                  html: el.outerHTML.slice(0, 700),
                  rect: el.getBoundingClientRect().toJSON(),
                  style: {
                    display: getComputedStyle(el).display,
                    flex: getComputedStyle(el).flex,
                    minWidth: getComputedStyle(el).minWidth,
                    width: getComputedStyle(el).width,
                  },
                }),
              ),
            ),
          ),
        );
      assert.ok(
        Math.abs(actual.group.width - actual.main.width) <= 1,
        JSON.stringify(actual),
      );
      return actual;
    };
    await page.evaluate(() =>
      window.readabilityFixture.runtime.change((state) => {
        state.sessions[0].messages[0].text +=
          '\n\n' +
          Array.from(
            { length: 60 },
            (_, i) => `Retained reading paragraph ${i}.`,
          ).join('\n\n');
      }),
    );
    await page.waitForFunction(() => {
      const el = document.querySelector('.transcript');
      return el.scrollHeight > el.clientHeight + 500;
    });
    await frames();
    const transcript = page.locator('.transcript');
    await transcript.hover();
    await page.mouse.wheel(0, -600);
    await page.waitForFunction(() => {
      const el = document.querySelector('.transcript');
      return (
        el.scrollTop > 0 &&
        el.scrollTop < el.scrollHeight - el.clientHeight - 50
      );
    });
    await frames();
    const reading = await transcript.evaluate((el) => el.scrollTop);
    const closed = await full();
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    await page.locator('#inspector-terminal-terminal').waitFor();
    const resource = await page
      .locator('#inspector-terminal-terminal')
      .elementHandle();
    const split = await geometry();
    assert.equal(split.mode, 'split');
    assert.ok(
      split.inspector.width >= 290 && split.main.width < split.group.width,
    );
    const handle = page.getByRole('separator', {
      name: 'resize inspector',
      exact: true,
    });
    const bounds = await handle.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x - 60, bounds.y + 100, { steps: 10 });
    await page.mouse.up();
    await frames();
    const dragged = await geometry();
    assert.ok(
      dragged.inspector.width > split.inspector.width + 40,
      'original inspector remains resizable',
    );
    for (let i = 0; i < 3; i++) {
      await page
        .getByRole('button', { name: 'close inspector', exact: true })
        .click();
      await full();
      assert.ok(
        Math.abs((await transcript.evaluate((el) => el.scrollTop)) - reading) <=
          2,
        `same-width inspector roundtrip keeps reading position: before=${reading} after=${await transcript.evaluate((el) => el.scrollTop)}`,
      );
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      await frames();
      const reopened = await geometry();
      assert.ok(
        Math.abs(reopened.inspector.width - dragged.inspector.width) <= 2,
        'closing preserves original split ratio',
      );
      assert.equal(await resource.evaluate((el) => el.isConnected), true);
    }
    const overlays = [];
    for (const width of [500, 375, 500, 375]) {
      await page.setViewportSize({ width, height: 950 });
      await frames();
      if (!(await page.locator('.inspector').isVisible()))
        await page
          .getByRole('button', { name: 'terminal panel', exact: true })
          .click();
      const overlay = await full();
      assert.equal(overlay.mode, 'overlay');
      assert.ok(
        overlay.inspector.width > 250 && overlay.inspector.right <= width + 1,
      );
      assert.equal(await resource.evaluate((el) => el.isConnected), true);
      overlays.push(overlay);
      await page
        .getByRole('button', { name: 'close inspector', exact: true })
        .click();
      await full();
      await page.screenshot({ path: `${output}/${theme}-${width}-closed.png` });
    }
    await page.setViewportSize({ width: 1280, height: 950 });
    await full();
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    await frames();
    const restored = await geometry();
    assert.equal(restored.mode, 'split');
    assert.ok(
      restored.inspector.width >= 290 &&
        restored.main.width < restored.group.width,
    );
    assert.equal(await resource.evaluate((el) => el.isConnected), true);
    assert.equal(await inputOwner.evaluate((el) => el.isConnected), true);
    assert.equal(await input.inputValue(), 'inspector width retained draft');
    assert.deepEqual(
      await input.evaluate((el) => [el.selectionStart, el.selectionEnd]),
      [3, 11],
    );
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/${theme}-restored-split.png` });
    receipts.push({
      theme,
      closed,
      split,
      dragged,
      overlays,
      restored,
      passed: true,
      native: false,
    });
    await page.close();
  }
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify(
      {
        passed: true,
        native: false,
        scope:
          'Full original CircleWorkbench; actual resizable Panel outer geometry, pointer drag, repeated close/reopen and narrow overlay; exact retained composer/resource DOM identities',
        receipts,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, output, receipts }));
} catch (error) {
  await activePage
    ?.screenshot({ path: `${output}/failure.png` })
    .catch(() => {});
  const actual = await activePage
    ?.evaluate(() => {
      const rect = (id) =>
        document.getElementById(id)?.getBoundingClientRect().toJSON();
      return {
        group: rect('workbench-columns'),
        main: rect('main'),
        inspector: rect('inspector'),
        mode: document.getElementById('workbench-columns')?.dataset
          .inspectorMode,
      };
    })
    .catch(() => null);
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify({ passed: false, error: String(error), actual }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
