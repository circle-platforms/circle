import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('..', import.meta.url));
const out =
  process.env.CIRCLE_BROWSER_SHELL_EVIDENCE ||
  '/tmp/circle-original-browser-shell-ui';
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
const page = await browser.newPage({ viewport: { width: 1400, height: 684 } });
page.setDefaultTimeout(5000);
const errors = [],
  checks = [];
page.on('pageerror', (e) => errors.push(String(e)));
try {
  await page.addInitScript(() => {
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
    window.circleDesktop = new Proxy(
      {
        info: async () => ({
          frontendOnly: true,
          platform: 'darwin',
          language: 'en',
        }),
        onBrowserEvent: () => () => {},
        browserState: async () => state,
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
      },
      {
        get: (target, key) =>
          key in target
            ? target[key]
            : (...args) =>
                key.toString().startsWith('on') ? () => {} : Promise.resolve(),
      },
    );
  });
  for (const height of [684, 970]) {
    await page.setViewportSize({ width: 1400, height });
    await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
    const browserPanel = page.getByRole('button', {
      name: 'browser panel',
      exact: true,
    });
    if ((await browserPanel.getAttribute('aria-pressed')) !== 'true')
      await browserPanel.click();
    await page
      .getByRole('button', { name: 'page diagnostics', exact: true })
      .waitFor();
    for (const expanded of [false, true]) {
      const diagnosticToggle = page.getByRole('button', {
        name: 'page diagnostics',
        exact: true,
      });
      if (
        (await diagnosticToggle.getAttribute('aria-expanded')) !==
        String(expanded)
      )
        await diagnosticToggle.click();
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      const geometry = await page.evaluate(() => {
        const selectors = [
          '.inspector-body',
          '.inspector-resource-view[data-inspector-resource=browser]:not([hidden])',
          '.native-browser',
          '.native-browser-viewport',
          '.native-browser-footer',
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
      await page.screenshot({
        path:
          out + `/whole-app-${height}-${expanded ? 'expanded' : 'closed'}.png`,
      });
      const [body, wrapper, native, viewport, footer, diagnostics] = geometry;
      assert.equal(
        body.paddingBottom,
        20,
        'preserve original inspector padding',
      );
      assert(
        Math.abs(wrapper.bottom - (body.bottom - body.paddingBottom)) <= 1,
        'browser wrapper fills original inspector content box',
      );
      assert(
        Math.abs(native.bottom - wrapper.bottom) <= 1,
        'native browser fills its bounded parent',
      );
      assert(
        Math.abs(diagnostics.bottom - native.bottom) <= 1,
        'diagnostics end at bounded browser bottom',
      );
      assert(viewport.height >= 80, 'guest retains usable actual viewport');
      assert(footer.bottom <= body.bottom, 'page footer remains visible');
      assert(
        diagnostics.bottom <= body.bottom,
        'expanded diagnostics never overflow inspector',
      );
      assert(
        body.bottom - diagnostics.bottom <= 32,
        'do not weaken native blank-under-panel acceptance',
      );
      checks.push({ height, expanded, geometry });
    }
    const pair = checks.slice(-2);
    assert(
      pair[0].geometry[3].height > pair[1].geometry[3].height,
      'expanded diagnostics resize the actual guest within the same fixed parent',
    );
  }
  assert.deepEqual(errors, [], 'full application renders without page errors');
  console.log(
    'PASS original full-app browser inspector bounds closed and expanded',
  );
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
