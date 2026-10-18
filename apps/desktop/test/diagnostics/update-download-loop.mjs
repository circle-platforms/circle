// DIAGNOSTIC ONLY: the part of test/update.mjs before the restart, many times over.
// Each round starts a copy of the package with a data folder of its own, checks, clicks
// update and follows the update state until it is ready or failed. A round that is
// neither after two minutes records what the window says and what still runs.
//   CIRCLE_DESKTOP_APP_PATH, CIRCLE_DESKTOP_EXECUTABLE  as for test/update.mjs
//   LOOP_ROUNDS                                        rounds (20)
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync, createReadStream, openSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const appPath = process.env.CIRCLE_DESKTOP_APP_PATH;
const executable = process.env.CIRCLE_DESKTOP_EXECUTABLE;
const rounds = Number(process.env.LOOP_ROUNDS ?? 20);
const { version } = JSON.parse(
  await readFile(join(root, '../../package.json'), 'utf8'),
);
const [major, minor, patch] = version.split(/[.-]/).map(Number);
const next = `${major}.${minor}.${patch + 1}`;
const temp = await mkdtemp(join(tmpdir(), 'circle-update-loop-'));
const installed = join(temp, 'apps', basename(appPath));
await cp(appPath, installed, { recursive: true, verbatimSymlinks: true });
const program = join(installed, relative(appPath, executable));
const release = join(temp, 'release');
console.log(`-- building ${next}`);
execFileSync(process.execPath, [join(root, 'scripts', 'package.mjs')], {
  timeout: 900000,
  cwd: root,
  env: {
    ...process.env,
    CIRCLE_DESKTOP_VERSION: next,
    CIRCLE_DESKTOP_OUTPUT_DIR: release,
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const published = (await readdir(release)).filter((name) =>
  name.startsWith(`circle-desktop-${next}-`),
);
const served = [];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  served.push(`${Date.now()} ${req.method} ${path}`);
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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = [];
for (let round = 1; round <= rounds; round++) {
  const data = join(temp, `data-${round}`);
  const port = 9400 + ((round * 37) % 400);
  const output = openSync(join(temp, `application-${round}.log`), 'a');
  served.length = 0;
  const env = {
    ...process.env,
    CIRCLE_WORKBENCH_DATA_DIR: data,
    CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
    CIRCLE_NO_UPDATE_CHECK: '1',
    CIRCLE_DESKTOP_RELEASES: `http://127.0.0.1:${server.address().port}/releases`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(program, [`--remote-debugging-port=${port}`], {
    env,
    stdio: ['ignore', output, output],
  });
  const exited = new Promise((resolve) => app.once('exit', resolve));
  const row = { round };
  let browser;
  let view;
  try {
    const end = Date.now() + 60000;
    while (!browser && Date.now() < end) {
      browser = await chromium
        .connectOverCDP(`http://127.0.0.1:${port}`)
        .catch(() => undefined);
      if (!browser) await wait(500);
    }
    if (!browser) throw Error('no debugging connection');
    while (!view && Date.now() < end) {
      view = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().startsWith('circle://'));
      if (!view) await wait(300);
    }
    if (!view) throw Error('no window');
    view.setDefaultTimeout(60000);
    await view.locator('.sidebar').waitFor();
    await view.keyboard.press('Escape');
    await view.evaluate(() => {
      location.hash = '#/page/settings';
    });
    const control = view.locator('.update-control');
    await control.getByRole('button', { name: 'check now' }).click();
    await control.getByText(`Circle ${next} is available`).waitFor();
    await view
      .locator('.update-chip', { hasText: `update to ${next}` })
      .waitFor();
    const clicked = Date.now();
    await control.getByRole('button', { name: 'update', exact: true }).click();
    const transitions = [];
    let last = '';
    let state;
    while (Date.now() - clicked < 120000) {
      state = await view.evaluate(() => window.circleDesktop.updateState());
      if (state.phase !== last) {
        transitions.push(`${state.phase}@${Date.now() - clicked}`);
        last = state.phase;
      }
      if (state.phase === 'ready' || state.phase === 'failed') break;
      await wait(250);
    }
    row.result = state?.phase;
    row.ms = Date.now() - clicked;
    row.transitions = transitions.join(' ');
    if (state?.phase === 'failed') row.error = state.error;
    if (state?.phase !== 'ready') {
      row.state = state;
      row.text = await control.innerText().catch((error) => String(error));
      row.updates = existsSync(join(data, 'updates'))
        ? await readdir(join(data, 'updates'), { recursive: true }).catch(
            () => [],
          )
        : 'absent';
      row.served = [...served];
      row.processes = execFileSync('ps', ['-axo', 'pid,etime,command'], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter((line) => /hdiutil|ditto|codesign|diskimages/.test(line))
        .join(' | ');
    }
  } catch (error) {
    row.result = 'error';
    row.error = String(error);
    row.served = [...served];
  }
  console.log(JSON.stringify(row));
  rows.push(row);
  if (view)
    await Promise.race([
      view
        .evaluate(() => window.circleDesktop.windowControl('quit'))
        .catch(() => {}),
      wait(5000),
    ]);
  await Promise.race([exited, wait(15000)]);
  if (app.exitCode === null) app.kill('SIGKILL');
  await browser?.close().catch(() => {});
  await rm(data, { recursive: true, force: true }).catch(() => {});
}
server.close();
const tally = {};
for (const row of rows) tally[row.result] = (tally[row.result] ?? 0) + 1;
const times = rows
  .filter((row) => row.result === 'ready')
  .map((row) => row.ms)
  .sort((a, b) => a - b);
console.log(
  JSON.stringify({
    rounds,
    tally,
    readyMs: {
      min: times[0],
      p50: times[Math.floor(times.length / 2)],
      max: times.at(-1),
    },
  }),
);
