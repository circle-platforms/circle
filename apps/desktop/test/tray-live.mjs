// The tray, on a real screen. Closes the development app's own window the way the
// title bar does: the window hides, the application lives, a show brings it back and
// the tray's quit ends it. Part of `npm run test:live`, which needs a desktop.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'circle-tray-'));
const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok' : 'not ok'} - ${name}${extra ? ' · ' + extra : ''}`);
  if (!ok) failures.push(name);
};

try {
  const app = await electron.launch({
    chromiumSandbox: true,
    executablePath: require('electron'),
    args: [join(root, 'dist', 'main.cjs')],
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
  // The window starts visible.
  const visibleBefore = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.isVisible()),
  );
  check('the window starts visible', visibleBefore === true);

  // Close it the way the title bar does. With a tray, this hides the window.
  await app.evaluate(({ BrowserWindow }) => {
    const [main] = BrowserWindow.getAllWindows();
    main.close();
  });
  let hidden = false;
  const deadline = Date.now() + 15000;
  while (!hidden && Date.now() < deadline) {
    hidden = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().length > 0 &&
        BrowserWindow.getAllWindows().every(
          (w) => !w.isDestroyed() && !w.isVisible(),
        ),
    );
    if (!hidden) await delay(100);
  }
  check('closing hides the window to the tray', hidden === true);

  // The application lives on: the main process still answers.
  const alive = await app.evaluate(() => process.versions.electron);
  check('the application keeps running', typeof alive === 'string', alive);

  // What the tray icon's click does: show again.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.isVisible()) continue;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  });
  let visibleAgain = false;
  const shownDeadline = Date.now() + 15000;
  while (!visibleAgain && Date.now() < shownDeadline) {
    visibleAgain = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.isVisible()),
    );
    if (!visibleAgain) await delay(100);
  }
  check('a show brings the window back', visibleAgain === true);

  // The tray menu's quit ends the application.
  await app.evaluate(({ app: inner }) => inner.quit());
  const exited = await new Promise((res) => {
    app.process().once('exit', () => res(true));
    delay(60000).then(() => res(false));
  });
  check('the quit ends the process', exited === true);
  await app.close().catch(() => {});
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}
if (failures.length) {
  console.error('tray live check failed: ' + failures.join(', '));
  process.exit(1);
}
console.log('tray live check passed');
