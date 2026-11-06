// A background job that ends while nothing runs, through the sandboxed renderer and the
// real worker: its row in the overview says it is done, and the model goes on by itself.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { patience } from './helpers/patience.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-job-wake-native-'));
const output = join(
  root,
  'artifacts/job-wake',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
const data = join(temp, 'data');
await mkdir(join(data, 'runtime-home', 'cache'), { recursive: true });
await writeFile(
  join(data, 'runtime-home', 'cache', 'models-dev.json'),
  JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
);
const requestsPath = join(temp, 'requests.jsonl');
const fixturePath = join(temp, 'model.json');
const gate = join(temp, 'gate');
const script = `const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);console.log('suite output')}},20)`;
const encoded = Buffer.from(script).toString('base64');
const title = 'Verify desktop runtime suite';
const usage = { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0 };
await writeFile(
  fixturePath,
  JSON.stringify({
    model: 'fixture-model',
    requestsPath,
    replies: [
      {
        message: {
          id: 'start-job',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'suite',
              name: 'execute',
              args: {
                command: `node -e "eval(Buffer.from('${encoded}','base64').toString())"`,
                description: title,
                background: true,
              },
            },
          ],
        },
        usage,
      },
      {
        message: {
          id: 'waiting',
          role: 'assistant',
          content: 'waiting for the suite',
        },
        usage,
      },
      {
        message: {
          id: 'woken',
          role: 'assistant',
          content: 'the suite passed, carrying on',
        },
        usage,
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
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';
const errors = [];
let app;
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 45000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(patience(15000));
  page.on('pageerror', (error) => errors.push(String(error)));
  const box = page.getByRole('textbox', { name: 'message', exact: true });
  await box.waitFor();
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.frontendOnly, false);
  const state = () =>
    page.evaluate(
      async () => (await window.circleDesktop.runtimeState()).snapshot,
    );
  const until = async (check, description) => {
    const deadline = Date.now() + patience(15000);
    while (!(await check())) {
      assert(Date.now() < deadline, description);
      await new Promise((done) => setTimeout(done, 20));
    }
  };

  await box.fill('run the suite in the background');
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await until(
    async () => (await state()).interactions.length > 0,
    'the command asks for approval',
  );
  const [card] = (await state()).interactions;
  const answered = await page.evaluate(
    ({ id, revision, sessionId }) =>
      window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        name: 'answer',
        payload: { id, revision, answer: 'approve' },
        sessionId,
      }),
    card,
  );
  assert.equal(answered.ok, true, answered.error);
  await page.getByText('waiting for the suite', { exact: true }).waitFor();

  const row = page
    .locator('section.overview-card[aria-labelledby="overview-jobs"]')
    .locator('.overview-row')
    .filter({ hasText: title });
  await row.waitFor();
  assert.equal(
    await row.locator('.overview-dot').getAttribute('data-state'),
    'run',
  );
  await page.screenshot({ path: join(output, 'running.png') });

  await writeFile(gate, '');
  await row
    .locator('.overview-end-text')
    .getByText('done', { exact: true })
    .waitFor();
  assert.equal(
    await row.locator('.overview-dot').getAttribute('data-state'),
    'done',
  );
  await page
    .getByText('the suite passed, carrying on', { exact: true })
    .waitFor();
  await until(
    async () => (await state()).sessions[0].state === 'idle',
    'the turn the job started ends',
  );
  await page.screenshot({ path: join(output, 'done.png') });

  const requests = (await readFile(requestsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((request) =>
      request.messages.some((message) => message.role === 'user'),
    );
  const notices = requests
    .at(-1)
    .messages.filter((message) => message.internal === 'job_notice');
  assert.equal(notices.length, 1, 'the model is told the job ended');
  assert.match(notices[0].content, /suite output/);
  const session = (await state()).sessions[0];
  assert.deepEqual(
    session.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.text),
    ['run the suite in the background'],
    'the conversation has no row for the notice',
  );
  assert.equal(await page.getByText('background-job notice').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      job: title,
      packaged: info.packaged,
      requests: requests.length,
      output,
    }),
  );
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
