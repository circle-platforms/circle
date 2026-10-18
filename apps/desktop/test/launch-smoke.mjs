// Starts the packaged application as a person does and checks what every merge must keep:
// the window shows the workbench, the window and the main process answer each other, a turn
// reaches the model and its answer comes back, and quitting ends every process and closes the
// debugging port. Nothing comes from the network: the model is a local endpoint, and the data
// folder is a scratch one. It is the desktop part of the merge gate (.github/workflows/check.yml)
// and of a tag's release run; the full journeys run in the Desktop workbench workflow.
//   CIRCLE_DESKTOP_APP_PATH    the packaged Circle.app (macOS) or folder
//   CIRCLE_DESKTOP_EXECUTABLE  the program inside it
// What it saw goes to artifacts/launch-smoke/, and is kept when a check fails.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { existsSync, openSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { patience } from './helpers/patience.mjs';
import { answerTitle, isTitleRequest } from './helpers/title-requests.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.env.CIRCLE_DESKTOP_APP_PATH;
const executable = process.env.CIRCLE_DESKTOP_EXECUTABLE;
if (!appPath || !executable)
  throw Error('set CIRCLE_DESKTOP_APP_PATH and CIRCLE_DESKTOP_EXECUTABLE');
const { version } = JSON.parse(
  await readFile(join(root, '../../package.json'), 'utf8'),
);
const evidence = join(root, 'artifacts', 'launch-smoke');
await rm(evidence, { recursive: true, force: true });
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-launch-smoke-'));
const data = join(temp, 'data');
const started = Date.now();
const stage = (text) =>
  console.log(`-- ${((Date.now() - started) / 1000).toFixed(1)}s ${text}`);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log('ok', name);
};
const pageErrors = [];
const requests = [];

// The model: an OpenAI-compatible endpoint that streams one answer
const ANSWER = 'the packaged application answered';
const KEY = 'launch-smoke-key';
const MODEL = 'launch-smoke-model';
const gateway = createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
  if (path === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  if (path !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push({
    authorization: req.headers.authorization,
    model: request.model,
    title: isTitleRequest(request),
    last: JSON.stringify(request.messages?.at(-1)?.content ?? '').slice(0, 400),
  });
  if (isTitleRequest(request)) {
    answerTitle(res, request);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({ id: 'launch-smoke', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.write(chunk({ role: 'assistant', content: ANSWER }, null));
  res.write(chunk({}, 'stop'));
  res.end('data: [DONE]\n\n');
});
await new Promise((done) => gateway.listen(0, '127.0.0.1', done));

// A first start that is already connected: the settings and key setup would write
const home = join(data, 'runtime-home');
await mkdir(home, { recursive: true });
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({
    version: 1,
    initialized: true,
    auth: {
      protocol: 'openai',
      base_url: `http://127.0.0.1:${gateway.address().port}/v1`,
      model: MODEL,
      api_key_ref: 'api_key',
    },
    update_check: false,
  }),
  { mode: 0o600 },
);
await writeFile(
  join(home, 'credentials.json'),
  JSON.stringify({ api_key: KEY }),
  { mode: 0o600 },
);

const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const log = join(temp, 'application.log');
const output = openSync(log, 'a');

// Everything still running from the package, for the evidence and the last check
const leftovers = () => {
  try {
    if (process.platform === 'win32')
      return execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${resolve(appPath).replace(/'/g, "''")}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.Name }) -join [Environment]::NewLine`,
        ],
        { encoding: 'utf8', timeout: 30000 },
      )
        .split(/\r?\n/)
        .filter(Boolean);
    return execFileSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 30000,
    })
      .split('\n')
      .filter((line) => line.includes(resolve(appPath)));
  } catch (error) {
    return [`could not list processes: ${error}`];
  }
};

// The application starts detached in a process group of its own, so that everything it
// started can be stopped together when it does not quit
stage(`starting ${executable}`);
const app = spawn(executable, ['--remote-debugging-port=0'], {
  env,
  detached: process.platform !== 'win32',
  stdio: ['ignore', output, output],
});
const exited = new Promise((done) =>
  app.once('exit', (code, signal) => done({ code, signal })),
);
const stopTree = () => {
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 30000,
      });
    else process.kill(-app.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
};

let browser;
let page;
let phase = 'starting';
const record = async (reason) => {
  const files = { 'application.log': log };
  for (const [name, path] of Object.entries(files))
    if (existsSync(path)) await cp(path, join(evidence, name));
  const facts = {
    reason: String(reason?.stack ?? reason),
    phase,
    version,
    checks,
    pageErrors,
    requests,
    processes: leftovers(),
    seconds: (Date.now() - started) / 1000,
  };
  if (page) {
    await page
      .screenshot({ path: join(evidence, 'window.png'), timeout: 10000 })
      .catch(() => {});
    facts.text = await page
      .evaluate(() => document.body?.innerText?.slice(0, 4000))
      .catch((error) => `could not read the window: ${error}`);
  }
  await writeFile(
    join(evidence, 'launch-smoke.json'),
    JSON.stringify(facts, null, 2) + '\n',
  );
  console.error(JSON.stringify(facts, null, 2));
};

// A launch that hangs fails here, with what it saw, rather than at the job's limit
const watchdog = setTimeout(async () => {
  await record(`no result after ${patience(120000) / 1000} s`).catch(() => {});
  stopTree();
  process.exit(1);
}, patience(120000));

try {
  // The port the application listens on, from the file Chromium writes once it does
  phase = 'debugging port';
  const portFile = join(data, 'DevToolsActivePort');
  const listening = Date.now() + patience(60000);
  let port;
  while (!port) {
    if (app.exitCode !== null || app.signalCode)
      throw Error(`the application exited: ${JSON.stringify(await exited)}`);
    if (existsSync(portFile))
      port = Number((await readFile(portFile, 'utf8')).split('\n')[0]);
    if (!port) {
      if (Date.now() > listening)
        throw Error('the application wrote no debugging port');
      await wait(200);
    }
  }
  phase = 'window';
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const shown = Date.now() + patience(30000);
  while (!page) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('circle://'));
    if (!page) {
      if (Date.now() > shown) throw Error('the application opened no window');
      await wait(200);
    }
  }
  page.setDefaultTimeout(patience(20000));
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.locator('.sidebar').waitFor();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  check('the window shows the workbench');

  phase = 'bridge';
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.version, version);
  const state = await page.evaluate(() => window.circleDesktop.runtimeState());
  assert.equal(state.snapshot.runtime.configured, true);
  check(
    `the window and the main process answer each other (Circle ${version})`,
  );

  phase = 'turn';
  const said = 'a turn from the launch smoke';
  await page.getByRole('textbox', { name: 'message', exact: true }).fill(said);
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await page.getByText(ANSWER, { exact: true }).waitFor();
  const turns = requests.filter((request) => !request.title);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].authorization, `Bearer ${KEY}`);
  assert.equal(turns[0].model, MODEL);
  assert.match(turns[0].last, new RegExp(said));
  check('a turn reaches the model and its answer comes back');

  phase = 'quit';
  await page
    .evaluate(() => window.circleDesktop.windowControl('quit'))
    .catch(() => {});
  const quit = await Promise.race([
    exited,
    wait(patience(20000)).then(() => undefined),
  ]);
  if (!quit) throw Error('the application did not quit');
  page = undefined;
  await browser.close().catch(() => {});
  browser = undefined;
  // Its helpers end soon after it; none may outlive it, and the port must be free again
  const ended = Date.now() + patience(10000);
  let left = leftovers();
  while (left.length && Date.now() < ended) {
    await wait(250);
    left = leftovers();
  }
  assert.deepEqual(left, [], 'processes from the package are still running');
  const answered = await new Promise((done) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
  assert.equal(answered, false, `port ${port} still listens after Circle quit`);
  check('quitting ends every process and closes the debugging port');
  clearTimeout(watchdog);
  console.log(
    `launch smoke passed: ${checks.length} checks in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
} catch (error) {
  clearTimeout(watchdog);
  await record(error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (app.exitCode === null && !app.signalCode) stopTree();
  gateway.close();
  gateway.closeAllConnections();
  if (!process.exitCode)
    await rm(temp, { recursive: true, force: true, maxRetries: 10 }).catch(
      () => {},
    );
  else console.error(`kept ${temp}`);
}
