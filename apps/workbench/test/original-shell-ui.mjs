import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output =
  process.env.CIRCLE_UI_EVIDENCE || '/tmp/circle-original-shell-ui';
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
const receipts = [];
async function capturePanels(page, locale, theme, width) {
  const zh = locale === 'zh';
  await page
    .getByRole('button', {
      name: zh ? '关闭检查器' : 'close inspector',
      exact: true,
    })
    .click();
  const titleGeometry = await page.locator('.topbar').evaluate((node) => ({
    titleRight: node
      .querySelector('.session-title button')
      .getBoundingClientRect().right,
    actionsLeft: node.querySelector('.topbar-actions').getBoundingClientRect()
      .left,
  }));
  assert.ok(
    titleGeometry.titleRight <= titleGeometry.actionsLeft + 1,
    `session title does not overlap panel controls at ${width}px`,
  );
  await page.screenshot({
    path: `${output}/${locale}-${theme}-${width}-main.png`,
    animations: 'disabled',
  });
  for (const [kind, chinese] of [
    ['terminal', '终端'],
    ['files', '文件'],
    ['activity', '活动'],
    ['browser', '浏览器'],
    ['context', '上下文'],
    ['changes', '改动'],
  ]) {
    await page
      .getByRole('button', {
        name: zh ? `${chinese}面板` : `${kind} panel`,
        exact: true,
      })
      .click();
    const inspector = await page.locator('.inspector').evaluate((node) => ({
      headerHeight: node
        .querySelector('.inspector-title')
        .getBoundingClientRect().height,
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
      flush: node.querySelector('.inspector-body').classList.contains('flush'),
      headerIcons: [
        ...node.querySelectorAll(
          '.inspector-title .icon-button, .panel-switch button, .native-terminal-toolbar > .icon-button, .browser-tabs > .icon-button',
        ),
      ]
        .filter((button) => button.getClientRects().length)
        .map((button) => {
          const box = button.getBoundingClientRect();
          return {
            width: box.width,
            height: box.height,
            radius: getComputedStyle(button).borderRadius,
          };
        }),
      tabsInHeader: (() => {
        const tabs = node.querySelector(
          `.workspace-panel-${node.dataset.inspectorPanel} > .panel-header-tabs`,
        );
        if (!tabs) return true;
        const header = node
          .querySelector('.inspector-title')
          .getBoundingClientRect();
        const box = tabs.getBoundingClientRect();
        return box.top >= header.top && box.bottom <= header.bottom;
      })(),
    }));
    assert.equal(inspector.headerHeight, 40, `${kind}: one 40px header`);
    for (const icon of inspector.headerIcons) {
      assert.equal(icon.width, 26, `${kind}: 26px icon width`);
      assert.equal(icon.height, 26, `${kind}: 26px icon height`);
      assert.equal(icon.radius, '6px', `${kind}: 6px icon radius`);
    }
    assert.ok(inspector.tabsInHeader, `${kind}: own tabs share the header row`);
    assert.ok(
      inspector.scrollWidth <= inspector.width + 1,
      `${kind}: no horizontal overflow at ${width}px`,
    );
    assert.equal(
      inspector.flush,
      ['terminal', 'browser', 'files'].includes(kind),
    );
    if (kind === 'browser') {
      assert.equal(
        await page
          .getByText(zh ? '未连接浏览器' : 'no browser attached', {
            exact: true,
          })
          .count(),
        1,
      );
      assert.equal(
        await page
          .getByText(zh ? '此处仅预览浏览器面板' : 'browser preview only', {
            exact: true,
          })
          .count(),
        1,
      );
      assert.equal(
        await page
          .getByText('same session, shared view', { exact: true })
          .count(),
        0,
      );
    }
    if (kind === 'context') {
      await page
        .getByRole('heading', { name: zh ? '上下文' : 'context', exact: true })
        .waitFor({ state: 'visible' });
      assert.equal(
        await page
          .getByRole('heading', {
            name: zh ? '未发送操作 0' : 'unsent actions 0',
            exact: true,
          })
          .count(),
        1,
      );
    }
    await page.screenshot({
      animations: 'disabled',
      path: `${output}/${locale}-${theme}-${width}-${kind}.png`,
    });
  }
}
async function actualTheme(page, theme) {
  await page.waitForFunction(
    (theme) => {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const channels = style.backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (!channels || channels.length < 3 || channels[3] === 0) return false;
      const brightness =
        channels.slice(0, 3).reduce((sum, n) => sum + n, 0) / 3;
      return (
        root.dataset.theme === theme &&
        (theme === 'dark' ? brightness < 128 : brightness > 128)
      );
    },
    theme,
    { timeout: 5000 },
  );
  const state = await page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return {
      theme: root.dataset.theme,
      background: style.backgroundColor,
      foreground: style.color,
      token: style.getPropertyValue('--bg').trim(),
    };
  });
  assert.equal(state.theme, theme);
  const brightness =
    state.background
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number)
      .reduce((sum, n) => sum + n, 0) / 3;
  assert.equal(brightness < 128, theme === 'dark', JSON.stringify(state));
  return state;
}
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const width of [1280, 500, 290])
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.clock.setFixedTime(new Date('2026-10-16T00:00:00Z'));
      await page.addInitScript(() =>
        localStorage.setItem('circle.workbench.language', 'en'),
      );
      await page.goto(server.resolvedUrls.local[0] + '#/page/settings');
      // Change the mounted owner's settings. A second PreviewRuntime followed
      // by reload races the original conversation's pagehide persistence.
      await page.getByRole('button', { name: theme, exact: true }).click();
      await actualTheme(page, theme);
      await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
      await page
        .getByRole('textbox', { name: 'message', exact: true })
        .waitFor();
      const themeBefore = await actualTheme(page, theme);
      const paletteBefore = themeBefore.token;
      assert.equal(
        await page
          .locator(
            '.developer-workbench,.layout-toggle,.developer-dock,.workbench-mobile-tabs',
          )
          .count(),
        0,
      );
      const composer = page.locator('textarea[aria-label="message"]');
      const composerOwner = await composer.elementHandle();
      await composer.fill('Original shell preserved draft');
      await composer.evaluate((el) => el.setSelectionRange(4, 12));
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      await page
        .locator('#inspector-terminal-terminal')
        .waitFor({ state: 'visible' });
      await page.getByRole('tab', { name: 'history', exact: true }).click();
      assert.equal(
        await page.locator('#inspector-terminal-terminal').count(),
        1,
        'terminal resource remains mounted',
      );
      await page
        .getByRole('button', { name: 'close inspector', exact: true })
        .click();
      assert.equal(
        await page.locator('.inspector').isVisible(),
        false,
        'closed inspector is actually hidden',
      );
      assert.equal(
        await page.locator('#inspector-terminal-terminal').count(),
        1,
        'closing inspector preserves terminal',
      );
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      await page.getByRole('tab', { name: 'terminal', exact: true }).click();
      await page
        .getByRole('button', { name: 'close inspector', exact: true })
        .click();
      assert.equal(
        await page.locator('.inspector').isVisible(),
        false,
        'closed inspector is actually hidden',
      );
      await composer.focus();
      await page.keyboard.press('Control+p');
      const search = page.getByRole('textbox', {
        name: 'global search',
        exact: true,
      });
      await search.fill('README.md');
      await search.press('Enter');
      await page.locator('.file-view').waitFor({ state: 'visible' });
      assert.equal(
        await composer.isVisible(),
        false,
        'file replaces conversation in original main region',
      );
      assert.equal(await composer.count(), 1, 'draft owner remains mounted');
      await page
        .getByRole('button', { name: 'close file', exact: true })
        .click();
      assert.equal(
        await composer.inputValue(),
        'Original shell preserved draft',
      );
      assert.deepEqual(
        await composer.evaluate((el) => [el.selectionStart, el.selectionEnd]),
        [4, 12],
      );
      await page
        .getByRole('button', { name: 'changes panel', exact: true })
        .click();
      await page
        .getByRole('tab', { name: 'git workspace', exact: true })
        .click();
      await page
        .locator('#inspector-changes-git')
        .waitFor({ state: 'visible' });
      const geometry = await page
        .locator('.inspector-column')
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, width: r.width, right: r.right };
        });
      assert.ok(
        geometry.width > 250 && geometry.right <= width + 1,
        JSON.stringify(geometry),
      );
      if (width === 500)
        assert.equal(await page.locator('.inspector-overlay').count(), 1);
      assert.equal(
        await composer.inputValue(),
        'Original shell preserved draft',
      );
      await page.screenshot({
        animations: 'disabled',
        path: `${output}/${theme}-${width}.png`,
      });
      await capturePanels(page, 'en', theme, width);
      await page.evaluate(async () => {
        const { setLanguage } = await import('/src/i18n/index.ts');
        setLanguage('zh-CN');
      });
      await page
        .locator('#inspector-changes-git')
        .waitFor({ state: 'visible' });
      assert.equal(
        await page.locator('.composer textarea').inputValue(),
        'Original shell preserved draft',
      );
      const themeAfter = await actualTheme(page, theme);
      const paletteAfter = themeAfter.token;
      assert.equal(
        await composerOwner.evaluate((el) => el.isConnected),
        true,
        'locale change retains composer identity',
      );
      assert.equal(
        paletteAfter,
        paletteBefore,
        'locale change preserves the actual configured palette',
      );
      await page.screenshot({
        animations: 'disabled',
        path: `${output}/zh-${theme}-${width}.png`,
      });
      await capturePanels(page, 'zh', theme, width);
      const noOverflow = await page
        .locator('.inspector')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      assert.equal(
        noOverflow,
        true,
        'Chinese original inspector does not overflow',
      );
      assert.deepEqual(errors, []);
      receipts.push({
        theme,
        width,
        geometry,
        paletteBefore,
        paletteAfter,
        themeBefore,
        themeAfter,
        themeVerified: true,
        native: false,
        passed: true,
      });
      await page.close();
    }
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify({ native: false, receipts }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, receipts, output }));
} finally {
  await browser?.close();
  await server.close();
}
