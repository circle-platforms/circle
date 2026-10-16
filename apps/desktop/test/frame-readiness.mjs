// #124: the packaged Linux check timed out clicking the browser panel while every
// readiness sample said ready. On a runner's first launch the GPU process spends
// seconds loading Mesa, and until it is up the window runs no animation frames, which
// Playwright needs before it finds any element stable. This starts the application with
// its GPU process held back for a fixed time: the same state, made deterministic.
import { captureFailure, observePage } from './helpers/diagnostics.mjs';
import { waitDesktopReady } from './helpers/desktop-readiness.mjs';
import { waitAnimationFrames } from './helpers/frame-readiness.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

if (process.platform === 'win32') {
  // Chromium prefixes the GPU process with a launcher only where it can exec one.
  console.log(
    JSON.stringify({
      skipped:
        'Windows cannot hold the GPU process back with a launcher; not verified there',
    }),
  );
  process.exit(0);
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const appPath = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root);
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/frame-readiness');
await mkdir(output, { recursive: true });
const holdMs = 8000;
const temp = await mkdtemp(join(tmpdir(), 'circle-frame-readiness-'));
// Chromium splits the launcher at spaces
assert.ok(!/\s/.test(temp), 'the scratch folder must not contain spaces');
const launcher = join(temp, 'gpu-launcher.sh');
await writeFile(launcher, `#!/bin/sh\nsleep ${holdMs / 1000}\nexec "$@"\n`);
await chmod(launcher, 0o755);
const workspace = join(temp, 'project');
await mkdir(workspace);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
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
const errors = [];
const evidence = { holdMs };
let app;
let page;
try {
  const launched = Date.now();
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: ['--gpu-launcher=' + launcher, appPath],
    cwd: root,
    env,
    timeout: 60000,
  });
  page = await app.firstWindow();
  observePage(page, errors);
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor({ timeout: 30000 });
  // As desktop.mjs does: show the window if production has not; it cannot have painted
  evidence.harnessShow = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isVisible()) return false;
    window.show();
    return true;
  });
  const button = page.getByRole('button', {
    name: 'browser panel',
    exact: true,
  });
  // What #124's readiness samples saw: a shown window and a visible, enabled button
  evidence.ready = (
    await waitDesktopReady(
      async () => ({
        native: await app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          return {
            visible: window.isVisible(),
            minimized: window.isMinimized(),
          };
        }),
        button: await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            visible: element.checkVisibility({
              opacityProperty: true,
              visibilityProperty: true,
            }),
            enabled: !element.disabled,
            width: rect.width,
            height: rect.height,
          };
        }),
      }),
      ({ native, button }) =>
        native.visible &&
        !native.minimized &&
        button.visible &&
        button.enabled &&
        button.width > 0 &&
        button.height > 0,
      { label: 'readiness without frames', timeoutMs: 3000, stableMs: 50 },
    )
  ).sample;
  // That is not enough: without frames the original click cannot find the button stable
  await assert.rejects(
    button.click({ trial: true, timeout: 2000 }),
    /waiting for element to be visible, enabled and stable/,
  );
  evidence.trialEndedMs = Date.now() - launched;
  assert.ok(
    evidence.trialEndedMs < holdMs,
    'the refused click must end while the GPU process is still held back',
  );
  assert.equal(await button.getAttribute('aria-pressed'), 'false');
  // The readiness desktop.mjs now requires: the window runs animation frames
  evidence.frames = await waitAnimationFrames(page, {
    label: 'held-back window renders animation frames',
    timeoutMs: 30000,
  });
  evidence.firstFramesMs = Date.now() - launched;
  assert.ok(
    evidence.firstFramesMs >= holdMs,
    'frames can only come after the GPU process has started',
  );
  // Then the original click, with its ten seconds, opens the browser panel
  await button.click({ timeout: 10000 });
  await page
    .getByRole('textbox', { name: 'browser address', exact: true })
    .waitFor({ timeout: 10000 });
  assert.equal(await button.getAttribute('aria-pressed'), 'true');
  evidence.pageErrors = errors.slice(0, 20);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        platform: process.platform,
        packaged: Boolean(process.env.CIRCLE_DESKTOP_APP_PATH),
        evidence,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ checks: 4, evidence }));
} catch (error) {
  console.error(JSON.stringify({ evidence }));
  await captureFailure(page, error, errors, output);
  throw error;
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
