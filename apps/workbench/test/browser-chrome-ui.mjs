// The browser panel looks and behaves as Chrome does: tabs with icons and a close
// button each, back/forward/reload-or-stop, an address bar that shows the host and
// selects on focus, the ⋮ menu with zoom, find in page, and Chrome's shortcuts. The full
// application runs against a synthetic desktop host; what each control asks the main
// process for is recorded and checked.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('..', import.meta.url));
const out =
  process.env.CIRCLE_BROWSER_CHROME_EVIDENCE ||
  (process.env.CIRCLE_COMPONENT_UI_EVIDENCE
    ? process.env.CIRCLE_COMPONENT_UI_EVIDENCE + '/browser-chrome'
    : '/tmp/circle-browser-chrome-ui');
await mkdir(out, { recursive: true });
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
    ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
page.setDefaultTimeout(5000);
const errors = [];
const checks = [];
page.on('pageerror', (e) => errors.push(String(e)));
const ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhJkAAAAASUVORK5CYII=';
const PAGE_URL = 'https://docs.example.test/guide/start?lang=en';
try {
  await page.addInitScript(
    ({ ICON, PAGE_URL }) => {
      localStorage.setItem('circle.workbench.language', 'en');
      const state = {
        sessionId: 'browser:session1',
        url: PAGE_URL,
        title: 'Getting started with the example documentation site',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        zoom: 100,
        tab: 't1',
        tabs: [
          {
            id: 't1',
            url: PAGE_URL,
            title: 'Getting started with the example documentation site',
            favicon: ICON,
            active: true,
            loading: false,
          },
          {
            id: 't2',
            url: 'http://slow.example.test/',
            title: 'slow page',
            active: false,
            loading: true,
          },
        ],
      };
      const listeners = new Set();
      const keyListeners = new Set();
      const calls = [];
      const emit = () => {
        for (const listener of listeners)
          listener(JSON.parse(JSON.stringify(state)));
      };
      window.__browser = {
        calls,
        state,
        emit,
        set: (values) => {
          Object.assign(state, values);
          emit();
        },
        key: (action) => {
          for (const listener of keyListeners)
            listener({ sessionId: 'browser:session1', action });
        },
      };
      window.circleDesktop = new Proxy(
        {
          info: async () => ({
            frontendOnly: true,
            platform: 'darwin',
            language: 'en',
          }),
          onBrowserEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          onBrowserKey: (listener) => {
            keyListeners.add(listener);
            return () => keyListeners.delete(listener);
          },
          browserState: async (id) => {
            state.sessionId = 'browser:' + id;
            return JSON.parse(JSON.stringify(state));
          },
          browserNavigate: async (id, url) => {
            calls.push(['navigate', url]);
            if (!['back', 'forward', 'reload'].includes(url)) state.url = url;
            emit();
          },
          browserTabs: async (id, action, tab) => {
            calls.push(['tabs', action, tab ?? null]);
            emit();
          },
          browserCapture: async () => {
            calls.push(['capture']);
            return {
              dataUrl: ICON,
              sha256: 'capture-hash',
              observedAt: '2026-10-17T00:00:00Z',
            };
          },
          browserPage: async (id, action, value) => {
            calls.push(['page', action, value ?? null]);
            if (action === 'snapshot') return ICON;
            if (action === 'find')
              state.find = value.text
                ? {
                    text: value.text,
                    active: value.forward ? 2 : 1,
                    matches: 3,
                  }
                : undefined;
            if (action === 'find-stop') state.find = undefined;
            if (action === 'zoom')
              state.zoom =
                value === 'reset'
                  ? 100
                  : state.zoom + (value === 'in' ? 25 : -25);
            if (action !== 'keys') emit();
            return null;
          },
          browserDiagnostics: async (id, request) => {
            if (request.action === 'devtools') calls.push(['devtools']);
            return {
              state: {
                owner: 'circle',
                console: [],
                network: [],
                debugger: {
                  paused: false,
                  pauseEpoch: 1,
                  breakpoints: [],
                  stackFrames: [],
                },
              },
              stream: { epoch: 'e', sequence: 0 },
            };
          },
          onBrowserDiagnosticEvent: () => () => {},
        },
        {
          get: (target, key) =>
            key in target
              ? target[key]
              : () =>
                  key.toString().startsWith('on')
                    ? () => {}
                    : Promise.resolve(),
        },
      );
    },
    { ICON, PAGE_URL },
  );
  await page.clock.setFixedTime(new Date('2026-10-17T00:00:00Z'));
  const calls = () => page.evaluate(() => window.__browser.calls.slice());
  const clearCalls = () =>
    page.evaluate(() => window.__browser.calls.splice(0));
  const setState = (values) =>
    page.evaluate((values) => window.__browser.set(values), values);
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const without = (list, kind) =>
    list.filter((call) => !(call[0] === 'page' && call[1] === kind));
  const pageCalls = async () =>
    without(without(await calls(), 'keys'), 'snapshot');
  const viewportRect = () =>
    page.evaluate(() => {
      const r = document
        .querySelector('.native-browser-viewport')
        .getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    });
  const openBrowser = async (language = 'en') => {
    const toggle = page.getByRole('button', {
      name: language === 'en' ? 'browser panel' : '浏览器面板',
      exact: true,
    });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    await page.locator('.native-browser .browser-tab').first().waitFor();
  };
  await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
  await page.locator('.workbench').waitFor();
  await openBrowser();
  const address = page.getByRole('textbox', {
    name: 'browser address',
    exact: true,
  });

  // Tabs: an icon or a spinner, the title cut short with all of it as the tooltip,
  // and a close button on every tab
  const tabs = page.locator('.native-browser .browser-tab');
  assert.equal(await tabs.count(), 2);
  assert.equal(
    await page.getByRole('button', { name: 'close tab', exact: true }).count(),
    2,
  );
  assert.equal(
    await tabs.nth(0).getAttribute('title'),
    'Getting started with the example documentation site',
  );
  assert.equal(
    await tabs.nth(0).locator('.browser-tab-icon img').getAttribute('src'),
    ICON,
  );
  assert.equal(await tabs.nth(1).locator('.browser-tab-spinner').count(), 1);
  const titleOverflow = await tabs
    .nth(0)
    .locator('.browser-tab-text')
    .evaluate((node) => ({
      ellipsis: getComputedStyle(node).textOverflow,
      cut: node.scrollWidth > node.clientWidth,
    }));
  assert.deepEqual(titleOverflow, { ellipsis: 'ellipsis', cut: true });
  checks.push(
    'tabs show their icon or a spinner, a tooltip and a close button',
  );

  // The address bar: the host emphasised while not typing, the lock for https, and no
  // extra go button
  assert.equal(
    await page.locator('.browser-url-display b').innerText(),
    'docs.example.test',
  );
  assert.equal(await address.inputValue(), PAGE_URL);
  await page.getByTestId('browser-secure').waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: 'navigate browser', exact: true })
      .count(),
    0,
  );
  await address.click();
  assert.deepEqual(
    await address.evaluate((input) => [
      input.selectionStart,
      input.selectionEnd,
      document.activeElement === input,
    ]),
    [0, PAGE_URL.length, true],
  );
  assert.equal(await page.locator('.browser-url-display').count(), 0);
  await address.press('Backspace');
  await address.pressSequentially('typed draft');
  assert.equal(await address.inputValue(), 'typed draft');
  await address.press('Escape');
  assert.equal(await address.inputValue(), PAGE_URL);
  assert.equal(
    await address.evaluate((input) => document.activeElement === input),
    false,
  );
  // Escape in the address bar never reaches the conversation's stop key
  assert.deepEqual(
    (await calls()).filter((call) => call[0] !== 'page'),
    [],
  );
  await clearCalls();
  await address.fill('example.test/next');
  await address.press('Enter');
  await page.waitForFunction(() =>
    window.__browser.calls.some((call) => call[0] === 'navigate'),
  );
  assert.deepEqual(
    (await calls()).find((call) => call[0] === 'navigate'),
    ['navigate', 'example.test/next'],
  );
  await setState({ url: PAGE_URL });
  checks.push(
    'the address shows the host, selects all on focus, Escape restores it and Enter navigates',
  );

  // http is not secure, as Chrome says
  await setState({ url: 'http://plain.example.test/' });
  await page.getByTestId('browser-http').waitFor();
  await setState({ url: PAGE_URL });
  await page.getByTestId('browser-secure').waitFor();

  // Middle-click closes a tab; the close button closes it too
  await clearCalls();
  await tabs.nth(1).locator('.browser-tab-title').click({ button: 'middle' });
  await page.waitForFunction(() => window.__browser.calls.length > 0);
  assert.deepEqual(
    (await pageCalls()).filter((call) => call[0] === 'tabs'),
    [['tabs', 'close', 't2']],
  );
  checks.push('middle-click closes a tab');

  // Reload turns into stop while the page loads
  await setState({ loading: true });
  const stop = page.getByRole('button', { name: 'stop loading', exact: true });
  await stop.waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: 'reload page', exact: true })
      .count(),
    0,
  );
  await clearCalls();
  await stop.click();
  await page.waitForFunction(() =>
    window.__browser.calls.some((call) => call[1] === 'stop'),
  );
  await setState({ loading: false });
  await page
    .getByRole('button', { name: 'reload page', exact: true })
    .waitFor();
  checks.push('reload becomes stop while loading');

  // The ⋮ menu, over a picture of the page: the page keeps its size
  const before = await viewportRect();
  await clearCalls();
  await page.getByRole('button', { name: 'browser menu', exact: true }).click();
  const menu = page.getByRole('menu');
  await menu.waitFor();
  const items = await menu
    .getByRole('menuitem')
    .evaluateAll((nodes) =>
      nodes.map(
        (node) => node.getAttribute('aria-label') || node.textContent.trim(),
      ),
    );
  assert.deepEqual(items, [
    'new tab⌘+T',
    'zoom out',
    'reset zoom',
    'zoom in',
    'find…⌘+F',
    'take screenshot',
    'full view',
    'developer tools⌥+⌘+I',
    'close tab⌘+W',
  ]);
  assert.equal(await menu.getByText('100%', { exact: true }).count(), 1);
  assert.ok(
    (await calls()).some(
      (call) => call[0] === 'page' && call[1] === 'snapshot',
    ),
    'the page is pictured before the menu covers it',
  );
  await page.locator('.native-browser-viewport .browser-frozen').waitFor();
  assert.deepEqual(await viewportRect(), before);
  await page.screenshot({ path: out + '/menu-en-light-1400.png' });
  await menu.getByRole('menuitem', { name: 'zoom in', exact: true }).click();
  await menu.getByText('125%', { exact: true }).waitFor();
  assert.equal(await menu.isVisible(), true, 'zoom keeps the menu open');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await page
    .locator('.native-browser-viewport .browser-frozen')
    .waitFor({ state: 'detached' });
  // The zoom shows in the address bar while it is not 100%, as in Chrome
  const indicator = page.getByRole('button', {
    name: 'zoom 125%',
    exact: true,
  });
  await indicator.waitFor();
  await page.screenshot({ path: out + '/zoom-indicator-en-light-1400.png' });
  await indicator.click();
  await page.getByRole('menuitem', { name: 'reset zoom', exact: true }).click();
  await indicator.waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
  assert.deepEqual(
    (await pageCalls()).filter((call) => call[1] === 'zoom'),
    [
      ['page', 'zoom', 'in'],
      ['page', 'zoom', 'reset'],
    ],
  );
  // Take screenshot and developer tools are the old header actions
  await clearCalls();
  await page.getByRole('button', { name: 'browser menu', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'take screenshot', exact: true })
    .click();
  await page.getByText('captured observation', { exact: true }).waitFor();
  // Developer tools take no room until asked for, then dock under the page as
  // Chrome's do, and close with their own button or the same shortcut
  assert.equal(await page.locator('.browser-diagnostics').count(), 0);
  assert.equal(
    await page
      .getByRole('button', { name: 'page diagnostics', exact: true })
      .count(),
    0,
  );
  const closedTools = await viewportRect();
  await page.getByRole('button', { name: 'browser menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'developer tools' }).click();
  const docked = page.locator('.browser-diagnostics');
  await docked.getByRole('heading', { name: 'developer tools' }).waitFor();
  await settle();
  const openTools = await viewportRect();
  assert.ok(openTools[3] < closedTools[3], 'docked tools take the page bottom');
  assert.deepEqual(openTools.slice(0, 3), closedTools.slice(0, 3));
  await page.screenshot({ path: out + '/devtools-en-light-1400.png' });
  await docked
    .getByRole('button', { name: 'open developer tools', exact: true })
    .click();
  await page.waitForFunction(() =>
    window.__browser.calls.some((call) => call[0] === 'devtools'),
  );
  await docked
    .getByRole('button', { name: 'close developer tools', exact: true })
    .click();
  await docked.waitFor({ state: 'detached' });
  await settle();
  assert.deepEqual(await viewportRect(), closedTools);
  await page.getByRole('button', { name: 'go back', exact: true }).focus();
  await page.keyboard.press('Meta+Alt+KeyI');
  await docked.waitFor();
  await page.getByRole('button', { name: 'go back', exact: true }).focus();
  await page.keyboard.press('F12');
  await docked.waitFor({ state: 'detached' });
  // Inspect on the page opens them through the main process
  await page.evaluate(() => window.__browser.key('inspect'));
  await docked.waitFor();
  await page.evaluate(() => window.__browser.key('devtools'));
  await docked.waitFor({ state: 'detached' });
  assert.deepEqual(await viewportRect(), closedTools);
  assert.equal(
    await page
      .getByRole('button', { name: 'capture browser', exact: true })
      .count(),
    0,
    'the capture button moved into the menu',
  );
  checks.push(
    'the ⋮ menu zooms, captures and opens developer tools over a still of the page',
  );

  // Find in page: ⌘F, n of m, Enter and shift+Enter, Escape; the page keeps its size
  await address.focus();
  await clearCalls();
  const beforeFind = await viewportRect();
  await page.keyboard.press('Meta+f');
  const find = page.getByRole('textbox', { name: 'find in page', exact: true });
  await find.waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'find in page',
  );
  assert.deepEqual(await viewportRect(), beforeFind);
  await find.pressSequentially('needle');
  await page.getByTestId('browser-find-count').getByText('2/3').waitFor();
  await find.press('Shift+Enter');
  await page.getByTestId('browser-find-count').getByText('1/3').waitFor();
  await find.press('Enter');
  await page.getByTestId('browser-find-count').getByText('2/3').waitFor();
  const findBox = await page.locator('.browser-find').boundingBox();
  const toolbar = await page.locator('.browser-address').boundingBox();
  assert.ok(
    findBox.y >= toolbar.y &&
      findBox.y + findBox.height <= toolbar.y + toolbar.height,
    'the find bar stays in the toolbar row, off the page',
  );
  await page.screenshot({ path: out + '/find-en-light-1400.png' });
  await find.press('Escape');
  await find.waitFor({ state: 'detached' });
  const finds = (await pageCalls()).filter((call) =>
    ['find', 'find-stop'].includes(call[1]),
  );
  assert.deepEqual(finds.at(-1), ['page', 'find-stop', null]);
  assert.deepEqual(finds.filter((call) => call[1] === 'find').slice(-2), [
    ['page', 'find', { text: 'needle', forward: false }],
    ['page', 'find', { text: 'needle', forward: true }],
  ]);
  checks.push(
    'find in page counts matches, steps both ways and closes on Escape',
  );

  // Chrome's shortcuts while the panel has the keyboard
  await page.getByRole('button', { name: 'go back', exact: true }).focus();
  await clearCalls();
  for (const key of [
    'Meta+r',
    'Meta+[',
    'Control+Tab',
    'Control+Shift+Tab',
    'Meta+=',
    'Meta+-',
    'Meta+0',
    'Meta+t',
  ])
    await page.keyboard.press(key);
  await page.waitForFunction(() =>
    window.__browser.calls.some((call) => call[1] === 'new'),
  );
  await settle();
  assert.deepEqual(
    (await pageCalls()).filter((call) => call[0] !== 'devtools'),
    [
      ['navigate', 'reload'],
      ['navigate', 'back'],
      ['page', 'tab', 'next'],
      ['page', 'tab', 'previous'],
      ['page', 'zoom', 'in'],
      ['page', 'zoom', 'out'],
      ['page', 'zoom', 'reset'],
      ['tabs', 'new', null],
    ],
  );
  // A new tab puts the keyboard in its address bar, as Chrome does
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'browser address',
  );
  await page.getByRole('button', { name: 'go back', exact: true }).focus();
  await page.keyboard.press('Meta+l');
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'browser address',
  );
  await clearCalls();
  await page.keyboard.press('Meta+w');
  await page.waitForFunction(() =>
    window.__browser.calls.some((call) => call[1] === 'close'),
  );
  assert.deepEqual(
    (await pageCalls()).filter((call) => call[0] === 'tabs'),
    [['tabs', 'close', 't1']],
  );
  // The panel tells the main process it has the keyboard, and when it loses it
  const composer = page.getByRole('textbox', { name: 'message', exact: true });
  await clearCalls();
  await composer.focus();
  await page.waitForFunction(() =>
    window.__browser.calls.some(
      (call) => call[1] === 'keys' && call[2] === false,
    ),
  );
  // Outside the panel the keys stay the app's
  await clearCalls();
  await page.keyboard.press('Meta+l');
  await page.keyboard.press('Meta+w');
  await settle();
  assert.deepEqual(await pageCalls(), []);
  assert.notEqual(
    await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-label'),
    ),
    'browser address',
  );
  checks.push(
    "Chrome's shortcuts work in the panel and leave the rest of the app alone",
  );

  // Keys pressed in the page arrive from the main process
  await page.evaluate(() => window.__browser.key('find'));
  await find.waitFor();
  await find.press('Escape');
  await page.evaluate(() => window.__browser.key('address'));
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'browser address',
  );
  await clearCalls();
  await page.evaluate(() => window.__browser.key('zoom-in'));
  await page.waitForFunction(() =>
    window.__browser.calls.some((call) => call[1] === 'zoom'),
  );
  await page.evaluate(() => window.__browser.set({ zoom: 100 }));
  checks.push('shortcuts from the page run as the panel buttons do');

  // Appearance: light and dark, English and Chinese, a wide and a narrow panel
  const shots = [];
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      // The split panel beside the conversation, and the panel in full view
      for (const mode of ['split', 'full']) {
        await page.setViewportSize({
          width: mode === 'split' ? 1500 : 1060,
          height: 820,
        });
        await page.evaluate(
          async ({ language, theme }) => {
            (await import('/src/i18n/index.ts')).setLanguage(language);
            (await import('/src/theme.ts')).applyTheme(theme);
          },
          { language, theme },
        );
        await page.evaluate(() => document.fonts.ready);
        await openBrowser(language);
        const wholeButton = page.getByRole('button', {
          name: language === 'en' ? 'full view' : '完整视图',
          exact: true,
        });
        if (mode === 'full') await wholeButton.click();
        await settle();
        const panel = await page.locator('.inspector').boundingBox();
        const name = `${language}-${theme}-${Math.round(panel.width)}`;
        await page.locator('.inspector').screenshot({
          path: `${out}/panel-${name}.png`,
        });
        await page
          .getByRole('button', {
            name: language === 'en' ? 'browser menu' : '浏览器菜单',
            exact: true,
          })
          .click();
        await page.getByRole('menu').waitFor();
        await page.screenshot({ path: `${out}/panel-${name}-menu.png` });
        await page.keyboard.press('Escape');
        await page.getByRole('menu').waitFor({ state: 'detached' });
        await page.evaluate(() => window.__browser.key('find'));
        await page.locator('.browser-find input').waitFor();
        await page.locator('.browser-find input').fill('needle');
        await page.getByTestId('browser-find-count').getByText('2/3').waitFor();
        await page.locator('.inspector').screenshot({
          path: `${out}/panel-${name}-find.png`,
        });
        await page.locator('.browser-find input').press('Escape');
        // Nothing in the toolbar overlaps anything else, nor leaves the panel
        const overlap = await page.evaluate(() => {
          const boxes = [
            ...document.querySelectorAll(
              '.native-browser .browser-address > *, .native-browser .browser-url > *',
            ),
          ]
            .filter((node) => !node.classList.contains('browser-url'))
            .map((node) => node.getBoundingClientRect());
          const panel = document
            .querySelector('.native-browser')
            .getBoundingClientRect();
          const out = boxes.some(
            (box) =>
              box.left < panel.left - 0.5 || box.right > panel.right + 0.5,
          );
          let crossing = false;
          for (const [i, a] of boxes.entries())
            for (const b of boxes.slice(i + 1))
              if (
                a.width &&
                b.width &&
                a.left < b.right - 0.5 &&
                b.left < a.right - 0.5 &&
                a.top < b.bottom - 0.5 &&
                b.top < a.bottom - 0.5 &&
                !(
                  (a.left >= b.left && a.right <= b.right) ||
                  (b.left >= a.left && b.right <= a.right)
                )
              )
                crossing = true;
          return { out, crossing };
        });
        assert.deepEqual(overlap, { out: false, crossing: false }, name);
        if (mode === 'full')
          await page
            .getByRole('button', {
              name: language === 'en' ? 'exit full view' : '退出完整视图',
              exact: true,
            })
            .click();
        shots.push({ name, width: Math.round(panel.width) });
      }
  checks.push({ appearance: shots });
  assert.deepEqual(errors, []);
  console.log('PASS browser panel behaves as Chrome does');
} catch (error) {
  await page.screenshot({ path: out + '/failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await server.close();
  await writeFile(
    out + '/receipt.json',
    JSON.stringify(
      {
        kind: 'full App with a synthetic native browser host',
        checks,
        errors,
      },
      null,
      2,
    ),
  );
}
