import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/live');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-native-live-'));
const fixturePath = join(temp, 'model.json');
const requestsPath = join(temp, 'requests.jsonl');
const exportPath = join(temp, 'export.jsonl');
const appPath = process.env.CIRCLE_DESKTOP_APP_PATH ?? root;
const fixture = {
  requestsPath,
  replies: [
    {
      message: {
        id: 'call-write',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'write-native',
            name: 'write_file',
            args: {
              file_path: 'native.txt',
              content: 'native runtime bytes\n',
            },
          },
        ],
      },
    },
    {
      chunks: ['native ', 'answer ', 'completed'],
      delayMs: 60,
      message: {
        id: 'answer-native',
        role: 'assistant',
        content: 'native answer completed',
      },
    },
    {
      message: {
        id: 'call-question',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'question-native',
            name: 'question',
            args: {
              questions: [
                { question: 'Choose a target', options: ['local', 'staging'] },
              ],
            },
          },
        ],
      },
    },
    {
      message: {
        id: 'answer-question',
        role: 'assistant',
        content: 'staging target received',
      },
    },
    { waitForAbort: true },
  ],
};
await writeFile(fixturePath, JSON.stringify(fixture));
const env = {
  ...process.env,
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({ exportPath }),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';
const checks = [];
const errors = [];
let app;
let page;
let gateway;
const state = () =>
  page
    .evaluate(() => window.circleDesktop.runtimeState())
    .then((update) => update.snapshot);
const command = (name, payload = {}, sessionId) =>
  page.evaluate(
    async ({ name, payload, sessionId }) => {
      const current = await window.circleDesktop.runtimeState();
      return window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        name,
        payload,
        sessionId: sessionId ?? current.snapshot.activeSessionId,
      });
    },
    { name, payload, sessionId },
  );
async function waitFor(check, name) {
  const deadline = Date.now() + 12_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(`timed out: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function send(value) {
  await page.getByRole('textbox', { name: 'message', exact: true }).fill(value);
  await page.getByRole('button', { name: 'send message', exact: true }).click();
}
try {
  app = await electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [appPath],
    cwd: root,
    env,
    timeout: 45_000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.frontendOnly, false);
  assert.equal(info.runtimeConnected, true);
  const initial = await state();
  assert.equal(initial.sessions.length, 1);
  assert.equal(initial.sessions[0].messages.length, 0);
  checks.push(
    'native app starts its bundled Circle core with an empty isolated workspace',
  );
  const sessionId = initial.activeSessionId;
  const workspace = initial.workspaces.find(
    (row) => row.id === initial.sessions[0].workspaceId,
  ).path;
  await send('write native file');
  await waitFor(
    async () =>
      (await state()).interactions.some((row) => row.status === 'pending'),
    'approval',
  );
  assert.equal(existsSync(join(workspace, 'native.txt')), false);
  checks.push(
    'frontend prompt reaches core but actual write waits for approval',
  );
  await page.locator('.interaction-summary').click();
  await page.locator('.activity-row').filter({ hasText: 'write_file' }).click();
  await page.getByRole('button', { name: 'allow once', exact: true }).click();
  await page.getByText('native answer completed', { exact: true }).waitFor();
  assert.equal(
    await readFile(join(workspace, 'native.txt'), 'utf8'),
    'native runtime bytes\n',
  );
  const requests = (await readFile(requestsPath, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert(
    requests[1].messages.some(
      (row) => row.role === 'tool' && row.content.includes('native.txt'),
    ),
  );
  checks.push(
    'native approval releases the real tool and its result reaches the next model request',
  );
  await send('choose target');
  await waitFor(
    async () =>
      (await state()).interactions.some(
        (row) => row.kind === 'question' && row.status === 'pending',
      ),
    'question',
  );
  await page.locator('.interaction-summary').click();
  await page
    .locator('.activity-row')
    .filter({ hasText: 'Choose a target' })
    .click();
  await page.getByRole('radio', { name: 'staging' }).check();
  await page
    .getByRole('button', { name: 'save response', exact: true })
    .click();
  await page.getByText('staging target received', { exact: true }).waitFor();
  const afterQuestion = (await readFile(requestsPath, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert(
    afterQuestion[3].messages.some(
      (row) => row.role === 'tool' && row.content.includes('staging'),
    ),
  );
  checks.push('native question answer resumes the same core turn');
  await page.reload();
  await page.getByText('staging target received', { exact: true }).waitFor();
  assert.equal((await state()).activeSessionId, sessionId);
  checks.push(
    'renderer reload resynchronizes without replacing the runtime or session',
  );
  await send('please wait');
  await waitFor(
    async () =>
      (await state()).sessions.find((s) => s.id === sessionId).state ===
      'waiting',
    'model waiting',
  );
  await page
    .getByRole('button', { name: 'pause conversation', exact: true })
    .click();
  await waitFor(
    async () =>
      (await state()).sessions.find((s) => s.id === sessionId).state === 'idle',
    'cancel',
  );
  checks.push('native stop awaits the actual model abort');
  await page
    .getByRole('button', { name: 'new session', exact: true })
    .first()
    .click();
  await waitFor(
    async () => (await state()).activeSessionId !== sessionId,
    'new session',
  );
  const created = (await state()).activeSessionId;
  assert.notEqual(created, sessionId);
  assert.equal((await command('select-session', { id: sessionId })).ok, true);
  await page.getByText('native answer completed', { exact: true }).waitFor();
  const exported = await command('export');
  assert.equal(exported.ok, true);
  assert(exported.data.content.includes('circle-session'));
  assert.equal(
    (await command('import', { content: exported.data.content })).ok,
    true,
  );
  const imported = (await state()).activeSessionId;
  assert.notEqual(imported, sessionId);
  checks.push(
    'native session create/select and checksum-bearing graph export/import use the core store',
  );
  if (process.platform !== 'win32') {
    const marker = join(workspace, 'shell.pid');
    const running = command('shell', {
      command: `echo $$ > '${marker.replaceAll("'", "'\\''")}' ; /bin/sleep 90`,
    });
    await waitFor(() => existsSync(marker), 'actual shell pid');
    const pid = Number(await readFile(marker, 'utf8'));
    assert(Number.isSafeInteger(pid) && pid > 1);
    process.kill(pid, 0);
    assert.equal((await command('abort')).ok, true);
    await running;
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 'actual shell exit');
    checks.push(
      'native cancellation stops the actual shell process, not only its displayed row',
    );
  }
  await page.screenshot({ path: join(output, 'live-native.png') });
  assert.deepEqual(errors, []);
  const firstSource = await sourceEvidence(root);
  const renderer = await rendererEvidence(root);
  await app.close();
  app = undefined;
  app = await electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [appPath],
    cwd: root,
    env,
    timeout: 45_000,
  });
  page = await app.firstWindow();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const restored = await state();
  assert.equal(restored.activeSessionId, imported);
  assert(
    restored.sessions
      .find((s) => s.id === imported)
      .messages.some((m) => m.text === 'native answer completed'),
  );
  assert.equal(restored.sessions.find((s) => s.id === imported).auto, false);
  checks.push(
    'application restart restores the persisted native checkpoint graph and resets auto mode',
  );
  await app.close();
  app = undefined;
  const gatewayRequests = [];
  gateway = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'native-fixture-model' }] }));
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    gatewayRequests.push(data);
    assert.equal(req.headers.authorization, 'Bearer native-local-key');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'native-gateway', object: 'chat.completion.chunk', model: data.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'native gateway response' }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'native-gateway', object: 'chat.completion.chunk', model: data.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayEnv = {
    ...env,
    CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'gateway-data'),
  };
  delete gatewayEnv.CIRCLE_DESKTOP_RUNTIME_FIXTURE;
  app = await electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [appPath],
    cwd: root,
    env: gatewayEnv,
    timeout: 45_000,
  });
  page = await app.firstWindow();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  assert.equal((await state()).runtime.configured, false);
  await send('/login');
  await page
    .getByRole('textbox', { name: 'base url', exact: true })
    .fill(`http://127.0.0.1:${gateway.address().port}/v1`);
  await page
    .getByRole('textbox', { name: 'api key', exact: true })
    .fill('native-local-key');
  await page
    .getByLabel('connection model', { exact: true })
    .fill('native-fixture-model');
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await waitFor(
    async () => (await state()).runtime.configured,
    'saved connection',
  );
  assert.equal(
    await page.evaluate(() =>
      Object.values(localStorage).join('').includes('native-local-key'),
    ),
    false,
  );
  checks.push(
    'clean first launch supports native login and excludes the API key from frontend storage',
  );
  await send('/effort high');
  await waitFor(
    async () => (await state()).sessions[0].effort === 'high',
    'effort',
  );
  await send('call the local gateway');
  await page.getByText('native gateway response', { exact: true }).waitFor();
  assert.equal(gatewayRequests.length, 1);
  assert.equal(gatewayRequests[0].model, 'native-fixture-model');
  assert.equal(gatewayRequests[0].reasoning_effort, 'high');
  checks.push(
    'normal native GatewayModel sends a real request to the isolated HTTP fixture with selected model and effort',
  );
  await writeFile(
    join(
      output,
      process.env.CIRCLE_DESKTOP_EXECUTABLE
        ? 'packaged-receipt.json'
        : 'development-receipt.json',
    ),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode: 'live',
        packaged: info.packaged,
        appPath,
        dataIsolation: true,
        scriptedModel: true,
        externalNodeRequired: false,
        source: firstSource,
        renderer,
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { checks: checks.length, packaged: info.packaged, output },
      null,
      2,
    ),
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
