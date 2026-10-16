// Diagnostic only (issue #124): can the GPU process be held back deterministically here?
import { _electron as electron } from 'playwright';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const appPath = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root);
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-hold-'));
const launcher = join(temp, 'gpu-launcher.sh');
await writeFile(
  launcher,
  `#!/bin/sh\necho "gpu-launcher $$ $(date +%s.%N) $*" >> ${temp}/launcher.log\nsleep 8\nexec "$@"\n`,
);
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
  ELECTRON_ENABLE_LOGGING: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const ps = () => {
  try {
    return execFileSync('ps', ['-eo', 'pid,ppid,etimes,stat,args', '--forest'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((l) => /Circle|electron|sleep|gpu-launcher/.test(l))
      .map((l) => l.slice(0, 260));
  } catch (e) {
    return String(e);
  }
};
const raf = (page, ms) =>
  Promise.race([
    page
      .evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r('frames'))),
          ),
      )
      .catch((e) => 'error ' + String(e).slice(0, 100)),
    new Promise((r) => setTimeout(() => r('no frames in ' + ms + 'ms'), ms)),
  ]);
const metrics = (app) =>
  app.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => `${m.type}:${m.pid}`),
  );

for (const mode of ['launcher', 'sigstop']) {
  const stderr = [];
  const t0 = Date.now();
  const app = await electron.launch({
    chromiumSandbox: true,
    executablePath: process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: mode === 'launcher' ? ['--gpu-launcher=' + launcher, appPath] : [appPath],
    cwd: root,
    env,
    timeout: 60000,
  });
  app.process().stderr.on('data', (c) => {
    for (const l of String(c).split('\n'))
      if (l.trim() && stderr.length < 60) stderr.push(Date.now() - t0 + ' ' + l.slice(0, 220));
  });
  const page = await app.firstWindow();
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor({ timeout: 30000 });
  const out = { mode, heading: Date.now() - t0 };
  out.visibleAtHeading = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].isVisible(),
  );
  out.metricsAtHeading = await metrics(app);
  out.psAtHeading = ps();
  if (mode === 'sigstop') {
    out.firstFrames = await raf(page, 15000);
    const gpu = (await app.evaluate(({ app }) =>
      app.getAppMetrics().filter((m) => m.type === 'GPU').map((m) => m.pid),
    ));
    out.gpuPids = gpu;
    for (const pid of gpu) process.kill(pid, 'SIGSTOP');
    out.stoppedAt = Date.now() - t0;
    out.framesWhileStopped = await raf(page, 3000);
    out.trialWhileStopped = await page
      .getByRole('button', { name: 'browser panel', exact: true })
      .click({ trial: true, timeout: 2000 })
      .then(() => 'clickable', (e) => String(e).split('\n').slice(-2).join(' | '));
    out.domWhileStopped = await page.evaluate(() => document.title).catch((e) => String(e));
    for (const pid of gpu) process.kill(pid, 'SIGCONT');
    out.framesAfterContinue = await raf(page, 10000);
  } else {
    out.framesDuringHold = await raf(page, 3000);
    out.at = Date.now() - t0;
    out.framesLater = await raf(page, 15000);
  }
  out.metricsEnd = await metrics(app);
  out.gpuStatus = await app.evaluate(({ app }) => app.getGPUFeatureStatus());
  try {
    out.launcherLog = execFileSync('cat', [join(temp, 'launcher.log')], { encoding: 'utf8' });
  } catch {
    out.launcherLog = 'none';
  }
  out.stderr = stderr;
  console.log('HOLD ' + JSON.stringify(out, null, 1));
  await app.close();
}
await rm(temp, { recursive: true, force: true });
