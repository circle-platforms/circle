// Temporary diagnostics for 1.8.1: does a fixed --remote-debugging-port fail to
// come back when the application quits with a debugging connection open and
// starts again at once on the same port, as the update test does?
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const program = process.env.CIRCLE_DESKTOP_EXECUTABLE;
const rounds = Number(process.env.REUSE_ROUNDS ?? 8);
const port = 9600 + Math.floor(Math.random() * 300);
const netstat = () =>
  process.platform === 'win32'
    ? execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
        .split('\n')
        .filter(
          (line) => line.includes(`:${port} `) || line.includes(`:${port}\r`),
        )
        .map((line) => line.trim())
    : [];
const connect = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${port}`)
      .catch(() => undefined);
    if (browser) return browser;
    await new Promise((done) => setTimeout(done, 500));
  }
};
const temp = await mkdtemp(join(tmpdir(), 'circle-port-reuse-'));
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
  CIRCLE_NO_UPDATE_CHECK: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
for (let round = 1; round <= rounds; round++) {
  const app = spawn(program, [`--remote-debugging-port=${port}`], {
    env,
    stdio: 'ignore',
  });
  const exited = new Promise((done) => app.once('exit', done));
  const started = Date.now();
  const browser = await connect(60000);
  const row = { round, port, connectMs: browser ? Date.now() - started : null };
  if (browser) {
    const page = await (async () => {
      for (let i = 0; i < 100; i++) {
        const found = browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((page) => page.url().startsWith('circle://'));
        if (found) return found;
        await new Promise((done) => setTimeout(done, 200));
      }
    })();
    // Quit from inside, with the debugging connection still open, as the
    // update does when it hands over to the installer.
    await page
      ?.evaluate(() => window.circleDesktop.windowControl('quit'))
      .catch(() => {});
  } else app.kill();
  await exited;
  row.afterQuit = netstat();
  results(row);
}
function results(row) {
  console.log(JSON.stringify(row));
}
