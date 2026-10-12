// Updates a packaged application as a user does. A copy of the package is "installed" in a
// scratch folder, a newer version is packaged beside it and published from a local server, and
// the copy is driven through settings → check now → update → restart to update. The check
// passes when the copy that starts again is the newer version, and the old one is gone.
//   CIRCLE_DESKTOP_APP_PATH    the packaged Circle.app (macOS) or Circle-win32-x64 folder
//   CIRCLE_DESKTOP_EXECUTABLE  the program inside it
//   CIRCLE_DESKTOP_UPDATE_MSI  on Windows: the package's .msi. It is installed instead of the
//                              copy, and the update installs a newer .msi over it (this needs an
//                              administrator, as on CI) and removes it afterwards.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { join, relative, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.env.CIRCLE_DESKTOP_APP_PATH;
const executable = process.env.CIRCLE_DESKTOP_EXECUTABLE;
if (!appPath || !executable)
  throw Error('set CIRCLE_DESKTOP_APP_PATH and CIRCLE_DESKTOP_EXECUTABLE');
if (!['darwin', 'win32'].includes(process.platform)) {
  console.log('the desktop update installs itself on macOS and Windows only');
  process.exit(0);
}
// msiexec wants one kind of slash; Git Bash hands over both
const msi =
  process.platform === 'win32' &&
  process.env.CIRCLE_DESKTOP_UPDATE_MSI &&
  resolve(process.env.CIRCLE_DESKTOP_UPDATE_MSI);
const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
const msiexec = (...args) => {
  const result = spawnSync('msiexec.exe', args, { stdio: 'inherit' });
  if (result.status !== 0)
    throw Error(`msiexec ${args.join(' ')} exited with ${result.status}`);
};
const { version } = JSON.parse(
  await readFile(join(root, '../../package.json'), 'utf8'),
);
const [major, minor, patch] = version.split(/[.-]/).map(Number);
const next = `${major}.${minor}.${patch + 1}`;
const temp = await mkdtemp(join(tmpdir(), 'circle-desktop-update-'));
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log('ok', name);
};
let server;
let running;
let passed = false;
let port;
try {
  // The installed copy: in a folder of its own, or where the .msi puts it
  const installed = msi
    ? join(programFiles, 'Circle')
    : join(temp, 'apps', basename(appPath));
  if (msi) {
    assert.equal(existsSync(installed), false, `${installed} exists already`);
    msiexec('/i', msi, '/qn', '/l*v', join(temp, 'msi-install.log'));
  } else
    await cp(appPath, installed, { recursive: true, verbatimSymlinks: true });
  const program = join(installed, relative(appPath, executable));
  // The newer version, packaged as a release is
  const release = join(temp, 'release');
  const build = (script) =>
    execFileSync(process.execPath, [join(root, 'scripts', script)], {
      cwd: root,
      env: {
        ...process.env,
        CIRCLE_DESKTOP_VERSION: next,
        CIRCLE_DESKTOP_OUTPUT_DIR: release,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  build('package.mjs');
  if (msi) build('msi.ts');
  const published = (await readdir(release)).filter((name) =>
    name.startsWith(`circle-desktop-${next}-`),
  );
  assert.ok(published.length >= 2, `packaged ${published.join(', ')}`);
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/releases/latest')
      return res.writeHead(302, { Location: `/releases/tag/v${next}` }).end();
    if (path === `/releases/tag/v${next}`) return res.writeHead(200).end();
    const name = path.replace(`/releases/download/v${next}/`, '');
    if (!published.includes(name)) return res.writeHead(404).end();
    const file = join(release, name);
    res.writeHead(200, { 'Content-Length': (await stat(file)).size });
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = 9400 + Math.floor(Math.random() * 400);
  const env = {
    ...process.env,
    CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
    CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
    // The check is the one settings asks for
    CIRCLE_NO_UPDATE_CHECK: '1',
    CIRCLE_DESKTOP_RELEASES: `http://127.0.0.1:${server.address().port}/releases`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  running = spawn(program, [`--remote-debugging-port=${port}`], {
    env,
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => running.once('exit', resolve));

  // The window of the copy listening on `port`. Closing a browser reached over CDP quits the
  // application, so the connection stays open until the window is there.
  const page = async () => {
    const end = Date.now() + 60000;
    let browser;
    while (!browser) {
      browser = await chromium
        .connectOverCDP(`http://127.0.0.1:${port}`)
        .catch(() => undefined);
      if (Date.now() > end) throw Error('the application did not start');
      if (!browser) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (;;) {
      const found = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().startsWith('circle://'));
      if (found) {
        found.setDefaultTimeout(20000);
        return { browser, page: found };
      }
      if (Date.now() > end) throw Error('the application has no window');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  };
  // A first start opens the connection form; the update does not need it
  const settings = async (view) => {
    await view.locator('.sidebar').waitFor();
    await view.keyboard.press('Escape');
    await view.evaluate(() => {
      location.hash = '#/page/settings';
    });
    return view.locator('.update-control');
  };
  let { browser, page: view } = await page();
  const info = () => view.evaluate(() => window.circleDesktop.info());
  assert.equal((await info()).version, version);
  let control = await settings(view);
  await control.getByRole('button', { name: 'check now' }).click();
  await control
    .getByText(`Circle ${next} is available`)
    .waitFor()
    .catch(async (error) => {
      console.error(
        await view.evaluate(() => window.circleDesktop.updateState()),
      );
      throw error;
    });
  await view
    .locator('.update-chip', { hasText: `update to ${next}` })
    .waitFor();
  check('check now finds the newer version; settings and the sidebar offer it');
  await control.getByRole('button', { name: 'update', exact: true }).click();
  await control
    .getByRole('button', { name: 'restart to update' })
    .waitFor({ timeout: 120000 });
  check('the update downloads and is checked');
  await control.getByRole('button', { name: 'restart to update' }).click();
  await exited;
  await browser.close().catch(() => {});
  check('the application quits for the installer');

  ({ browser, page: view } = await page());
  assert.equal((await info()).version, next);
  check(`the copy that started again is ${next}`);
  control = await settings(view);
  await control.getByText(`Circle was updated to ${next}`).waitFor();
  check('settings say the update went in');
  assert.equal(existsSync(join(temp, 'data', 'updates')), false);
  if (msi) {
    // The newer package replaced the installed one rather than adding a second Circle
    const listed = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "@(Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object DisplayName -eq 'Circle' | ForEach-Object DisplayVersion) -join ','",
      ],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(listed, next);
  } else
    assert.deepEqual(await readdir(join(temp, 'apps')), [basename(appPath)]);
  if (process.platform === 'darwin') {
    const plist = join(installed, 'Contents/Info.plist');
    assert.equal(
      execFileSync(
        'plutil',
        ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist],
        { encoding: 'utf8' },
      ).trim(),
      next,
    );
    execFileSync('codesign', ['--verify', '--deep', '--strict', installed]);
  }
  check('the old copy is replaced in place and the download is cleared');
  await view
    .evaluate(() => window.circleDesktop.windowControl('quit'))
    .catch(() => {});
  await browser.close().catch(() => {});
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {
      break;
    }
  }
  console.log(`update checks passed: ${checks.length}`);
  passed = true;
} catch (error) {
  // What the installer did, when it ran
  const log = join(temp, 'data', 'updates', 'install.log');
  if (existsSync(log)) console.error(await readFile(log, 'utf8'));
  throw error;
} finally {
  if (running && running.exitCode === null) running.kill();
  server?.close();
  // The installed package goes, whichever version it is now
  if (msi && existsSync(join(programFiles, 'Circle')))
    for (const file of [
      join(temp, 'release', `circle-desktop-${next}-windows-x64.msi`),
      msi,
    ])
      try {
        msiexec('/x', file, '/qn');
        break;
      } catch {
        /* the other one is installed */
      }
  // A failed check keeps its files to look at
  if (passed)
    await rm(temp, { recursive: true, force: true, maxRetries: 5 }).catch(
      () => {},
    );
  else console.error(`kept ${temp}`);
}
