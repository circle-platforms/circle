import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// The window as a whole in the preview: the top bar's icons, the overview beside the
// conversation and each mode of the drawer, in both themes, both languages and three window
// widths, with the conversation's draft kept through all of it. The screenshots are the
// appearance baselines' source.
const output =
  process.env.CIRCLE_UI_EVIDENCE || '/tmp/circle-workspace-shell-ui';
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
let browser;
const receipts = [];
const MODES = [
  ['overview', '概览'],
  ['files', '文件'],
  ['changes', '改动'],
  ['browser', '浏览器'],
  ['subagents', '子代理'],
  ['terminal', '终端'],
];
const button = (page, kind, zh) =>
  page.getByRole('button', {
    name: zh
      ? `${MODES.find(([name]) => name === kind)[1]}面板`
      : `${kind} panel`,
    exact: true,
  });
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
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    token: getComputedStyle(document.documentElement)
      .getPropertyValue('--bg')
      .trim(),
  }));
}
// The column takes its width over a frame or two after a mode opens: a picture waits for it.
async function settled(page) {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const width = await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve(
                document
                  .querySelector('.inspector-column')
                  ?.getBoundingClientRect().width ?? 0,
              ),
            ),
          ),
        ),
    );
    if (width === last) return;
    last = width;
  }
}
// Each mode in turn, with what makes it that mode, and a picture of it.
async function captureModes(page, locale, theme, width) {
  const zh = locale === 'zh';
  const titleGeometry = await page.locator('.topbar').evaluate((node) => ({
    titleRight: node
      .querySelector('.session-title button')
      .getBoundingClientRect().right,
    actionsLeft: node.querySelector('.topbar-actions').getBoundingClientRect()
      .left,
  }));
  assert.ok(
    titleGeometry.titleRight <= titleGeometry.actionsLeft + 1,
    `the session title does not run under the top bar's icons at ${width}px`,
  );
  for (const [kind] of MODES) {
    // The overview may be on already, as it is by default where there is room.
    if (
      kind !== 'overview' ||
      !(await page.locator('.overview-column').isVisible())
    )
      await button(page, kind, zh).click();
    if (kind === 'overview') {
      await page.locator('.overview-card').first().waitFor();
      assert.ok(
        (await page.locator('.overview-card').count()) >= 3,
        'the overview shows its cards',
      );
    } else {
      await page.locator('.work-drawer').waitFor({ state: 'visible' });
      assert.equal(
        await page.locator('.inspector-title').count(),
        0,
        `${kind}: no title bar over the drawer`,
      );
      const inspector = await page.locator('.inspector').evaluate((node) => ({
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
      }));
      assert.ok(
        inspector.scrollWidth <= inspector.width + 1,
        `${kind}: no horizontal overflow at ${width}px`,
      );
      if (kind === 'browser')
        assert.equal(
          await page
            .getByText(zh ? '未连接浏览器' : 'no browser attached', {
              exact: true,
            })
            .count(),
          1,
        );
      if (kind === 'changes') await page.locator('.changes-list').waitFor();
      if (kind === 'subagents')
        assert.ok(
          (await page.locator('.agent-row').count()) >= 1,
          'the subagent list has its rows',
        );
      if (kind === 'terminal') await page.locator('.term-tabbar').waitFor();
    }
    await settled(page);
    await page.screenshot({
      animations: 'disabled',
      path: `${output}/${locale}-${theme}-${width}-${kind}.png`,
    });
    // Pressing the button again closes what it opened; the overview stays, as it does.
    if (kind !== 'overview') await button(page, kind, zh).click();
  }
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
      assert.equal(
        await page
          .locator(
            '.developer-workbench,.layout-toggle,.developer-dock,.workbench-mobile-tabs',
          )
          .count(),
        0,
      );
      // The top bar: the overview, a divider, then the modes in their order, with the
      // number of subagents and of background commands at work on their buttons.
      const bar = await page
        .locator('.drawer-mode-toolbar')
        .evaluate((node) => ({
          names: [
            ...node.querySelectorAll(
              '.drawer-mode-button, .drawer-mode-divider',
            ),
          ].map((item) =>
            item.classList.contains('drawer-mode-divider')
              ? '|'
              : item.getAttribute('aria-label'),
          ),
          badges: [...node.querySelectorAll('.drawer-mode-badge')].map(
            (item) => item.textContent,
          ),
          // What they look like: a thin line in the border colour, and a filled pill in
          // the accent colour on the corner of its icon.
          divider: (() => {
            const item = node.querySelector('.drawer-mode-divider');
            const style = getComputedStyle(item);
            const box = item.getBoundingClientRect();
            return {
              width: Math.round(box.width),
              height: Math.round(box.height),
              painted: style.backgroundColor,
            };
          })(),
          pill: (() => {
            const item = node.querySelector('.drawer-mode-badge');
            const style = getComputedStyle(item);
            const box = item.getBoundingClientRect();
            const owner = item.parentElement.getBoundingClientRect();
            return {
              painted: style.backgroundColor,
              italic: style.fontStyle === 'italic',
              onCorner:
                box.right <= owner.right + 1 &&
                box.top <= owner.top + owner.height / 2,
            };
          })(),
          tokens: (() => {
            const probe = document.createElement('i');
            document.body.append(probe);
            probe.style.color = 'var(--border)';
            const border = getComputedStyle(probe).color;
            probe.style.color = 'var(--accent)';
            const accent = getComputedStyle(probe).color;
            probe.remove();
            return { border, accent };
          })(),
        }));
      assert.deepEqual(bar.names, [
        'overview panel',
        '|',
        'files panel',
        'changes panel',
        'browser panel',
        'subagents panel',
        'terminal panel',
      ]);
      assert.deepEqual(bar.badges, ['1', '1']);
      assert.deepEqual(
        { width: bar.divider.width, height: bar.divider.height },
        { width: 1, height: 16 },
      );
      assert.equal(bar.divider.painted, bar.tokens.border);
      assert.deepEqual(bar.pill, {
        painted: bar.tokens.accent,
        italic: false,
        onCorner: true,
      });
      const composer = page.locator('textarea[aria-label="message"]');
      const composerOwner = await composer.elementHandle();
      await composer.fill('Workspace shell preserved draft');
      await composer.evaluate((el) => el.setSelectionRange(4, 12));
      // A mode opens and closes with its button, and keeps what it holds while closed.
      await button(page, 'terminal', false).click();
      await page.locator('.term-tabbar').waitFor({ state: 'visible' });
      await button(page, 'terminal', false).click();
      assert.equal(
        await page.locator('.work-drawer').isVisible(),
        false,
        'a closed drawer is hidden',
      );
      assert.equal(
        await page.locator('.term-tabbar').count(),
        1,
        'closing the drawer keeps the terminal',
      );
      await composer.focus();
      await page.keyboard.press('ControlOrMeta+p');
      const search = page.getByRole('textbox', {
        name: 'global search',
        exact: true,
      });
      await search.fill('README.md');
      await search.press('Enter');
      await page.locator('.file-view').waitFor({ state: 'visible' });
      assert.equal(
        await composer.isVisible(),
        true,
        'the conversation stays rendered while the drawer shows the source',
      );
      assert.equal(await composer.count(), 1, 'the draft owner stays mounted');
      assert.equal(
        await page.locator('.work-drawer .file-view').count(),
        1,
        'the source belongs to the drawer',
      );
      assert.equal(
        await page
          .locator('#workbench-columns')
          .getAttribute('data-inspector-mode'),
        width > 1050 ? 'split' : 'overlay',
      );
      await page
        .getByRole('button', { name: 'close file', exact: true })
        .click();
      assert.equal(
        await composer.inputValue(),
        'Workspace shell preserved draft',
      );
      assert.deepEqual(
        await composer.evaluate((el) => [el.selectionStart, el.selectionEnd]),
        [4, 12],
      );
      await button(page, 'changes', false).click();
      await page.locator('.changes-mode').waitFor({ state: 'visible' });
      await settled(page);
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
      if (width <= 1050)
        assert.equal(await page.locator('.inspector-overlay').count(), 1);
      assert.equal(
        await composer.inputValue(),
        'Workspace shell preserved draft',
      );
      // The list the changes mode was left on stays while another mode is used: a
      // subagent opened in the meantime is not something to show here.
      const scope = (name) =>
        page
          .locator('.changes-mode')
          .getByRole('button', { name, exact: true });
      await scope('all uncommitted').click();
      await scope('this session').click();
      assert.equal(
        await scope('this session').getAttribute('aria-pressed'),
        'true',
      );
      await button(page, 'subagents', false).click();
      await page.locator('.agent-row').first().click();
      await page.locator('.agent-detail').waitFor();
      await page
        .getByRole('button', { name: 'close subagent', exact: true })
        .click();
      await page.locator('.agent-detail').waitFor({ state: 'detached' });
      await button(page, 'changes', false).click();
      await page.locator('.changes-mode').waitFor({ state: 'visible' });
      assert.equal(
        await scope('this session').getAttribute('aria-pressed'),
        'true',
        `opening a subagent leaves the changes mode on this session (${width}px)`,
      );
      // What is meant for the changes mode still reaches it: a file of the overview's
      // outputs opens there, chosen, in the list that has it.
      if (width > 1050) {
        await scope('all uncommitted').click();
        await button(page, 'changes', false).click();
        await page
          .locator('section.overview-card[aria-labelledby="overview-outputs"]')
          .locator('.overview-row')
          .filter({ hasText: 'connection.ts' })
          .click();
        await page.locator('.changes-mode').waitFor({ state: 'visible' });
        assert.equal(
          await page
            .locator('.changes-row[aria-current="true"]')
            .getAttribute('title'),
          'src/connection.ts',
        );
        assert.equal(
          await scope('this session').getAttribute('aria-pressed'),
          'true',
        );
      }
      await button(page, 'changes', false).click();
      await captureModes(page, 'en', theme, width);
      await page.evaluate(async () => {
        const { setLanguage } = await import('/src/i18n/index.ts');
        setLanguage('zh-CN');
      });
      assert.equal(
        await page.locator('.composer textarea').inputValue(),
        'Workspace shell preserved draft',
      );
      const themeAfter = await actualTheme(page, theme);
      assert.equal(
        await composerOwner.evaluate((el) => el.isConnected),
        true,
        'a change of language keeps the composer',
      );
      assert.equal(
        themeAfter.token,
        themeBefore.token,
        'a change of language keeps the palette',
      );
      await captureModes(page, 'zh', theme, width);
      assert.deepEqual(errors, []);
      receipts.push({
        theme,
        width,
        geometry,
        themeVerified: true,
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
