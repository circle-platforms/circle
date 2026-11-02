// The tray, on a real screen. Closes the application's own window the way the title
// bar does: the window hides, the application lives, a show brings it back and the
// tray's quit ends it. Part of `npm run test:live`, which needs a desktop; macOS is
// skipped there, because the Dock owns that close and the tray hides nothing.
// The usual CIRCLE_DESKTOP_APP_PATH and CIRCLE_DESKTOP_EXECUTABLE carry it over to
// the packaged application, as the other live checks do.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

if (process.platform === 'darwin') {
  console.log(
    'SKIP tray check: macOS keeps the Dock, the tray hides nothing there',
  );
  process.exit(0);
}

const home = mkdtempSync(join(tmpdir(), 'circle-tray-'));
const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok' : 'not ok'} - ${name}${extra ? ' · ' + extra : ''}`);
  if (!ok) failures.push(name);
};
/** Wait for a main-process state, the way every live check does: on state, not sleep. */
async function waitFor(evaluate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate()) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

try {
  const app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env: {
      ...process.env,
      CIRCLE_WORKBENCH_DATA_DIR: join(home, 'data'),
      CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
      CIRCLE_NO_UPDATE_CHECK: '1',
    },
    timeout: 90000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // ready-to-show can come late on a slow runner: wait for the real window.
  const shown = await waitFor(
    () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => w.isVisible()),
      ),
    60000,
  );
  check('the window starts visible', shown);

  // Close it the way the title bar does. With a tray, this hides the window.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.close();
        break;
      }
    }
  });
  const hidden = await waitFor(
    () =>
      app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().length > 0 &&
          BrowserWindow.getAllWindows().every(
            (w) => !w.isDestroyed() && !w.isVisible(),
          ),
      ),
    20000,
  );
  check('closing hides the window to the tray', hidden);

  // The application lives on: the main process still answers.
  const alive = await app.evaluate(() => process.versions.electron);
  check('the application keeps running', typeof alive === 'string', alive);

  // What the tray icon's click does: show again.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.isVisible()) continue;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  });
  const shownAgain = await waitFor(
    () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => w.isVisible()),
      ),
    20000,
  );
  check('a show brings the window back', shownAgain);

  // The tray menu's quit ends the application.
  await app.evaluate(({ app: inner }) => inner.quit());
  const exited = await new Promise((res) => {
    app.process().once('exit', () => res(true));
    delay(60000).then(() => res(false));
  });
  check('the quit ends the process', exited);
  await app.close().catch(() => {});
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}
if (failures.length) {
  console.error('tray live check failed: ' + failures.join(', '));
  process.exit(1);
}
console.log('tray live check passed');
