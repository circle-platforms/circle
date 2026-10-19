// The browser mode of the full application, against a synthetic desktop host: the page
// fills the drawer to its edges at every width (beside the conversation, or over it in a
// narrow window), the ring says who has the browser without moving the page, and a page
// screenshot you take lands in the message box only while it still shows the page it was
// taken of. The appearance baselines are this suite's screenshots.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { settledLayout } from './helpers/settled-layout.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const out =
  process.env.CIRCLE_BROWSER_SHELL_EVIDENCE ||
  '/tmp/circle-original-browser-shell-ui';
await mkdir(out, { recursive: true });
// One-pixel pictures of different colours. Each capture the host answers gets its own,
// so the attachment that lands says which capture it came from.
const png = (red, green, blue) => {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue]))),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
};
const pictures = Array.from({ length: 8 }, (_, index) =>
  png(index * 30, 90, 240 - index * 30),
);
assert.equal(new Set(pictures).size, pictures.length);
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
const page = await browser.newPage({ viewport: { width: 1400, height: 684 } });
page.setDefaultTimeout(5000);
const errors = [],
  checks = [];
page.on('pageerror', (e) => errors.push(String(e)));
let sawClosedTools = false;
try {
  await page.addInitScript((pictures) => {
    localStorage.setItem('circle.workbench.language', 'en');
    const state = {
      sessionId: 'browser:session1',
      url: 'http://localhost/fixture',
      title: 'synthetic page',
      tab: 't1',
      tabs: [
        { id: 't1', url: 'http://localhost/fixture', title: 'synthetic page' },
      ],
    };
    const listeners = new Set();
    const captures = [];
    const calls = [];
    const emit = () => {
      for (const listener of listeners) listener({ ...state });
    };
    window.__browserCaptureFixture = {
      calls,
      count: () => captures.length,
      // The desktop answers with the page as it was when the picture was asked for, and
      // the picture. The time is this machine's, as the attachment's name shows it.
      resolve: (index, hours, minutes) =>
        captures[index].resolve({
          ...captures[index].page,
          dataUrl: pictures[index],
          sha256: 'capture-' + index,
          observedAt: new Date(2026, 9, 16, hours, minutes).toISOString(),
          attempts: 1,
          retryErrors: [],
        }),
      reject: (index) => captures[index].reject(Error('old capture failed')),
      tabs: () => {
        state.tabs = [
          {
            id: 't1',
            title: 'synthetic page',
            url: 'http://localhost/fixture',
          },
          { id: 't2', title: 'other fixture', url: 'http://localhost/other' },
        ];
        emit();
      },
      drive: (driving) => {
        state.operating = driving;
        state.control = driving ? 'agent' : 'shared';
        emit();
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
        browserState: async (id) => {
          state.sessionId = 'browser:' + id;
          return { ...state };
        },
        browserCapture: () =>
          new Promise((resolve, reject) =>
            captures.push({
              resolve,
              reject,
              page: JSON.parse(JSON.stringify(state)),
            }),
          ),
        browserControl: async (id, action) => {
          calls.push(['control', id, action]);
        },
        browserNavigate: async (id, url) => {
          state.url = url;
          emit();
        },
        browserTabs: async (id, action, tab) => {
          state.tab = tab;
          state.url = state.tabs.find((item) => item.id === tab).url;
          emit();
        },
        browserDiagnostics: async () => ({
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
        }),
        onBrowserDiagnosticEvent: () => () => {},
        // No mode of this window is in a window of its own.
        popouts: async () => [],
      },
      {
        get: (target, key) =>
          key in target
            ? target[key]
            : (...args) =>
                key.toString().startsWith('on') ? () => {} : Promise.resolve(),
      },
    );
  }, pictures);
  await page.clock.setFixedTime(new Date('2026-10-16T00:00:00Z'));
  // The page opens 1400 px wide.
  let previousWidth = 1400;
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['dark', 'light'])
      for (const width of [1400, 760, 290])
        for (const height of [684, 970]) {
          await page.setViewportSize({ width, height });
          await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
          await page.locator('.workbench').waitFor();
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          await page.evaluate(
            async ({ language, theme }) => {
              (await import('/src/i18n/index.ts')).setLanguage(language);
              (await import('/src/theme.ts')).applyTheme(theme);
            },
            { language, theme },
          );
          await page.evaluate(() => document.fonts.ready);
          // At most 1050 px wide the app closes the drawer (useNarrow in App.tsx), and
          // the drawer and the overview then lie over the conversation. The close is a
          // render after the narrow layout's, and a slow runner reports the new width
          // to the page late, so the drawer can read as open here and close a moment
          // later. Wait for this width's layout and, after crossing into narrow, for
          // that close, before reading or opening the drawer.
          const narrow = width <= 1050;
          await page.waitForFunction(
            (narrow) =>
              document
                .querySelector(
                  '#workbench-columns > #inspector .inspector-column',
                )
                ?.classList.contains('inspector-overlay') === narrow,
            narrow,
          );
          if (narrow && previousWidth > 1050)
            await page
              .locator("#workbench-columns[data-inspector-mode='closed']")
              .waitFor({ state: 'attached' });
          previousWidth = width;
          const browserPanel = page.getByRole('button', {
            name: language === 'en' ? 'browser panel' : '浏览器面板',
            exact: true,
          });
          if ((await browserPanel.getAttribute('aria-pressed')) !== 'true')
            await browserPanel.click();
          await page
            .getByRole('button', {
              name: language === 'en' ? 'browser menu' : '浏览器菜单',
              exact: true,
            })
            .waitFor();
          // Beside the conversation in a wide window, over it in a narrow one
          await page
            .locator(
              `#workbench-columns[data-inspector-mode='${narrow ? 'overlay' : 'split'}']`,
            )
            .waitFor({ state: 'attached' });
          // Circle does not dock its own developer tools under the page.
          if (!sawClosedTools) {
            assert.equal(await page.locator('.browser-diagnostics').count(), 0);
            sawClosedTools = true;
          }
          const iconSizes = await page
            .locator('.native-browser .icon-button')
            .evaluateAll((buttons) =>
              buttons
                .filter((button) => button.getClientRects().length)
                .map((button) => {
                  const box = button.getBoundingClientRect();
                  return [
                    box.width,
                    box.height,
                    getComputedStyle(button).borderRadius,
                  ];
                }),
            );
          for (const size of iconSizes) assert.deepEqual(size, [26, 26, '6px']);
          // However narrow the field, the address fits it: the path gives way, then the
          // host with an ellipsis, and nothing runs past the field's edge.
          const address = await page
            .locator('.browser-url-display')
            .evaluate((node) => {
              const host = node.querySelector('b');
              return {
                fits: node.scrollWidth <= node.clientWidth + 1,
                host: host && getComputedStyle(host).textOverflow,
              };
            });
          assert.ok(address.fits, `the address fits its field at ${width}px`);
          assert.equal(address.host, 'ellipsis');
          // Take over shows only while Circle operates the page.
          assert.equal(
            await page
              .locator('.native-browser .browser-address')
              .getByRole('button', {
                name: language === 'en' ? 'take over' : '接管',
                exact: true,
              })
              .count(),
            0,
          );
          for (const expanded of [false]) {
            assert.equal(await page.locator('.browser-diagnostics').count(), 0);
            // Locale changes may load CJK fonts after React commits. Capture the
            // browser beside a settled conversation at its explicit end position.
            await page.evaluate(async () => {
              await document.fonts.ready;
              const transcript = document.querySelector('.transcript');
              if (transcript) transcript.scrollTop = transcript.scrollHeight;
            });
            await page.mouse.move(0, 0);
            await settledLayout(page);
            const geometry = await page.evaluate(() => {
              const selectors = [
                '.inspector-body',
                '.inspector-resource-view[data-inspector-resource=browser]:not([hidden])',
                '.native-browser',
                '.native-browser-viewport',
                '.native-browser-frame',
                '.browser-diagnostics',
              ];
              return selectors.map((selector) => {
                const node = document.querySelector(selector);
                if (!node) return { selector, missing: true };
                const r = node.getBoundingClientRect(),
                  s = getComputedStyle(node);
                return {
                  selector,
                  top: r.top,
                  bottom: r.bottom,
                  height: r.height,
                  paddingBottom: Number.parseFloat(s.paddingBottom),
                  cssheight: s.height,
                  display: s.display,
                  flex: s.flex,
                };
              });
            });
            assert.equal(
              await page.locator('html').getAttribute('data-theme'),
              theme,
            );
            await page.screenshot({
              animations: 'disabled',
              path:
                out +
                `/${language}-${theme}-${width}-${height}-${expanded ? 'expanded' : 'closed'}.png`,
            });
            const [body, wrapper, native, viewport, frame, docked] = geometry;
            assert.equal(docked.missing, true);
            assert.equal(
              await page.locator('.native-browser-footer').count(),
              0,
              'the status line under the page is gone',
            );
            assert.equal(
              body.paddingBottom,
              0,
              'the browser fills the inspector to its edges, as in Claude',
            );
            assert(
              Math.abs(wrapper.bottom - (body.bottom - body.paddingBottom)) <=
                1,
              'browser wrapper fills original inspector content box',
            );
            assert(
              Math.abs(native.bottom - wrapper.bottom) <= 1,
              'native browser fills its bounded parent',
            );
            assert(
              Math.abs(frame.bottom - native.bottom) <= 1,
              'the page frame ends at the browser bottom',
            );
            assert(
              viewport.top >= frame.top && viewport.bottom <= frame.bottom + 1,
              'the page sits inside its frame',
            );
            const ring = await page.evaluate(() => {
              const node = document.querySelector('.native-browser-frame');
              const style = getComputedStyle(node);
              return {
                driving: node.classList.contains('driving'),
                border: style.borderTopWidth,
                label: node.getAttribute('aria-label'),
              };
            });
            assert.equal(ring.driving, false);
            assert.equal(ring.border, '1px');
            assert.equal(ring.label, null);
            assert(
              viewport.height >= 80,
              'guest retains usable actual viewport',
            );
            assert(frame.bottom <= body.bottom, 'the page frame stays visible');
            assert(
              frame.bottom <= body.bottom,
              'the page frame stays inside the inspector',
            );
            assert(
              body.bottom - frame.bottom <= 32,
              'do not weaken native blank-under-panel acceptance',
            );
            checks.push({ width, height, expanded, geometry });
          }
        }
  // Circle driving the page is a ring, in both languages and both themes, with take over
  // in the address row while it lasts.
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width: 1400, height: 684 });
      await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
      await page.locator('.workbench').waitFor();
      await page.evaluate(
        async ({ language, theme }) => {
          (await import('/src/i18n/index.ts')).setLanguage(language);
          (await import('/src/theme.ts')).applyTheme(theme);
          window.__browserCaptureFixture.drive(true);
        },
        { language, theme },
      );
      const toggle = page.getByRole('button', {
        name: language === 'en' ? 'browser panel' : '浏览器面板',
        exact: true,
      });
      if ((await toggle.getAttribute('aria-pressed')) !== 'true')
        await toggle.click();
      await page.evaluate(() => window.__browserCaptureFixture.drive(true));
      const frame = page.getByTestId('browser-operating');
      await frame.waitFor();
      const expected =
        language === 'en' ? 'Circle is operating' : 'Circle 正在操作';
      assert.equal(await frame.getAttribute('aria-label'), expected);
      assert.equal(await frame.getAttribute('title'), expected);
      const ring = await frame.evaluate((node) => {
        const view = document
          .querySelector('.native-browser-viewport')
          .getBoundingClientRect();
        const box = node.getBoundingClientRect();
        // The accent the theme gives, as the ring would paint it
        const probe = document.createElement('i');
        probe.style.color = 'var(--accent)';
        node.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return {
          driving: node.classList.contains('driving'),
          border: getComputedStyle(node).borderTopWidth,
          padding: getComputedStyle(node).paddingTop,
          shadow: getComputedStyle(node).boxShadow,
          color: getComputedStyle(node).borderTopColor,
          accent,
          inset: view.top - box.top,
        };
      });
      assert.equal(ring.driving, true);
      assert.equal(ring.border, '1px');
      assert.equal(ring.padding, '3px');
      assert.notEqual(ring.shadow, 'none');
      assert.equal(ring.color, ring.accent, 'the driving ring is the accent');
      assert(
        ring.inset >= 3,
        'the page covers the driving ring: ' + JSON.stringify(ring),
      );
      const takeOver = page
        .locator('.native-browser .browser-address')
        .getByRole('button', {
          name: language === 'en' ? 'take over' : '接管',
          exact: true,
        });
      await takeOver.waitFor();
      await page.mouse.move(0, 0);
      await settledLayout(page);
      await page.screenshot({
        animations: 'disabled',
        path: out + `/${language}-${theme}-1400-684-driving.png`,
      });
      // After the last picture: take over asks the desktop for the browser
      if (language === 'zh-CN' && theme === 'light') {
        await takeOver.click();
        await page.waitForFunction(() =>
          window.__browserCaptureFixture.calls.some(
            (call) => call[0] === 'control',
          ),
        );
        assert.deepEqual(
          await page.evaluate(() => window.__browserCaptureFixture.calls),
          [['control', 'session1', 'take']],
        );
        checks.push({ scenario: 'take over asks for the browser' });
      }
    }
  await page.setViewportSize({ width: 1400, height: 970 });
  await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
  await page.evaluate(async () =>
    (await import('/src/i18n/index.ts')).setLanguage('en'),
  );
  const openBrowser = async () => {
    const toggle = page.getByRole('button', {
      name: 'browser panel',
      exact: true,
    });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    await page
      .getByRole('button', { name: 'browser menu', exact: true })
      .waitFor();
  };
  await openBrowser();
  // Take page screenshot lives in the browser's ⋮ menu, as Chrome keeps its tools there.
  // The picture goes into the message box as an attachment; the panel shows nothing of it.
  const capture = {
    click: async () => {
      await page
        .getByRole('button', { name: 'browser menu', exact: true })
        .click();
      await page
        .getByRole('menuitem', { name: 'take page screenshot', exact: true })
        .click();
      await page.getByRole('menu').waitFor({ state: 'detached' });
    },
  };
  const waitCaptureCount = async (count) =>
    page.waitForFunction(
      (count) => window.__browserCaptureFixture.count() === count,
      count,
    );
  const settle = async () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  // What the conversations keep: every attachment of every session, as stored
  const stored = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('circle.workbench.preview.v1');
      return (raw ? JSON.parse(raw).sessions : []).flatMap((session) =>
        session.attachments.map((file) => ({
          session: session.id,
          name: file.name,
          kind: file.kind,
          mime: file.mime,
          content: file.content,
        })),
      );
    });
  // What the message box shows
  const chips = () =>
    page
      .locator('.composer .attachment-strip .file-chip > button:first-child')
      .allInnerTexts();
  const address = page.getByRole('textbox', {
    name: 'browser address',
    exact: true,
  });
  await capture.click();
  await waitCaptureCount(1);
  await address.fill('http://localhost/new-page');
  await address.press('Enter');
  await page.evaluate(() => window.__browserCaptureFixture.resolve(0, 12, 0));
  await settle();
  assert.deepEqual(
    await stored(),
    [],
    'late pre-navigation capture cannot reappear on another page',
  );
  assert.deepEqual(await chips(), []);
  checks.push({
    scenario: 'late navigation capture rejected',
    status: 'passed',
  });
  await page.evaluate(() => window.__browserCaptureFixture.tabs());
  await capture.click();
  await waitCaptureCount(2);
  await page
    .getByRole('button', { name: 'other fixture', exact: true })
    .click();
  await page.evaluate(() => window.__browserCaptureFixture.resolve(1, 12, 1));
  await settle();
  assert.deepEqual(await stored(), [], 'late old-tab capture cannot reappear');
  assert.deepEqual(await chips(), []);
  checks.push({ scenario: 'late tab capture rejected', status: 'passed' });
  await capture.click();
  await waitCaptureCount(3);
  await page
    .locator('.sidebar [data-row-key="recent:session2"] a.session-link')
    .click();
  // The top bar and the browser render the same conversation
  await page
    .locator('.session-title', { hasText: 'Review the request lifecycle' })
    .waitFor();
  await openBrowser();
  await page.evaluate(() => window.__browserCaptureFixture.resolve(2, 12, 2));
  await settle();
  assert.deepEqual(
    await stored(),
    [],
    'late old-session capture cannot reappear',
  );
  assert.deepEqual(await chips(), []);
  checks.push({ scenario: 'late session capture rejected', status: 'passed' });
  await capture.click();
  await capture.click();
  await waitCaptureCount(5);
  await page.evaluate(() => window.__browserCaptureFixture.resolve(4, 12, 4));
  // What the desktop returned is what lands, named for the site and the time
  const latest = {
    session: 'session2',
    name: 'localhost 12:04.png',
    kind: 'image',
    mime: 'image/png',
    content: pictures[4],
  };
  await page
    .locator('.composer .attachment-strip .file-chip', {
      hasText: latest.name,
    })
    .waitFor();
  assert.deepEqual(await stored(), [latest]);
  await page.evaluate(() => window.__browserCaptureFixture.resolve(3, 12, 3));
  await settle();
  assert.deepEqual(
    await stored(),
    [latest],
    'earlier capture cannot replace latest result',
  );
  assert.deepEqual(await chips(), [latest.name]);
  checks.push({
    scenario: 'capture generation preserves latest response',
    status: 'passed',
  });
  await capture.click();
  await waitCaptureCount(6);
  await address.fill('http://localhost/last');
  await address.press('Enter');
  await page.evaluate(() => window.__browserCaptureFixture.reject(5));
  await settle();
  assert.equal(
    await page.getByText('browser capture failed', { exact: true }).count(),
    0,
    'obsolete capture failure cannot notify a new page',
  );
  // A capture that fails while its page still shows does say so
  await capture.click();
  await waitCaptureCount(7);
  await page.evaluate(() => window.__browserCaptureFixture.reject(6));
  await page
    .getByRole('status')
    .filter({ hasText: 'browser capture failed' })
    .waitFor();
  assert.deepEqual(await stored(), [latest]);
  checks.push({ scenario: 'obsolete capture error ignored', status: 'passed' });
  // Thickening the ring must not move or resize the page, nor may what shows with it. A
  // screenshot's coordinates are taken before Circle clicks.
  await page.setViewportSize({ width: 1400, height: 684 });
  await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
  await page.locator('.workbench').waitFor();
  await page.evaluate(async () => {
    await (await import('/src/i18n/index.ts')).setLanguage('en');
    window.__browserCaptureFixture.drive(false);
  });
  await openBrowser();
  await page.getByTestId('browser-frame').waitFor();
  await settledLayout(page);
  const pageBox = () =>
    page.evaluate(() => {
      const frame = document
        .querySelector('.native-browser-frame')
        .getBoundingClientRect();
      const view = document
        .querySelector('.native-browser-viewport')
        .getBoundingClientRect();
      const round = (value) => Math.round(value);
      return {
        x: round(view.x),
        y: round(view.y),
        w: round(view.width),
        h: round(view.height),
        inset: round(view.x - frame.x),
      };
    });
  const idlePage = await pageBox();
  assert.ok(idlePage.w > 50 && idlePage.h > 50, 'the page has a box');
  await page.evaluate(() => window.__browserCaptureFixture.drive(true));
  await page.getByTestId('browser-operating').waitFor();
  await settledLayout(page);
  const drivingPage = await pageBox();
  assert.deepEqual(
    drivingPage,
    idlePage,
    'the control ring resized the page: ' +
      JSON.stringify({ idle: idlePage, driving: drivingPage }),
  );
  await page.evaluate(() => window.__browserCaptureFixture.drive(false));
  await page.getByTestId('browser-frame').waitFor();
  await settledLayout(page);
  const restoredPage = await pageBox();
  assert.deepEqual(
    restoredPage,
    idlePage,
    'giving the browser back resized the page: ' +
      JSON.stringify({ idle: idlePage, restored: restoredPage }),
  );
  checks.push({
    scenario: 'the control ring does not resize the page',
    status: 'passed',
  });
  assert.deepEqual(errors, [], 'full application renders without page errors');
  console.log(
    'PASS original full-app browser inspector bounds closed and expanded',
  );
} catch (error) {
  await page.screenshot({ path: out + '/failure.png' });
  throw error;
} finally {
  await browser.close();
  await server.close();
  await writeFile(
    out + '/receipt.json',
    JSON.stringify(
      {
        kind: 'actual full App with synthetic native browser host; no Electron foreground',
        checks,
        errors,
      },
      null,
      2,
    ),
  );
}
