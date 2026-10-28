// The settings modal must return to the same session after changing language
// and theme, including when the window is narrow.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setViewport } from './helpers/viewport.mjs';
import { closeNativeSettings } from './helpers/native-settings.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-settings-appearance-'));
const requestsPath = join(temp, 'requests.jsonl');
const fixturePath = join(temp, 'model.json');
const output = join(root, 'artifacts/settings-appearance');
await mkdir(output, { recursive: true });
await writeFile(
  fixturePath,
  JSON.stringify({
    requestsPath,
    replies: [
      {
        message: {
          id: 'appearance-fixture',
          role: 'assistant',
          content: 'appearance fixture ready',
        },
      },
    ],
  }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
};
delete env.ELECTRON_RUN_AS_NODE;
const packaged = Boolean(process.env.CIRCLE_DESKTOP_EXECUTABLE);
let app;
let page;
let failed = false;
const checks = [];
const errors = [];
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(String(error)));
  const message = page.locator('.composer textarea');
  await message.waitFor();
  await message.fill('start the appearance fixture');
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await page.getByText('appearance fixture ready', { exact: true }).waitFor();
  const initial = await page.evaluate(() =>
    window.circleDesktop.runtimeState(),
  );
  const sessionId = initial.snapshot.activeSessionId;
  await message.fill('unsent appearance draft');

  for (const width of [1400, 760]) {
    await setViewport(app, page, { width, height: 720 }, { show: true });
    for (const language of ['English', '简体中文'])
      for (const theme of ['dark', 'light']) {
        await page.keyboard.press(
          process.platform === 'darwin' ? 'Meta+,' : 'Control+,',
        );
        const settings = page.locator('.settings-dialog');
        await settings.waitFor({ state: 'visible' });
        const languageButton = settings.getByRole('button', {
          name: language,
          exact: true,
        });
        await languageButton.click();
        await page.waitForFunction(
          (name) =>
            [...document.querySelectorAll('.settings-dialog button')].some(
              (button) =>
                button.textContent.trim() === name &&
                button.getAttribute('aria-pressed') === 'true',
            ),
          language,
        );
        assert.equal(await languageButton.getAttribute('aria-pressed'), 'true');
        const themeButton = settings.getByRole('button', {
          name: theme === 'dark' ? /^(dark|深色)$/ : /^(light|浅色)$/,
          exact: true,
        });
        await themeButton.click();
        await page.waitForFunction(
          (name) => document.documentElement.dataset.theme === name,
          theme,
        );
        assert.equal(await themeButton.getAttribute('aria-pressed'), 'true');
        assert.equal(await closeNativeSettings(page), true);
        await page.waitForURL((url) => url.hash === `#/session/${sessionId}`);
        assert.equal(
          (await page.evaluate(() => window.circleDesktop.runtimeState()))
            .snapshot.activeSessionId,
          sessionId,
        );
        assert.equal(await message.inputValue(), 'unsent appearance draft');
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.theme),
          theme,
        );
        checks.push({ width, language, theme });
      }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ packaged, checks, errors }));
} catch (error) {
  failed = true;
  await page
    ?.screenshot({
      path: join(
        output,
        packaged ? 'packaged-failure.png' : 'development-failure.png',
      ),
    })
    .catch(() => {});
  await writeFile(
    join(output, packaged ? 'packaged-failure.txt' : 'development-failure.txt'),
    String(error?.stack ?? error) + '\n',
  );
  console.error(`kept isolated data at ${temp}`);
  throw error;
} finally {
  try {
    await app?.close();
  } catch (error) {
    if (!failed) throw error;
    console.error(`application cleanup failed: ${String(error)}`);
  }
  if (!failed) await rm(temp, { recursive: true, force: true, maxRetries: 10 });
}
