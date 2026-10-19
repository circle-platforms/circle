import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

// The drawer opens the terminal when Circle opens a device console, and the browser when
// Circle starts working in it, once each time. A window popped out or put back, another
// conversation's window, a page or a narrow window in between does not make the console
// or the work new: the next event of the same console, or of the same work, leaves the
// mode the person chose. The application runs against a synthetic desktop host whose
// events the test sends.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
    viewport: { width: 1400, height: 900 },
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    localStorage.setItem('circle.workbench.language', 'en');
    const terminal = {
      sessionId: 'terminal:session1',
      conversation: 'session1',
      sessions: [],
      profiles: [],
    };
    const page = {
      sessionId: 'browser:session1',
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoom: 100,
      tab: 't1',
      tabs: [
        {
          id: 't1',
          url: 'about:blank',
          title: '',
          active: true,
          loading: false,
        },
      ],
      operating: false,
    };
    const listeners = {
      terminal: new Set(),
      browser: new Set(),
      popout: new Set(),
    };
    const emit = (kind, value) => {
      for (const listener of listeners[kind])
        listener(JSON.parse(JSON.stringify(value)));
    };
    const subscribe = (kind) => (listener) => {
      listeners[kind].add(listener);
      return () => listeners[kind].delete(listener);
    };
    window.__drawer = {
      // The conversation's device consoles, as the main process reports them after
      // anything happens on one: Circle typing a command reports the same consoles.
      consoles: (count) => {
        terminal.sessions = Array.from({ length: count }, (_, index) => ({
          id: `device-${index}`,
          name: `router ${index}`,
          target: `192.0.2.${index + 1}`,
          transport: 'telnet',
          state: 'ready',
          detail: '',
          held: '',
          quiet: 0,
          cols: 80,
          rows: 24,
        }));
        emit('terminal', { kind: 'state', state: terminal });
      },
      operating: (on) => {
        page.operating = on;
        emit('browser', page);
      },
      popout: (kind, sessionId, open) =>
        emit('popout', { kind, sessionId, open }),
    };
    window.circleDesktop = new Proxy(
      {
        info: async () => ({
          frontendOnly: true,
          platform: 'darwin',
          language: 'en',
        }),
        onTerminalEvent: subscribe('terminal'),
        terminalState: async (id) => ({
          ...JSON.parse(JSON.stringify(terminal)),
          sessionId: 'terminal:' + id,
          conversation: id,
          sessions: id === 'session1' ? terminal.sessions : [],
        }),
        onBrowserEvent: subscribe('browser'),
        browserState: async (id) => ({
          ...JSON.parse(JSON.stringify(page)),
          sessionId: 'browser:' + id,
        }),
        onPopoutEvent: subscribe('popout'),
        popouts: async () => [],
        runtimeCommand: async () => ({
          ok: false,
          error: 'not in this fixture',
        }),
      },
      {
        get: (target, key) =>
          key in target
            ? target[key]
            : () =>
                key.toString().startsWith('on') ? () => {} : Promise.resolve(),
      },
    );
  });
  const send = (name, ...args) =>
    page.evaluate(
      ([name, args]) => window.__drawer[name](...args),
      [name, args],
    );
  // Every effect of what was sent has run by the second frame after it.
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  const mode = (name) =>
    page.getByRole('button', { name: `${name} panel`, exact: true });
  const pressed = async () => {
    const shown = [];
    for (const name of ['files', 'changes', 'browser', 'subagents', 'terminal'])
      if ((await mode(name).getAttribute('aria-pressed')) === 'true')
        shown.push(name);
    return shown;
  };
  await page.goto(`${server.resolvedUrls.local[0]}#/session/session1`);
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  await mode('files').click();
  await page.locator('.files-panel').waitFor();
  assert.deepEqual(await pressed(), ['files']);

  // The console Circle opened while the terminal was in a window of its own: it does not
  // open the drawer. The window is put back, and Circle types into the same console.
  await send('popout', 'terminal', 'session1', true);
  await send('consoles', 1);
  await settle();
  assert.deepEqual(await pressed(), ['files']);
  await send('popout', 'terminal', 'session1', false);
  await settle();
  await send('consoles', 1);
  await settle();
  assert.deepEqual(
    await pressed(),
    ['files'],
    'the same console after the window was put back leaves the files mode',
  );
  // Another conversation's window, popped out and put back, changes nothing here.
  await send('popout', 'browser', 'session2', true);
  await send('popout', 'browser', 'session2', false);
  await settle();
  await send('consoles', 1);
  await settle();
  assert.deepEqual(await pressed(), ['files']);
  // Nor does a page opened and left.
  await page.goto(`${server.resolvedUrls.local[0]}#/page/settings`);
  await page.getByRole('heading', { name: 'settings', exact: true }).waitFor();
  await page.goto(`${server.resolvedUrls.local[0]}#/session/session1`);
  await page.locator('.files-panel').waitFor();
  await send('consoles', 1);
  await settle();
  assert.deepEqual(await pressed(), ['files']);

  // The browser: Circle started working in it while it was in a window of its own; it is
  // put back, and Circle goes on working in it.
  await send('popout', 'browser', 'session1', true);
  await send('operating', true);
  await settle();
  await send('popout', 'browser', 'session1', false);
  await settle();
  await send('operating', true);
  await settle();
  assert.deepEqual(
    await pressed(),
    ['files'],
    'the same work in the browser after the window was put back leaves the files mode',
  );

  // What is new still opens its mode: a second console, then a new start in the browser.
  await send('consoles', 2);
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="terminal panel"]')
        ?.getAttribute('aria-pressed') === 'true',
  );
  await mode('files').click();
  await page.locator('.files-panel').waitFor();
  await send('operating', false);
  await send('operating', true);
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="browser panel"]')
        ?.getAttribute('aria-pressed') === 'true',
  );
  assert.deepEqual(errors, []);
  console.log(
    'drawer auto-open: once per console and per start, whatever windows, pages or other conversations do between',
  );
} finally {
  await browser?.close();
  await server.close();
}
