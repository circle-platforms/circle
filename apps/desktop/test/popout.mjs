// The browser and the terminal in windows of their own, in the running window: the
// pop-out and put-back buttons, the page that moves with its window and back, the button
// that brings a window forward, and the windows that close when another conversation is
// shown. In such a window: its notices, the theme and text size it follows, a screenshot
// or a terminal selection that goes to the main window's message box, browser keys that
// stay with the window whose panel has the keyboard, and an address an extension opens.
// The development app; the packaged one is covered by the live checks.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { readModelRequests } from './helpers/model-requests.mjs';
import { patience } from './helpers/patience.mjs';
import { listenForBrowser } from '../../../tests/browser-port.mjs';
if (
  process.env.CIRCLE_DESKTOP_EXECUTABLE ||
  (process.getuid?.() === 0 && !process.env.DISPLAY_WRAPPER)
) {
  console.log('SKIP popout harness: needs a desktop-capable session');
  process.exit(0);
}
// The packaged failure was a compositor that only breaks with the GPU on, and
// a stale measurement that only shows when the pop-out is a different size
// from the drawer. Run the same script both ways.
const gpuMode = process.env.CIRCLE_POPOUT_GPU;
if (gpuMode !== 'on' && gpuMode !== 'off') {
  const { spawnSync } = await import('node:child_process');
  const script = fileURLToPath(import.meta.url);
  for (const mode of ['on', 'off']) {
    console.log(`popout harness: gpu ${mode}`);
    const result = spawnSync(process.execPath, [script], {
      stdio: 'inherit',
      env: { ...process.env, CIRCLE_POPOUT_GPU: mode },
    });
    if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
console.log(`popout harness: running with gpu ${gpuMode}`);
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-popout-'));
const dataDir = join(temp, 'data');
await mkdir(join(dataDir, 'runtime-home'), { recursive: true });
const workspace = join(temp, 'project');
await mkdir(workspace, { recursive: true });
// Pages to show: the browser only reaches http and https.
const pageBody = (mark) =>
  `<!doctype html><title>${mark}</title><body style="margin:0;background:#00aa44"><h1 id="mark" style="color:#fff">${mark}</h1></body>`;
const site = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  const path = request.url ?? '/';
  response.end(
    path.startsWith('/live')
      ? '<!doctype html><title>extension link fixture</title><h1>opened by an extension</h1>'
      : path.startsWith('/again')
        ? pageBody('again page')
        : path.startsWith('/after')
          ? pageBody('after page')
          : '<!doctype html><title>pop</title><body style="margin:0;background:#00aa44"><h1 id="mark" style="color:#fff">popped page</h1></body>',
  );
});
await listenForBrowser(site);
const address = `127.0.0.1:${site.address().port}`;
const pageUrl = `http://${address}/`;
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: dataDir,
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_MODE: 'preview',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
    files: [],
    workspace,
    exportPath: join(temp, 'export.md'),
  }),
};
delete env.ELECTRON_RUN_AS_NODE;
const until = async (check, what, ms = 20000, seen) => {
  const stop = Date.now() + patience(ms);
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= stop)
      throw Error(
        `timed out: ${what}` +
          (seen ? ` · last seen ${JSON.stringify(await seen())}` : ''),
      );
    await new Promise((done) => setTimeout(done, 50));
  }
};
const mac = process.platform === 'darwin';
// The browser's command key: ⌘ on macOS, Ctrl elsewhere.
const commandKey = mac ? 'meta' : 'control';
const electronArgs = [
  ...(gpuMode === 'off' ? ['--disable-gpu'] : []),
  join(root, 'dist', 'main.cjs'),
];
let app;
let liveApp;
try {
  app = await electron.launch({
    executablePath: require('electron'),
    chromiumSandbox: true,
    args: electronArgs,
    env,
    timeout: 60000,
  });
  // Whatever a window sends, nothing may throw in the main process.
  await app.evaluate(() => {
    globalThis.mainProcessErrors = [];
    process.on('uncaughtException', (error) =>
      globalThis.mainProcessErrors.push(String(error)),
    );
  });
  const main = await app.firstWindow();
  await main.waitForFunction(() => !!window.circleDesktop, null, {
    timeout: 30000,
  });
  await main.locator('.topbar').waitFor({ timeout: 30000 });
  // Wider than the pop-out (920×640), as a maximized drawer is on a real screen. The
  // window itself is resized, not the page's viewport: a viewport larger than the window
  // a small screen allows would measure boxes the window does not have.
  await app.evaluate(({ BrowserWindow }) => {
    const own = BrowserWindow.getAllWindows().find(
      (one) =>
        !one.isDestroyed() && !one.webContents.getURL().includes('#/popout/'),
    );
    own?.setSize(1680, 1040);
  });
  const titles = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((one) => !one.isDestroyed() && !one.webContents.isDestroyed())
        .map((one) => one.getTitle()),
    );
  // The application's windows by what they show: the main one, or a mode's route. A window
  // that is closing stays listed for a moment after its page is gone, so only live ones count.
  // The open page in a window: its text, and where its view sits. A parked view is
  // a 1×1 box off the window, which is the blank area a move used to leave.
  // The window as the compositor drew it. executeJavaScript still reads a
  // page whose view is blank, so the green of the fixture has to be on screen.
  const compositedGreen = (electronApp, which) =>
    electronApp.evaluate(
      async ({ BrowserWindow, desktopCapturer, screen }, which) => {
        const target = BrowserWindow.getAllWindows()
          .filter((one) => !one.isDestroyed() && !one.webContents.isDestroyed())
          .find((one) => {
            const url = one.webContents.getURL();
            return which === 'main'
              ? !url.includes('#/popout/')
              : url.includes('#/popout/browser/');
          });
        if (!target) return { ratio: 0, reason: 'no window' };
        const attached = target.contentView.children.flatMap((child) => {
          try {
            return [
              {
                id: child.webContents.id,
                url: child.webContents.getURL(),
                bounds: child.getBounds(),
                visible: child.getVisible(),
              },
            ];
          } catch {
            return [];
          }
        });
        // macOS keeps its views in order its own way, and a capture of a window there
        // needs the screen recording permission: the view's place is checked instead.
        if (process.platform === 'darwin') return { skipped: true, attached };
        // The share of an area of an image in the fixture's #00aa44, in BGRA
        const share = (image, area) => {
          const { width, height } = image.getSize();
          const bitmap = image.toBitmap();
          let green = 0;
          let seen = 0;
          const right = Math.min(width, area.x + area.width);
          const bottom = Math.min(height, area.y + area.height);
          for (let y = Math.max(0, area.y); y < bottom; y += 6)
            for (let x = Math.max(0, area.x); x < right; x += 6) {
              const index = (y * width + x) * 4;
              seen++;
              if (
                bitmap[index + 2] < 50 &&
                bitmap[index + 1] > 110 &&
                bitmap[index] < 110
              )
                green++;
            }
          return seen ? green / seen : 0;
        };
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 900, height: 700 },
        });
        const source = sources.find(
          (one) => one.id === target.getMediaSourceId(),
        );
        if (source)
          return {
            ratio: share(source.thumbnail, {
              x: 0,
              y: 0,
              ...source.thumbnail.getSize(),
            }),
            of: 'window',
            title: source.name,
            attached,
          };
        // An X server without a window manager lists no windows: the page's box on the
        // screen instead
        const view = target.contentView.children.find((child) => {
          try {
            return (
              child.getVisible() &&
              child.webContents.getURL().startsWith('http')
            );
          } catch {
            return false;
          }
        });
        if (!view) return { ratio: 0, reason: 'no page view', attached };
        const box = view.getBounds();
        const display = screen.getDisplayMatching(target.getBounds());
        const scale = display.scaleFactor;
        const screens = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: {
            width: Math.round(display.size.width * scale),
            height: Math.round(display.size.height * scale),
          },
        });
        const shown =
          screens.find((one) => one.display_id === String(display.id)) ??
          (screens.length === 1 ? screens[0] : undefined);
        if (!shown) return { ratio: 0, reason: 'no capture', attached };
        const content = target.getContentBounds();
        return {
          ratio: share(shown.thumbnail, {
            x: Math.round((content.x - display.bounds.x + box.x) * scale),
            y: Math.round((content.y - display.bounds.y + box.y) * scale),
            width: Math.round(box.width * scale),
            height: Math.round(box.height * scale),
          }),
          of: 'box',
          attached,
        };
      },
      which,
    );
  // Whether a capture shows the page: a window shows some of its green, the page's own
  // box on the screen mostly green. macOS is not captured.
  const showsPage = (screen, which) =>
    screen.skipped === true ||
    screen.ratio >
      (screen.of === 'box' ? 0.5 : which === 'browser' ? 0.12 : 0.03);
  // The view's box has to lie on its own window, and a pop-out is not the drawer's size.
  const viewFits = (electronApp, which) =>
    electronApp.evaluate(({ BrowserWindow }, which) => {
      const windows = BrowserWindow.getAllWindows().filter(
        (one) => !one.isDestroyed() && !one.webContents.isDestroyed(),
      );
      const target = windows.find((one) => {
        const url = one.webContents.getURL();
        return which === 'main'
          ? !url.includes('#/popout/')
          : url.includes('#/popout/browser/');
      });
      const mainWindow = windows.find(
        (one) => !one.webContents.getURL().includes('#/popout/'),
      );
      if (!target || !mainWindow) return false;
      const [width, height] = target.getContentSize();
      const [mainWidth] = mainWindow.getContentSize();
      if (which === 'browser' && Math.abs(width - mainWidth) < 80) return false;
      const view = target.contentView.children.find((child) => {
        try {
          return (
            child.getVisible() && child.webContents.getURL().startsWith('http')
          );
        } catch {
          return false;
        }
      });
      if (!view) return false;
      const box = view.getBounds();
      return (
        box.x >= 0 &&
        box.y >= 0 &&
        box.width > 80 &&
        box.height > 80 &&
        box.x + box.width <= width + 2 &&
        box.y + box.height <= height + 2
      );
    }, which);
  const shownPage = (which) =>
    app.evaluate(({ BrowserWindow }, which) => {
      const target = BrowserWindow.getAllWindows()
        .filter((one) => !one.isDestroyed() && !one.webContents.isDestroyed())
        .find((one) => {
          const url = one.webContents.getURL();
          return which === 'main'
            ? !url.includes('#/popout/')
            : url.includes(`#/popout/${which}/`);
        });
      if (!target) return { text: '', bounds: null };
      const view = target.contentView.children.find((child) => {
        try {
          return (
            child.getVisible() && child.webContents.getURL().startsWith('http')
          );
        } catch {
          return false;
        }
      });
      if (!view) return { text: '', bounds: null };
      const bounds = view.getBounds();
      return view.webContents
        .executeJavaScript('document.querySelector("#mark")?.textContent || ""')
        .then((text) => ({ text, bounds }));
    }, which);
  const views = () =>
    app.evaluate(({ BrowserWindow }) => {
      const count = { main: 0, browser: 0, terminal: 0 };
      for (const one of BrowserWindow.getAllWindows().filter(
        (one) => !one.isDestroyed() && !one.webContents.isDestroyed(),
      )) {
        const url = one.webContents.getURL();
        const which = url.includes('#/popout/browser/')
          ? 'browser'
          : url.includes('#/popout/terminal/')
            ? 'terminal'
            : 'main';
        count[which] += one.contentView.children.length;
      }
      return count;
    });
  const windowsOf = async (hash) =>
    app.windows().filter((one) => one.url().includes(hash));
  // The page is on screen in a window: what the system shows of the window has the page's
  // green. The page itself cannot tell: its view never throttles, so it reads as visible
  // even where nothing shows it. On Linux, Electron 44.0.0 to 44.7.0 stacked a view added to
  // a window again, as a move does, under its siblings (electron/electron#54626). macOS keeps
  // its views in order its own way, and a capture of a window there needs the screen
  // recording permission.
  const pageOnScreen = async (hash) => {
    if (mac) return;
    let seen = 'no window';
    try {
      await until(async () => {
        seen = await app.evaluate(
          async (
            { BrowserWindow, desktopCapturer, screen },
            { hash, pageUrl },
          ) => {
            const window = BrowserWindow.getAllWindows()
              .filter(
                (one) => !one.isDestroyed() && !one.webContents.isDestroyed(),
              )
              .find((one) => one.webContents.getURL().includes(hash));
            if (!window) return 'no window';
            const view = window.contentView.children.find(
              (one) =>
                one.webContents &&
                !one.webContents.isDestroyed() &&
                one.webContents.getURL().startsWith(pageUrl),
            );
            if (!view) return 'no page in the window';
            const box = view.getBounds();
            if (box.width < 100 || box.height < 100)
              return 'the page has no place in the window yet';
            // The share of a box of an image in the fixture's #00aa44, in BGRA
            const green = (image, area) => {
              const { width, height } = image.getSize();
              const pixels = image.toBitmap();
              let count = 0;
              let found = 0;
              const right = Math.min(width, area.x + area.width);
              const bottom = Math.min(height, area.y + area.height);
              for (let y = Math.max(0, area.y); y < bottom; y += 4)
                for (let x = Math.max(0, area.x); x < right; x += 4) {
                  const at = (y * width + x) * 4;
                  count++;
                  if (
                    pixels[at + 2] < 60 &&
                    pixels[at + 1] > 120 &&
                    pixels[at] < 110
                  )
                    found++;
                }
              return count ? found / count : 0;
            };
            // The window as the system lists it, its frame included
            const windows = await desktopCapturer.getSources({
              types: ['window'],
              thumbnailSize: { width: 800, height: 600 },
            });
            const own = windows.find(
              (one) => one.id === window.getMediaSourceId(),
            );
            if (own) {
              const share = green(own.thumbnail, {
                x: 0,
                y: 0,
                ...own.thumbnail.getSize(),
              });
              return { share, of: 'the window', enough: share > 0.1 };
            }
            // An X server without a window manager lists no windows: the page's box on
            // the screen instead
            const display = screen.getDisplayMatching(window.getBounds());
            const scale = display.scaleFactor;
            const screens = await desktopCapturer.getSources({
              types: ['screen'],
              thumbnailSize: {
                width: Math.round(display.size.width * scale),
                height: Math.round(display.size.height * scale),
              },
            });
            const shown =
              screens.find((one) => one.display_id === String(display.id)) ??
              (screens.length === 1 ? screens[0] : undefined);
            if (!shown) return 'no capture of the window or of its screen';
            const content = window.getContentBounds();
            const share = green(shown.thumbnail, {
              x: Math.round((content.x - display.bounds.x + box.x) * scale),
              y: Math.round((content.y - display.bounds.y + box.y) * scale),
              width: Math.round(box.width * scale),
              height: Math.round(box.height * scale),
            });
            return {
              share,
              of: "the page's box on the screen",
              enough: share > 0.5,
            };
          },
          { hash, pageUrl },
        );
        return typeof seen === 'object' && seen.enough;
      }, 'the page on screen in its window');
    } catch (error) {
      throw Error(
        `${error.message}: ${typeof seen === 'object' ? `the page's green covers ${seen.share} of ${seen.of}` : seen}`,
      );
    }
  };
  // A key pressed in one window, as the system hands it to that window's page.
  const press = (which, keyCode, modifiers = []) =>
    app.evaluate(
      ({ BrowserWindow }, { which, keyCode, modifiers }) => {
        const target = BrowserWindow.getAllWindows()
          .filter((one) => !one.isDestroyed() && !one.webContents.isDestroyed())
          .find((one) => {
            const url = one.webContents.getURL();
            return which === 'main'
              ? !url.includes('#/popout/')
              : url.includes(which);
          });
        for (const type of ['keyDown', 'keyUp'])
          target.webContents.sendInputEvent({ type, keyCode, modifiers });
      },
      { which, keyCode, modifiers },
    );

  // ---- a conversation whose title is too long for a window's title still pops out
  await main.getByRole('textbox', { name: 'message', exact: true }).click();
  await main.keyboard.press('F2');
  const rename = main.locator('.session-rename');
  await rename.waitFor();
  const longTitle = 'a conversation whose title runs on and on '
    .repeat(7)
    .trim();
  assert.ok(longTitle.length > 200);
  await rename.fill(longTitle);
  await rename.press('Enter');
  await rename.waitFor({ state: 'detached' });

  // A page the person opened in the empty drawer stays painted when it pops
  // out, is reloaded, comes back, and is reloaded again.
  const painted = async (which, mark = 'popped page') => {
    const page = await shownPage(which);
    const screen = await compositedGreen(app, which);
    return (
      page.text === mark &&
      page.bounds &&
      page.bounds.width > 80 &&
      page.bounds.height > 80 &&
      page.bounds.x >= 0 &&
      page.bounds.y >= 0 &&
      showsPage(screen, which) &&
      (await viewFits(app, which)) &&
      screen.attached?.some(
        (view) =>
          view.visible &&
          view.url.startsWith('http') &&
          view.bounds.width > 80 &&
          view.bounds.height > 80,
      )
    );
  };
  await main
    .getByRole('button', { name: 'browser panel', exact: true })
    .click();
  await main.locator('.native-browser').waitFor();
  await main.getByText('browse the web', { exact: true }).waitFor();
  const drawerAddress = main.getByRole('textbox', { name: 'browser address' });
  await drawerAddress.fill(pageUrl);
  await drawerAddress.press('Enter');
  await until(() => painted('main'), 'the page the person opened is painted');
  await main
    .locator('.inspector .browser-address')
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  let userPopped = await until(
    async () => (await windowsOf('#/popout/browser/'))[0],
    'the browser window for a page opened in the drawer',
  );
  const browserSession = userPopped.url().split('/').at(-1);
  await until(() => painted('browser'), 'that page is painted in the window');
  await userPopped
    .getByRole('button', { name: 'reload page', exact: true })
    .click();
  await until(
    () => painted('browser'),
    'reloading the popped page still paints it',
  );
  await userPopped
    .getByRole('button', { name: 'put back in the drawer' })
    .click();
  await until(
    async () => (await windowsOf('#/popout/browser/')).length === 0,
    'the window of the page opened in the drawer closes',
  );
  await main.locator('.work-drawer').waitFor({ state: 'visible' });
  await until(() => painted('main'), 'the page is painted back in the drawer');
  await main.getByRole('button', { name: 'reload page', exact: true }).click();
  await until(
    () => painted('main'),
    'reloading the page in the drawer still paints it',
  );
  // A new address after the page has been out and back, then a second pop-out.
  // The drawer's late measurement must not be applied inside the smaller window.
  await drawerAddress.fill(pageUrl + 'again');
  await drawerAddress.press('Enter');
  await until(
    () => painted('main', 'again page'),
    'a new address paints in the drawer after put-back',
  );
  await main
    .locator('.inspector .browser-address')
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  userPopped = await until(
    async () => (await windowsOf('#/popout/browser/'))[0],
    'the browser window a second time',
  );
  await until(
    () => painted('browser', 'again page'),
    'the second pop-out paints the page',
  );
  await main.evaluate(async (sessionId) => {
    const state = await window.circleDesktop.browserState(sessionId);
    // A box that would fit the pop-out, and the drawer's real box, which does not.
    // Both come from the main window, which no longer has the page.
    const fitting = { x: 40, y: 180, width: 220, height: 160 };
    const drawer = { x: 1300, y: 80, width: 400, height: 900 };
    await window.circleDesktop.browserBounds(
      sessionId,
      fitting,
      true,
      state.host,
    );
    await window.circleDesktop.browserBounds(
      sessionId,
      drawer,
      true,
      state.host,
    );
    await window.circleDesktop.browserBounds(sessionId, fitting, true, 0);
  }, browserSession);
  const keptBox = (await shownPage('browser')).bounds;
  assert.ok(
    keptBox && keptBox.x < 80 && keptBox.width > 400,
    'a measurement from the drawer is not applied in the pop-out',
  );
  await until(
    () => painted('browser', 'again page'),
    'the second pop-out still paints after a stale measurement',
  );
  await userPopped
    .getByRole('button', { name: 'put back in the drawer' })
    .click();
  await until(
    async () => (await windowsOf('#/popout/browser/')).length === 0,
    'the second pop-out closes',
  );
  await main.locator('.work-drawer').waitFor({ state: 'visible' });
  await drawerAddress.fill(pageUrl + 'after');
  await drawerAddress.press('Enter');
  await until(
    () => painted('main', 'after page'),
    'navigating in the drawer after the second put-back paints',
  );
  await main
    .getByRole('button', { name: 'browser panel', exact: true })
    .click();
  await main.locator('.work-drawer').waitFor({ state: 'hidden' });

  // ---- the browser leaves the drawer
  await main
    .getByRole('button', { name: 'browser panel', exact: true })
    .click();
  await main.locator('.native-browser').waitFor();
  await main
    .locator('.inspector .browser-address')
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  let popped = await until(
    async () => (await windowsOf('#/popout/browser/'))[0],
    'the browser window',
  );
  const sessionId = popped.url().split('/').at(-1);
  await popped.locator('.native-browser').waitFor();
  assert.equal(
    await popped
      .getByRole('button', { name: 'put back in the drawer' })
      .count(),
    1,
  );
  assert.equal(
    await popped.getByRole('button', { name: 'full view' }).count(),
    0,
    'a window of its own has no full view',
  );
  const title = (await titles()).find((one) => one.startsWith('browser · '));
  assert.ok(title, 'the window is titled for the mode and the conversation');
  assert.ok(title.length <= 200, 'and the title is cut short to fit');
  assert.ok(title.startsWith('browser · a conversation whose title runs on'));
  assert.ok(title.endsWith('…'));
  // The drawer let go of the mode, and its button is marked as popped out,
  // not as the open drawer.
  await main.locator('.work-drawer').waitFor({ state: 'hidden' });
  await main.locator('.drawer-mode-button.popped').waitFor();
  const browserButton = main.getByRole('button', {
    name: 'browser panel',
    exact: true,
  });
  assert.equal(await browserButton.getAttribute('aria-pressed'), 'false');
  assert.equal(
    await browserButton.evaluate((node) => node.classList.contains('active')),
    false,
  );
  assert.equal(
    await browserButton.evaluate((node) => node.classList.contains('popped')),
    true,
  );

  // A page opened in the window is in that window.
  const field = () => popped.getByRole('textbox', { name: 'browser address' });
  const browserState = () =>
    popped.evaluate((id) => window.circleDesktop.browserState(id), sessionId);
  await field().fill(pageUrl);
  await field().press('Enter');
  await until(
    async () => (await views()).browser >= 1,
    'the page in the popout',
  );
  assert.equal(
    (await views()).main,
    0,
    'the page left the main window with the browser',
  );
  await until(async () => {
    const state = await browserState();
    return state.title === 'pop' && !state.loading;
  }, 'the page loaded');
  // The page itself moved: its text is in the window, and the view is on screen.
  await until(async () => {
    const page = await shownPage('browser');
    return (
      page.text === 'popped page' &&
      page.bounds &&
      page.bounds.width > 80 &&
      page.bounds.height > 80 &&
      page.bounds.x >= 0 &&
      page.bounds.y >= 0
    );
  }, 'the open page is painted in the window');
  // A page that opens in the window it shows in, before any move.
  await pageOnScreen('#/popout/browser/');

  // ---- the window shows its notices, on its bar where the page cannot cover them
  await field().fill('http://exa mple');
  await field().press('Enter');
  const notice = popped.locator('.toast');
  await notice.getByText('invalid address', { exact: true }).waitFor();
  const page = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()
      .filter((one) => !one.isDestroyed() && !one.webContents.isDestroyed())
      .find((one) => one.webContents.getURL().includes('#/popout/browser/'));
    return window.contentView.children
      .find((view) => view.getVisible())
      ?.getBounds();
  });
  const box = await notice.boundingBox();
  assert.ok(page && box, 'the page and the notice are both shown');
  assert.ok(
    box.y + box.height <= page.y,
    `the notice (${box.y}+${box.height}) is above the page (${page.y})`,
  );

  // ---- a screenshot taken in the window goes into the main window's message box
  await popped
    .getByRole('button', { name: 'browser menu', exact: true })
    .click();
  await popped
    .getByRole('menuitem', { name: 'take page screenshot', exact: true })
    .click();
  await notice.getByText('added to the message box', { exact: true }).waitFor();
  const chips = main.locator('.attachment-strip .file-chip');
  await chips.filter({ hasText: /^127\.0\.0\.1 \d\d:\d\d\.png$/ }).waitFor();
  const kept = await main.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem('circle.workbench.preview.v1'))
        .sessions.find((session) => session.id === id)
        .attachments.map(({ kind, mime, name, size, content }) => ({
          kind,
          mime,
          name,
          size,
          png: content.startsWith('data:image/png;base64,'),
        })),
    sessionId,
  );
  assert.equal(
    kept.length,
    1,
    'kept with the conversation, where its draft is',
  );
  assert.deepEqual(
    [kept[0].kind, kept[0].mime, kept[0].png],
    ['image', 'image/png', true],
  );
  assert.ok(kept[0].size > 0);
  // Only a window of its own adds to a message box this way, only to its own
  // conversation's, and only what its mode makes.
  const attach = (from, id, value) =>
    from.evaluate(
      async ({ id, value }) => {
        try {
          return { saved: await window.circleDesktop.popoutAttach(id, value) };
        } catch (error) {
          return { error: String(error.message) };
        }
      },
      { id, value },
    );
  const text = 'CIRCLE_POPOUT_SELECTION';
  const selection = {
    id: 'terminal-selection:' + randomUUID(),
    name: 'zsh · selection',
    kind: 'file',
    mime: 'text/plain',
    size: text.length,
    content: text,
  };
  assert.match(
    (await attach(main, sessionId, selection)).error,
    /untrusted IPC sender/,
  );
  assert.match(
    (await attach(popped, 'another-conversation', selection)).error,
    /invalid conversation/,
  );
  assert.match(
    (await attach(popped, sessionId, selection)).error,
    /invalid attachment/,
  );
  assert.equal(await chips.count(), 1);

  // ---- browser keys belong to the window whose panel has the keyboard
  const tabs = async () => (await browserState()).tabs?.length ?? 0;
  await field().fill(pageUrl);
  await field().press('Enter');
  await until(async () => {
    const state = await browserState();
    return state.url === pageUrl && !state.failure && !state.loading;
  }, 'the page again');
  await field().click();
  const beforeState = await browserState();
  const before = beforeState.tabs.length;
  // In the main window the same keys are its own, as if there were no browser: they
  // reach its page, and the window's page is left alone.
  await main.evaluate(() => {
    document.activeElement?.blur();
    window.keysSeen = [];
    addEventListener(
      'keydown',
      (event) => window.keysSeen.push(event.key.toLowerCase()),
      true,
    );
  });
  for (const [keyCode, modifiers] of [
    ['T', [commandKey]],
    ['L', [commandKey]],
    ['F5', []],
    ['F12', []],
  ])
    await press('main', keyCode, modifiers);
  await main.waitForFunction(() =>
    ['t', 'l', 'f5', 'f12'].every((key) => window.keysSeen.includes(key)),
  );
  assert.equal(await tabs(), before, 'no tab opened in the window');
  assert.equal((await browserState()).devTools ?? false, false);
  // In the window that has the page, they are the browser's: a new tab, closed again.
  await press('#/popout/browser/', 'T', [commandKey]);
  await until(async () => (await tabs()) === before + 1, 'a new tab');
  await press('#/popout/browser/', 'W', [commandKey]);
  await until(async () => (await tabs()) === before, 'the new tab closed');
  const afterClose = await browserState();
  assert.equal(
    afterClose.tab,
    beforeState.tab,
    'closing the new tab retains the original page',
  );
  assert.equal(afterClose.url, pageUrl, 'the original address stays loaded');
  assert.equal((await windowsOf('#/popout/browser/')).length, 1);

  // ---- a bad id from a window never throws in the main process
  await main.evaluate(() =>
    window.circleDesktop.browserKeys('../not a conversation', true),
  );
  await popped.evaluate(() => window.circleDesktop.browserKeys('', false));
  assert.equal((await browserState()).sessionId, 'browser:' + sessionId);
  assert.deepEqual(await app.evaluate(() => globalThis.mainProcessErrors), []);

  // ---- the window follows the theme and the text size, and in auto the system
  const look = (target) =>
    target.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      size: document.documentElement.style.getPropertyValue('--ui-size'),
    }));
  await main.evaluate(() => {
    location.hash = '#/page/settings';
  });
  const themes = main.getByRole('group', { name: 'theme', exact: true });
  const sizes = main.getByRole('group', { name: 'text size', exact: true });
  for (const theme of ['dark', 'light']) {
    await themes.getByRole('button', { name: theme, exact: true }).click();
    await until(
      async () => (await look(popped)).theme === theme,
      `the window turns ${theme}`,
    );
  }
  await sizes.getByRole('button', { name: 'larger', exact: true }).click();
  await until(
    async () => (await look(popped)).size === '17px',
    'the window takes the larger text',
  );
  await sizes.getByRole('button', { name: 'default', exact: true }).click();
  await until(
    async () => (await look(popped)).size === '14px',
    'and the default text again',
  );
  await themes.getByRole('button', { name: 'auto', exact: true }).click();
  for (const scheme of ['dark', 'light']) {
    await popped.emulateMedia({ colorScheme: scheme });
    await until(
      async () => (await look(popped)).theme === scheme,
      `the window follows the system to ${scheme}`,
    );
  }
  await main.evaluate((id) => {
    location.hash = '#/session/' + id;
  }, sessionId);
  await main.locator('.drawer-mode-button.popped').waitFor();

  // The button of a popped mode brings its window forward instead of opening the drawer.
  await main.getByRole('button', { name: /browser panel/ }).click();
  assert.equal(await main.locator('.work-drawer').isVisible(), false);
  assert.equal(
    (await windowsOf('#/popout/browser/')).length,
    1,
    'no second window',
  );

  // ---- pressing the mode again while its window closes opens a window, not the closing one
  await main.evaluate(
    async ({ id, title }) =>
      Promise.all([
        window.circleDesktop.popoutDock('browser', id),
        window.circleDesktop.popoutOpen('browser', id, title),
      ]),
    { id: sessionId, title },
  );
  const closing = popped;
  popped = await until(async () => {
    const open = await windowsOf('#/popout/browser/');
    return closing.isClosed() && open.length === 1 && open[0];
  }, 'the closing window gone and a new one open');
  await popped.locator('.native-browser').waitFor();
  assert.deepEqual(await main.evaluate(() => window.circleDesktop.popouts()), [
    { kind: 'browser', sessionId },
  ]);
  await main.locator('.drawer-mode-button.popped').waitFor();
  await until(async () => (await views()).browser >= 1, 'the page moved along');
  assert.equal((await views()).main, 0);
  await pageOnScreen('#/popout/browser/');

  // Back into the drawer: the window goes, the page comes along. Its panel had the
  // keyboard, and the main window's keys are its own again.
  await popped.getByRole('button', { name: 'put back in the drawer' }).click();
  await until(
    async () => (await windowsOf('#/popout/browser/')).length === 0,
    'the window closes',
  );
  await until(async () => (await views()).main >= 1, 'the page is back');
  await main.locator('.work-drawer').waitFor({ state: 'visible' });
  await main
    .locator('.drawer-mode-button.popped')
    .waitFor({ state: 'detached' });
  assert.equal(
    await main
      .getByRole('button', { name: 'browser panel', exact: true })
      .getAttribute('aria-pressed'),
    'true',
    'put back opens the drawer',
  );
  // What the main window holds when it is not the page: no view shown, another
  // page, or the page loaded again (#266)
  await until(
    async () => (await shownPage('main')).text === 'popped page',
    'the page is painted in the drawer',
    20000,
    () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((one) => !one.isDestroyed())
          .map((one) => ({
            url: one.webContents.getURL().replace(/^.*#/, '#'),
            views: one.contentView.children.map((child) => {
              try {
                return {
                  visible: child.getVisible(),
                  url: child.webContents.getURL(),
                  bounds: child.getBounds(),
                };
              } catch {
                return { gone: true };
              }
            }),
          })),
      ),
  );
  const tabsBack = (
    await main.evaluate(
      (id) => window.circleDesktop.browserState(id),
      sessionId,
    )
  ).tabs.length;
  await main.evaluate(() => {
    document.activeElement?.blur();
    window.keysSeen = [];
  });
  await press('main', 'T', [commandKey]);
  await main.waitForFunction(() => window.keysSeen.includes('t'));
  assert.equal(
    (
      await main.evaluate(
        (id) => window.circleDesktop.browserState(id),
        sessionId,
      )
    ).tabs.length,
    tabsBack,
  );

  // A page that is already open in the drawer moves into the window with it.
  await main
    .locator('.inspector .browser-address')
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  popped = await until(
    async () => (await windowsOf('#/popout/browser/'))[0],
    'the browser window again',
  );
  await until(async () => {
    const page = await shownPage('browser');
    return (
      page.text === 'popped page' &&
      page.bounds &&
      page.bounds.width > 80 &&
      page.bounds.height > 80 &&
      page.bounds.x >= 0 &&
      page.bounds.y >= 0
    );
  }, 'the page that was open moved into the window');
  assert.equal((await shownPage('main')).text, '');
  await popped.getByRole('button', { name: 'put back in the drawer' }).click();
  await until(
    async () => (await windowsOf('#/popout/browser/')).length === 0,
    'the window closes again',
  );
  await main.locator('.work-drawer').waitFor({ state: 'visible' });
  assert.equal(await main.locator('.drawer-mode-button.popped').count(), 0);
  await until(
    async () => (await shownPage('main')).text === 'popped page',
    'the page is back in the drawer again',
  );

  // ---- the terminal, and a conversation switch that brings it back
  await main
    .getByRole('button', { name: 'terminal panel', exact: true })
    .click();
  await main.locator('.term-tabbar').waitFor();
  await main
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  const terminal = await until(
    async () => (await windowsOf('#/popout/terminal/'))[0],
    'the terminal window',
  );
  await terminal.locator('.term-tabbar').waitFor();
  await main.locator('.drawer-mode-button.popped').waitFor();
  // A terminal's window passes a selection to the main window's message box.
  assert.deepEqual(await attach(terminal, sessionId, selection), {
    saved: true,
  });
  await chips.filter({ hasText: 'zsh · selection' }).waitFor();
  assert.match(
    (await attach(terminal, sessionId, { ...selection, kind: 'image' })).error,
    /invalid attachment/,
  );
  const rows = main.locator('.sidebar .session-row');
  const at = await rows.count();
  assert.ok(at > 1, 'a second conversation to switch to');
  // Show another conversation: its windows are not shown, they come back.
  const here = await main.evaluate(() => location.hash);
  for (let index = 0; index < at; index++) {
    await rows.nth(index).click();
    if ((await main.evaluate(() => location.hash)) !== here) break;
  }
  await until(
    async () => (await windowsOf('#/popout/terminal/')).length === 0,
    'the terminal window closes with the conversation',
  );
  assert.deepEqual(await app.evaluate(() => globalThis.mainProcessErrors), []);
  await app.close();
  app = undefined;

  // ---- live: an extension's address, and a selection that reaches the model
  const liveData = join(temp, 'live');
  const home = join(liveData, 'runtime-home');
  const extension = join(home, 'extensions', 'linker');
  await mkdir(extension, { recursive: true });
  const link = `http://${address}/live`;
  await writeFile(
    join(extension, 'extension.mjs'),
    `export function register(api){api.registerCommand('openlab','open the lab page',async()=>{await api.openUrl(${JSON.stringify(link)})})}`,
  );
  const requestsPath = join(temp, 'model-requests.jsonl');
  const fixturePath = join(temp, 'model.json');
  await writeFile(
    fixturePath,
    JSON.stringify({
      requestsPath,
      replies: [
        { message: { id: 'seen', role: 'assistant', content: 'seen' } },
      ],
    }),
  );
  liveApp = await electron.launch({
    executablePath: require('electron'),
    chromiumSandbox: true,
    args: electronArgs,
    env: {
      ...env,
      CIRCLE_HOME: join(temp, 'live-home'),
      CIRCLE_WORKBENCH_DATA_DIR: liveData,
      CIRCLE_WORKBENCH_MODE: 'live',
      CIRCLE_WORKBENCH_LANGUAGE: 'en',
      CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
      // A scripted model is accepted only in an explicit test profile.
      CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
    },
    timeout: 60000,
  });
  await liveApp.evaluate(({ app }) => {
    // UI Automation and screen readers can enable this on Windows. Exercise the
    // same input path rather than depending on the person's accessibility state.
    app.setAccessibilitySupportEnabled(true);
    globalThis.mainProcessErrors = [];
    process.on('uncaughtException', (error) =>
      globalThis.mainProcessErrors.push(String(error)),
    );
  });
  const live = await liveApp.firstWindow();
  const message = live.getByRole('textbox', { name: 'message', exact: true });
  await message.waitFor({ timeout: patience(30000) });
  const state = () =>
    live
      .evaluate(() => window.circleDesktop.runtimeState())
      .then((update) => update.snapshot);
  await until(
    async () =>
      (await state()).extensions.some((item) => item.name === 'linker'),
    'the extension loaded',
  );
  const liveSession = (await state()).activeSessionId;
  const openLab = () =>
    live.evaluate(
      (sessionId) =>
        window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name: 'custom-command',
          payload: { name: 'openlab' },
          sessionId,
        }),
      liveSession,
    );
  const liveWindows = (hash) =>
    liveApp.windows().filter((one) => one.url().includes(hash));
  // The conversation, with the mode buttons of its top bar
  await live.evaluate((id) => {
    location.hash = '#/session/' + id;
  }, liveSession);
  await live
    .getByRole('button', { name: 'browser panel', exact: true })
    .click();
  await live.locator('.native-browser').waitFor();
  // The packaged path: the address is typed in the drawer's field, which
  // navigates through the renderer, and the page has to stay painted when it
  // moves. A direct navigate in the main process is a different path.
  await live.getByText('browse the web', { exact: true }).waitFor();
  const typed = live.getByRole('textbox', { name: 'browser address' });
  await typed.fill(pageUrl);
  await typed.press('Enter');
  const livePainted = async (which) => {
    const screen = await compositedGreen(liveApp, which);
    return showsPage(screen, which) && (await viewFits(liveApp, which));
  };
  await liveApp.evaluate(({ BrowserWindow }) => {
    const own = BrowserWindow.getAllWindows().find(
      (one) =>
        !one.isDestroyed() && !one.webContents.getURL().includes('#/popout/'),
    );
    own?.setSize(1680, 1040);
  });
  await until(
    () => livePainted('main'),
    'the page typed in the drawer is on screen',
  );
  const typedBefore = (await compositedGreen(liveApp, 'main')).attached?.find(
    (view) => view.url.startsWith('http'),
  );
  assert.ok(typedBefore, 'the typed page has a view in the drawer');
  const tabBefore = await live.evaluate(
    (id) => window.circleDesktop.browserState(id).then((state) => state.tab),
    liveSession,
  );
  await live
    .locator('.inspector .browser-address')
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  let liveBrowser = await until(
    async () => liveWindows('#/popout/browser/')[0],
    'the browser window',
  );
  await liveBrowser.locator('.native-browser').waitFor();
  await until(
    () => livePainted('browser'),
    'the typed page is on screen in the window',
  );
  const typedAfter = (await compositedGreen(liveApp, 'browser')).attached?.find(
    (view) => view.url.startsWith('http'),
  );
  const tabAfter = await liveBrowser.evaluate(
    (id) => window.circleDesktop.browserState(id).then((state) => state.tab),
    liveSession,
  );
  assert.equal(
    tabAfter,
    tabBefore,
    'pop-out keeps the tab and shows it in the new window',
  );
  assert.ok(typedAfter?.id, 'the popped page has a view');
  await liveBrowser
    .getByRole('button', { name: 'reload page', exact: true })
    .click();
  await until(
    () => livePainted('browser'),
    'reloading the typed page still paints it',
  );
  await liveBrowser
    .getByRole('button', { name: 'put back in the drawer' })
    .click();
  await until(
    async () => (await liveWindows('#/popout/browser/')).length === 0,
    'the typed page returns to the drawer',
  );
  await live.locator('.work-drawer').waitFor({ state: 'visible' });
  await until(
    () => livePainted('main'),
    'the typed page is on screen back in the drawer',
  );
  await live.getByRole('button', { name: 'reload page', exact: true }).click();
  await until(
    () => livePainted('main'),
    'reloading the typed page in the drawer still paints it',
  );
  await typed.fill(pageUrl + 'after');
  await typed.press('Enter');
  await until(
    () => livePainted('main'),
    'a new address paints in the drawer after put-back',
  );
  await live
    .locator('.inspector .browser-address')
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  liveBrowser = await until(
    async () => liveWindows('#/popout/browser/')[0],
    'the browser window',
  );
  await liveBrowser.locator('.native-browser').waitFor();
  await until(
    () => livePainted('browser'),
    'the second pop-out paints the typed page',
  );
  await live.locator('.work-drawer').waitFor({ state: 'hidden' });
  const workspaceId = (await state()).sessions.find(
    (session) => session.id === liveSession,
  ).workspaceId;
  const listings = await Promise.all(
    [live, liveBrowser].map((page) =>
      page.evaluate(
        (id) => window.circleDesktop.listWorkspace(id),
        workspaceId,
      ),
    ),
  );
  assert.ok(
    listings.every((listing) => listing && Array.isArray(listing.files)),
    'main and pop-out can discover the workspace concurrently',
  );
  // An address an extension opens goes to the browser's window, as it would to the drawer.
  const liveAddress = liveBrowser.getByRole('textbox', {
    name: 'browser address',
  });
  const opened = async () => {
    const browser = await liveBrowser.evaluate(
      (id) => window.circleDesktop.browserState(id),
      liveSession,
    );
    return (
      browser.url === link &&
      !browser.loading &&
      browser.title === 'extension link fixture' &&
      (await liveAddress.inputValue()) === link
    );
  };
  assert.equal((await openLab()).ok, true);
  await until(opened, 'the address opened in the browser window');
  assert.equal(liveWindows('#/popout/browser/').length, 1, 'no second window');
  assert.equal(await live.locator('.work-drawer').isVisible(), false);
  // Asked again after the person went elsewhere, it opens again.
  await liveAddress.fill(`http://${address}/elsewhere`);
  await liveAddress.press('Enter');
  await until(
    async () =>
      (
        await liveBrowser.evaluate(
          (id) => window.circleDesktop.browserState(id),
          liveSession,
        )
      ).title === 'pop',
    'another page',
  );
  assert.equal((await openLab()).ok, true);
  await until(opened, 'the address opened again');

  // A selection in the terminal's window goes into the main window's message box, and
  // with the next message to the model.
  await live
    .getByRole('button', { name: 'terminal panel', exact: true })
    .click();
  await live.locator('.term-tabbar').waitFor();
  // A local shell in this window. A key goes out within about 50ms of the
  // click, and a composer focus is forced just after, so the first character
  // cannot stay in the draft. An exited shell then shows restart, and the
  // replacement keeps the lowest free number.
  const terminalPane = live.locator('[data-inspector-resource="terminal"]');
  await terminalPane
    .getByRole('button', { name: 'new terminal', exact: true })
    .click();
  const localScreen = live.locator('.native-terminal-screen').first();
  await localScreen
    .locator('.xterm-screen')
    .waitFor({ timeout: patience(20000) });
  await until(
    async () => (await live.locator('.native-terminal-dead').count()) === 0,
    'the local shell is running',
  );
  // Filled without a click: in a narrow window the terminal lies over the
  // conversation, and its screen is what a click there would hit.
  await message.fill('stays in the composer');
  await localScreen.click({ delay: 0 });
  const localTyping = live.keyboard.type('abc', { delay: 12 });
  await live.evaluate(() => {
    setTimeout(() => {
      document.querySelector('.composer textarea')?.focus();
    }, 25);
  });
  await localTyping;
  await until(
    () =>
      live
        .locator('.native-terminal-surface:not([hidden]) .xterm-rows')
        .innerText()
        .then((text) => text.includes('abc')),
    'the keys after the click reached the shell',
  );
  assert.equal(await message.inputValue(), 'stays in the composer');
  // This conversation's terminals as the main process lists them, for every window.
  const terminalRows = () =>
    live.evaluate(async (sessionId) => {
      const listed = await window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        name: 'workspace-service',
        sessionId,
        payload: { service: 'terminal', method: 'list', params: {} },
      });
      if (!listed.ok) throw Error(listed.error || 'terminal list failed');
      return listed.data.map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        hidden: item.hidden === true,
        managed: Boolean(item.managedCommand),
        tabNumber: item.tabNumber,
        restartOf: item.restartOf,
      }));
    }, liveSession);
  const killed = await live.evaluate(async (sessionId) => {
    const listed = await window.circleDesktop.runtimeCommand({
      id: crypto.randomUUID(),
      name: 'workspace-service',
      sessionId,
      payload: { service: 'terminal', method: 'list', params: {} },
    });
    if (!listed.ok) throw Error(listed.error || 'terminal list failed');
    const shell = listed.data.find(
      (item) =>
        item.kind === 'shell' && !item.hidden && item.status === 'running',
    );
    if (!shell) throw Error('no running local shell');
    const signalled = await window.circleDesktop.runtimeCommand({
      id: crypto.randomUUID(),
      name: 'workspace-service',
      sessionId,
      payload: {
        service: 'terminal',
        method: 'signal',
        params: { id: shell.id, signal: 'SIGKILL' },
      },
    });
    if (!signalled.ok) throw Error(signalled.error || 'terminal signal failed');
    return shell.id;
  }, liveSession);
  await live.getByText('this terminal has exited', { exact: true }).waitFor({
    timeout: patience(15000),
  });
  await live.getByText('press enter to restart', { exact: true }).waitFor();
  await live.getByRole('button', { name: 'restart', exact: true }).waitFor();
  await live.locator('.native-terminal-dead p').first().click();
  await live.keyboard.press('Enter');
  await until(
    async () => (await live.locator('.native-terminal-dead').count()) === 0,
    'the shell restarted',
  );
  await live.getByRole('tab', { name: 'terminal 1', exact: true }).waitFor();
  assert.equal(
    await live.getByRole('tab', { name: 'terminal 2', exact: true }).count(),
    0,
  );
  // The window takes the old tab out as soon as its replacement is announced. The main
  // process lists the old row until its restart has finished, when the row has left (#359).
  const restarted = await until(
    async () => {
      const listed = await terminalRows();
      return listed.find((row) => row.id === killed)?.hidden
        ? listed
        : undefined;
    },
    "the restarted shell's old row leaves the list",
    undefined,
    terminalRows,
  );
  // One shell is in the row: the replacement, with the old tab's number.
  assert.deepEqual(
    restarted
      .filter((row) => row.kind === 'shell' && !row.hidden && !row.managed)
      .map((row) => ({ tabNumber: row.tabNumber, restartOf: row.restartOf })),
    [{ tabNumber: 1, restartOf: killed }],
    JSON.stringify(restarted),
  );
  await live
    .getByRole('button', { name: 'stop terminal 1', exact: true })
    .click();
  await terminalPane
    .getByRole('button', { name: 'new terminal', exact: true })
    .waitFor();
  await terminalPane
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  const liveTerminal = await until(
    async () => liveWindows('#/popout/terminal/')[0],
    'the terminal window',
  );
  await liveTerminal
    .getByRole('button', { name: 'new terminal', exact: true })
    .click();
  const input = liveTerminal.locator('.xterm-helper-textarea');
  await input.waitFor({ timeout: patience(20000) });
  await liveTerminal.locator('.xterm-accessibility').waitFor();
  const mark = `CIRCLE_POPOUT_MARK_${Date.now()}`;
  await input.focus();
  // xterm intentionally ignores insertText's input-only event in screen-reader
  // mode. Actual typing includes key events, as the person's keyboard does.
  await liveTerminal.keyboard.type(`echo ${mark}`);
  await liveTerminal.keyboard.press('Enter');
  // Find reads what the shell has printed when it is asked, so it waits for the mark's
  // own line of output, which a slow shell prints later.
  await until(
    () =>
      liveTerminal
        .locator('.native-terminal-surface:not([hidden]) .xterm-rows > div')
        .evaluateAll(
          (rows, mark) => rows.some((row) => row.textContent.trim() === mark),
          mark,
        ),
    'the shell printed the mark',
  );
  await liveTerminal
    .getByRole('button', { name: 'terminal menu', exact: true })
    .click();
  await liveTerminal
    .getByRole('menuitem', { name: 'find in terminal', exact: true })
    .click();
  const find = liveTerminal.getByRole('textbox', {
    name: 'find in terminal',
    exact: true,
  });
  await find.waitFor();
  await find.fill(mark);
  await find.press('Enter');
  await until(
    async () =>
      (await liveTerminal.locator('.xterm-selection div').count()) > 0,
    'the output selected',
  );
  await liveTerminal
    .getByRole('button', { name: 'terminal menu', exact: true })
    .click();
  await liveTerminal
    .getByRole('menuitem', { name: 'add selection to chat', exact: true })
    .click();
  await liveTerminal
    .locator('.toast')
    .getByText('terminal selection added to draft', { exact: true })
    .waitFor();
  await live
    .locator('.attachment-strip .file-chip')
    .filter({ hasText: / · selection$/ })
    .waitFor();
  await message.fill('what does the terminal say?');
  await message.press('Enter');
  await until(async () => {
    if (!existsSync(requestsPath)) return false;
    const requests = await readModelRequests(requestsPath);
    return requests.some((request) =>
      JSON.stringify(request.messages).includes(mark),
    );
  }, 'the selection in the next model request');
  // Live, the theme is the runtime's setting and the text size the main window's own:
  // the terminal's window follows both.
  await live.evaluate(() => {
    location.hash = '#/page/settings';
  });
  const shown = (await look(liveTerminal)).theme;
  const other = shown === 'dark' ? 'light' : 'dark';
  await live
    .getByRole('group', { name: 'theme', exact: true })
    .getByRole('button', { name: other, exact: true })
    .click();
  await until(
    async () => (await look(liveTerminal)).theme === other,
    'the terminal window follows the theme',
  );
  await live
    .getByRole('group', { name: 'text size', exact: true })
    .getByRole('button', { name: 'large', exact: true })
    .click();
  await until(
    async () => (await look(liveTerminal)).size === '15px',
    'and the text size',
  );
  assert.deepEqual(
    await liveApp.evaluate(() => globalThis.mainProcessErrors),
    [],
  );
  console.log('popout: ok');
} catch (error) {
  // What each window showed, and what its terminals held, for a run that fails on CI.
  const evidence = join(root, 'artifacts', 'popout');
  await mkdir(evidence, { recursive: true }).catch(() => {});
  const windows = [
    ...(app?.windows() ?? []).map((page) => ['development', page]),
    ...(liveApp?.windows() ?? []).map((page) => ['live', page]),
  ];
  const screens = [];
  for (const [index, [which, page]] of windows.entries()) {
    const name = `${which}-${index}`;
    await page
      .screenshot({ path: join(evidence, `${name}.png`) })
      .catch(() => {});
    screens.push({
      name,
      url: page.url(),
      terminals: await page
        .locator('.native-terminal-surface')
        .evaluateAll((surfaces) =>
          surfaces.map((surface) => ({
            hidden: surface.hidden,
            rows: [...surface.querySelectorAll('.xterm-rows > div')].map(
              (row) => row.textContent,
            ),
          })),
        )
        .catch((reason) => String(reason)),
    });
  }
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify({ error: String(error?.stack ?? error), screens }, null, 2),
  ).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await liveApp?.close().catch(() => {});
  site.close();
  await rm(temp, { recursive: true, force: true });
}
