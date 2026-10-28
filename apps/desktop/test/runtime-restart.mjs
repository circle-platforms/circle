// Issue #140: the runtime process dies in the middle of a long turn. The app
// must say the runtime stopped, keep the saved connection, start the runtime
// again by itself once, and carry on with the same endpoint and history.
// Native app, restricted bridge, real utility process and a local Anthropic
// gateway; the runtime is killed from outside, as a crash would end it.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { answerTitle, isTitleRequest } from './helpers/title-requests.mjs';
import { patience } from './helpers/patience.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-runtime-restart-'));
const output = join(
  root,
  'artifacts/runtime-restart',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
const dataDir = join(temp, 'data');
const home = join(dataDir, 'runtime-home');
await mkdir(join(home, 'cache'), { recursive: true });
await writeFile(
  join(home, 'cache', 'models-dev.json'),
  JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
);
await mkdir(join(home, 'workspace'), { recursive: true });
await writeFile(join(home, 'workspace', 'notes.txt'), 'restart fixture\n');
const model = 'claude-restart-fixture';
const key = 'restart-saved-key';
const requests = [];
const checks = [];
const errors = [];
let hanging;
const sse = (events) =>
  events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
const start = (id) => ({
  type: 'message_start',
  message: {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  },
});
const text = (value) => [
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: value },
  },
  { type: 'content_block_stop', index: 0 },
];
const finish = (reason) => [
  {
    type: 'message_delta',
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: 'message_stop' },
];
const gateway = createServer(async (req, res) => {
  let bytes = '';
  for await (const chunk of req) bytes += chunk;
  const body = bytes ? JSON.parse(bytes) : undefined;
  if (req.method === 'POST' && isTitleRequest(body)) {
    answerTitle(res, body, 'anthropic');
    return;
  }
  if (req.method !== 'POST' || !req.url.endsWith('/anthropic/v1/messages')) {
    res.writeHead(404);
    res.end();
    return;
  }
  requests.push({ url: req.url, headers: req.headers, body });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (requests.length === 1) {
    // The long task's first step reads a file.
    res.end(
      sse([
        start('msg-tool'),
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'read-notes',
            name: 'read_file',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"file_path":"notes.txt"}',
          },
        },
        { type: 'content_block_stop', index: 0 },
        ...finish('tool_use'),
      ]),
    );
    return;
  }
  if (requests.length === 2) {
    // Then it thinks for a long time: the stream starts and never ends.
    res.write(
      sse([
        start('msg-long'),
        ...text('working through the long task').slice(0, 2),
      ]),
    );
    hanging = res;
    return;
  }
  res.end(
    sse([
      start('msg-after'),
      ...text('answered after the restart'),
      ...finish('end_turn'),
    ]),
  );
});
await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${gateway.address().port}`;
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: dataDir,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CIRCLE_DESKTOP_RUNTIME_FIXTURE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';
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
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.frontendOnly, false);
  const runtime = () =>
    page.evaluate(async () => await window.circleDesktop.runtimeState());
  const state = async () => (await runtime()).snapshot;
  const command = (name, payload = {}) =>
    page.evaluate(
      async ({ name, payload }) => {
        const current = await window.circleDesktop.runtimeState();
        return window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name,
          payload,
          sessionId: current.snapshot.activeSessionId,
        });
      },
      { name, payload },
    );
  // The restart waits for the dead runtime's session leases to go stale (31 s).
  const until = async (check, label, wait = 12000) => {
    const deadline = Date.now() + patience(wait);
    while (!(await check())) {
      assert(Date.now() < deadline, label);
      await new Promise((resolve) => setTimeout(resolve, 50));
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
  const status = page.locator('.connection-status');
  // The first start opens the connection form; save the connection directly.
  await page.getByRole('textbox', { name: 'base url', exact: true }).waitFor();
  const configured = await command('configure', {
    endpoint: base + '/anthropic/v1',
    protocol: 'anthropic',
    model,
    apiKey: key,
  });
  assert.equal(configured.ok, true, configured.error);
  await page.keyboard.press('Escape');
  await until(async () => (await state()).runtime.configured, 'configured');
  const before = await state();
  const firstPid = before.runtime.processId;
  assert(Number.isSafeInteger(firstPid) && firstPid !== process.pid);
  await send('start the long task');
  await until(
    () => requests.length === 2 && hanging,
    'second model request under way',
  );
  await until(async () => {
    const snapshot = await state();
    return snapshot.sessions.find((row) => row.id === snapshot.activeSessionId)
      ?.turn;
  }, 'turn running');
  const sessionId = (await state()).activeSessionId;

  // The runtime dies mid-turn.
  process.kill(firstPid, 'SIGKILL');
  await until(
    async () => (await runtime()).connected === false,
    'runtime seen stopped',
  );
  const stopped = await state();
  assert.equal(stopped.runtime.connected, false);
  assert.equal(
    stopped.runtime.configured,
    true,
    'the saved connection is still configured',
  );
  assert.equal(stopped.runtime.stopped.restarting, true);
  assert.match(stopped.runtime.error, /^Circle runtime (exited|crashed)/);
  const cut = stopped.sessions.find((row) => row.id === sessionId);
  assert.equal(cut.turn, undefined);
  await until(
    async () => (await status.innerText()).trim() === 'runtime restarting…',
    'sidebar says restarting',
  );
  assert.equal(
    await page
      .getByRole('button', { name: 'connect a model', exact: true })
      .count(),
    0,
  );
  await page
    .getByText(/^Circle runtime (exited|crashed) \(.+\) · restarting…$/)
    .first()
    .waitFor();
  await page.screenshot({ path: join(output, 'restarting.png') });
  checks.push(
    'a runtime killed mid-turn reads as restarting, with the saved connection still configured and no connect-a-model prompt',
  );

  await until(
    async () => (await runtime()).connected === true,
    'runtime restarted by itself',
    50000,
  );
  const restarted = await state();
  assert.notEqual(restarted.runtime.processId, firstPid);
  assert.equal(restarted.runtime.configured, true);
  assert.equal(restarted.runtime.stopped, undefined);
  assert.equal(
    restarted.activeSessionId,
    sessionId,
    'the same session is open, not a new one',
  );
  const reopened = restarted.sessions.find((row) => row.id === sessionId);
  assert.equal(reopened.turn, undefined);
  assert.equal(reopened.state === 'running', false);
  const texts = reopened.messages.map((message) => message.text ?? '');
  assert(texts.includes('start the long task'));
  assert(
    reopened.messages.some((message) => message.tool?.name === 'read_file'),
  );
  assert(
    reopened.messages.some(
      (message) => message.role === 'notice' && message.interrupted,
    ),
    'the cut-off turn is marked interrupted',
  );
  await until(
    async () => (await status.innerText()).trim() === model,
    'sidebar shows the model again',
  );
  checks.push(
    'the runtime restarts once by itself into the same session, idle, with the cut-off turn marked interrupted',
  );

  await send('continue after the restart');
  await page.getByText('answered after the restart', { exact: true }).waitFor();
  const next = requests.at(-1);
  assert.equal(requests.length, 3);
  assert.equal(next.url, '/anthropic/v1/messages');
  assert.equal(next.headers['x-api-key'], key);
  assert.equal(next.body.model, model);
  const sent = JSON.stringify(next.body.messages);
  for (const piece of [
    'start the long task',
    'restart fixture',
    'The previous turn was interrupted before a reply was saved',
    'continue after the restart',
  ])
    assert(sent.includes(piece), `the next request carries: ${piece}`);
  checks.push(
    'the next model request goes to the same endpoint with the same key and model, and carries the stored history with the interruption',
  );

  const log = await readFile(join(dataDir, 'logs', 'runtime.log'), 'utf8');
  assert.match(log, /runtime stopped: Circle runtime (exited|crashed) \(/);
  assert.match(log, /restarting in 31s/);
  assert.match(log, /runtime restarted/);
  assert.equal(log.includes(key), false);
  checks.push(
    "the data folder's logs/runtime.log records the exit and the restart, without the key",
  );

  // A second death soon after is not restarted by itself; the person restarts it.
  const secondPid = restarted.runtime.processId;
  process.kill(secondPid, 'SIGKILL');
  await until(
    async () => (await state()).runtime.stopped?.restarting === false,
    'left stopped',
  );
  assert.equal((await state()).runtime.configured, true);
  await until(
    async () =>
      (await status.innerText()).trim() === 'runtime stopped · restart',
    'sidebar offers restart',
  );
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  // The connection is kept with the models, in settings.
  await page
    .locator('.settings-index-list')
    .getByRole('button', { name: 'models & connection', exact: true })
    .click();
  await page
    .locator('.settings-sections')
    .getByRole('button', { name: 'connection', exact: true })
    .click();
  await page
    .getByText(
      'The Circle runtime stopped. The saved connection is kept; the connection can be changed once the runtime runs again.',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'base url', exact: true }).count(),
    0,
  );
  await page.screenshot({ path: join(output, 'stopped-connection.png') });
  await page
    .getByRole('button', { name: 'restart runtime', exact: true })
    .click();
  await until(
    async () => (await runtime()).connected === true,
    'restarted on request',
    50000,
  );
  assert.notEqual((await state()).runtime.processId, secondPid);
  assert.equal((await state()).activeSessionId, sessionId);
  checks.push(
    'a second exit soon after stays stopped; the connection dialog says why instead of failing, and restart runtime starts it again',
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
  hanging?.destroy();
  await application?.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await rm(temp, { recursive: true, force: true });
}
