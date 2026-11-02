// macOS has been seen to lose the wake-ups of the condition variable libuv's thread pool
// sleeps on, and every file, DNS and crypto operation in the runtime then waits for ever
// (docs/known-issues.md). Circle watches the pool and, when a probe goes unanswered, ends
// the runtime and starts it again. Native app, real utility process and the real kill and
// restart; the stalled pool is stood in for by a probe that opens a FIFO no one writes to,
// set through the test profile with a short interval.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { patience } from './helpers/patience.mjs';

if (process.platform === 'win32') {
  console.log(
    'skipped: the stand-in stall needs a FIFO, which Windows has not',
  );
  process.exit(0);
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-pool-stall-'));
const output = join(
  root,
  'artifacts/runtime-thread-pool-stall',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
const data = join(temp, 'data');
await mkdir(join(data, 'runtime-home', 'cache'), { recursive: true });
await writeFile(
  join(data, 'runtime-home', 'cache', 'models-dev.json'),
  JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
);
const fifo = join(temp, 'pool-probe');
const requestsPath = join(temp, 'requests.jsonl');
const fixturePath = join(temp, 'model.json');
// Each runtime process reads the script from its start, so the one before the stall and
// the one after it both give this answer; the requests file collects what both were sent.
const answer = 'the scripted answer';
await writeFile(
  fixturePath,
  JSON.stringify({
    requestsPath,
    replies: [
      {
        message: {
          id: 'answer',
          role: 'assistant',
          content: answer,
          completion: { reason: 'stop', provider_reason: 'end_turn' },
        },
        usage: { input_tokens: 3, output_tokens: 2, cache_read_tokens: 0 },
      },
    ],
  }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
  CIRCLE_RUNTIME_POOL_WATCH_MS: '250',
  CIRCLE_RUNTIME_POOL_PROBE_FIFO: fifo,
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const checks = [];
const errors = [];
let application;
try {
  application = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 45000,
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(patience(12000));
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.frontendOnly, false);
  const runtime = () =>
    page.evaluate(async () => await window.circleDesktop.runtimeState());
  const state = async () => (await runtime()).snapshot;
  const until = async (check, label, wait = 12000) => {
    const deadline = Date.now() + patience(wait);
    while (!(await check())) {
      assert(Date.now() < deadline, label);
      await new Promise((done) => setTimeout(done, 50));
    }
  };
  const send = async (value) => {
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(value);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // With no FIFO the probe's open fails at once, as a working pool answers: no stall.
  await until(async () => (await runtime()).connected, 'runtime running');
  const first = (await state()).runtime.processId;
  assert(Number.isSafeInteger(first) && first !== process.pid);
  const answers = page.getByText(answer, { exact: true });
  await send('before the stall');
  await answers.first().waitFor();
  await new Promise((done) => setTimeout(done, 1500));
  assert.equal((await runtime()).connected, true);
  assert.equal((await state()).runtime.processId, first);
  checks.push('a pool that answers its probe keeps the runtime running');

  // Now the probe's open waits for a writer that never comes: the pool reads as stalled.
  execFileSync('mkfifo', [fifo]);
  await until(
    async () => (await state()).runtime.stopped?.reason === 'stalled',
    'the runtime is reported stopped for a stalled pool',
  );
  const stopped = await state();
  assert.equal(stopped.runtime.connected, false);
  assert.equal(stopped.runtime.configured, true);
  assert.equal(stopped.runtime.stopped.restarting, true);
  assert.equal(stopped.runtime.error, 'Circle runtime stopped handling files');
  await until(() => !alive(first), 'the stalled runtime process is gone');
  await page
    .getByText('Circle runtime stopped handling files · restarting…', {
      exact: true,
    })
    .waitFor();
  await page.screenshot({ path: join(output, 'restarting.png') });
  checks.push(
    'a stalled pool ends the runtime process and the window says Circle runtime stopped handling files · restarting…',
  );

  // Once the FIFO is gone the restarted runtime's probe is answered again.
  await rm(fifo);
  await until(
    async () => (await runtime()).connected === true,
    'runtime restarted by itself',
    50000,
  );
  const restarted = await state();
  assert.notEqual(restarted.runtime.processId, first);
  assert.equal(restarted.runtime.stopped, undefined);
  await send('after the restart');
  await until(async () => (await answers.count()) === 2, 'answered again');
  const requests = (await readFile(requestsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(requests.length, 2);
  const history = JSON.stringify(requests[1].messages);
  for (const piece of ['before the stall', answer, 'after the restart'])
    assert(history.includes(piece), `the next model request carries: ${piece}`);
  await new Promise((done) => setTimeout(done, 1500));
  assert.equal((await runtime()).connected, true, 'no second stall');
  checks.push(
    'the runtime starts again by itself, keeps the conversation, and the next model request carries its history',
  );

  const log = await readFile(join(data, 'logs', 'runtime.log'), 'utf8');
  assert.match(
    log,
    /runtime thread pool stalled: a file operation went unanswered for \d+s · waiting: .*FSReqCallback \d+.* · ending the runtime/,
  );
  assert.match(
    log,
    /runtime stopped: Circle runtime stopped handling files · its thread pool stopped taking work, so Circle ended it\nup \d+s · restarting in 31s/,
  );
  assert.match(log, /runtime restarted/);
  checks.push(
    'logs/runtime.log names the stall, what the runtime was waiting on, the stop and the restart',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify({ checks, packaged: info.packaged }, null, 2),
  );
  console.log(
    JSON.stringify({ checks: checks.length, packaged: info.packaged, output }),
  );
} finally {
  await application?.close();
  await rm(temp, { recursive: true, force: true });
}
