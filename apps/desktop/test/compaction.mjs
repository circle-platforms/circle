// Real native main/preload/worker/renderer, isolated data, no visible window or
// global keyboard input. Run identically against development and packaged apps.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { patience } from './helpers/patience.mjs';
import { RUNTIME_RESTART_DELAY_MS } from '../src/runtime-exit.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-native-compaction-'));
const data = join(temp, 'data');
const home = join(data, 'runtime-home');
const workspace = join(home, 'tasks', 'compaction-fixture');
const output = resolve(
  root,
  '../../outputs/compaction-native',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(workspace, { recursive: true });
await mkdir(output, { recursive: true });
await mkdir(join(home, 'cache'), { recursive: true });
await writeFile(
  join(home, 'cache', 'models-dev.json'),
  JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
);
saveSettings(trustFolder(defaultSettings(), workspace), home);
const sessionId = 'circle-compaction-native';
function seed(prefix) {
  const store = new CheckpointStore(home);
  try {
    if (!store.get(sessionId))
      store.create(
        workspace,
        'compaction-fixture',
        'Compaction fixture',
        sessionId,
      );
    const messages = Array.from({ length: 20 }, (_, n) => ({
      id: prefix + n,
      role: n % 2 ? 'assistant' : 'user',
      content:
        n % 2
          ? 'A synthetic step completed.'
          : 'Synthetic history data. '.repeat(2200),
    }));
    store.append(sessionId, messages);
  } finally {
    store.close();
  }
}
seed('initial-');
const fixturePath = join(temp, 'fixture.json');
const journal = join(temp, 'requests.jsonl');
const gate = join(temp, 'release-summary');
const secondGate = join(temp, 'release-after-restart');
const checks = [];
const errors = [];
const reply = (hold) => ({
  chunks: [
    'synthetic summary progress',
    ...(hold ? [{ waitForFile: hold }] : []),
  ],
  message: {
    id: randomUUID(),
    role: 'assistant',
    content:
      'A complete synthetic checkpoint. Original evidence remains in the archived history.',
    completion: { reason: 'stop', provider_reason: 'end_turn' },
  },
  usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0 },
});
async function fixture(replies) {
  await writeFile(
    fixturePath,
    JSON.stringify({
      model: 'compaction-fixture',
      contextWindow: 200000,
      outputLimit: 32000,
      outputBudget: 32000,
      requestsPath: journal,
      replies,
    }),
  );
}
await fixture([
  {
    message: {
      id: 'overflow',
      role: 'assistant',
      content: 'incomplete synthetic summary',
      completion: {
        reason: 'length',
        provider_reason: 'model_context_window_exceeded',
        output_limit: 32000,
      },
    },
    usage: { input_tokens: 100, output_tokens: 3, cache_read_tokens: 0 },
  },
  ...Array.from({ length: 64 }, () => reply(gate)),
]);
const env = {
  ...process.env,
  CIRCLE_HOME: home,
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
  CIRCLE_WORKBENCH_BACKGROUND_TEST: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';
let app, page;
let nativeErrors = '';
const until = async (check, description) => {
  const end = Date.now() + patience(20000);
  while (!(await check())) {
    assert(Date.now() < end, description);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const state = () =>
  page.evaluate(
    async () => (await window.circleDesktop.runtimeState()).snapshot,
  );
const command = (name, payload = {}, id = sessionId) =>
  page.evaluate(
    async ({ name, payload, id }) =>
      window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        name,
        payload,
        sessionId: id,
      }),
    { name, payload, id },
  );
const selected = async () =>
  (await state()).sessions.find((s) => s.id === sessionId);
const requestCount = async () => {
  try {
    return (await readFile(journal, 'utf8')).trim().split('\n').filter(Boolean)
      .length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
};
async function launch() {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 45000,
  });
  page = await app.firstWindow();
  app.process().stderr?.on('data', (chunk) => {
    nativeErrors += String(chunk);
  });
  page.setDefaultTimeout(patience(15000));
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  assert.equal(
    (
      await command(
        'select-session',
        { id: sessionId },
        (await state()).activeSessionId,
      )
    ).ok,
    true,
  );
  await page.evaluate((id) => {
    location.hash = '/session/' + id;
  }, sessionId);
  await page
    .getByRole('textbox', { name: /message|消息/, exact: true })
    .waitFor();
  const windows = await app.evaluate(({ BrowserWindow }) => ({
    visible: BrowserWindow.getAllWindows().some((w) => w.isVisible()),
    focused: Boolean(BrowserWindow.getFocusedWindow()),
  }));
  assert.deepEqual(windows, { visible: false, focused: false });
}
async function checkProgressLayout() {
  const status = page.getByTestId('compaction-progress');
  const composer = page.locator('.composer-area .composer');
  const progressBox = await status.boundingBox();
  const inputBox = await composer.boundingBox();
  assert.ok(progressBox && inputBox);
  assert.ok(
    Math.abs(progressBox.x - inputBox.x) < 1,
    'progress aligns with the input',
  );
  assert.ok(Math.abs(progressBox.width - inputBox.width) < 1);
  assert.ok(
    Math.abs(inputBox.y - (progressBox.y + progressBox.height) - 8) < 1,
    'progress sits directly above the input',
  );
  assert.equal(
    await page.getByTestId('turn-clock').count(),
    0,
    'one compaction status, no duplicate turn clock',
  );
  assert.doesNotMatch(
    await status.innerText(),
    /↑|↓|usage|用量|auto-compacting|自动压缩/,
  );
  assert.ok(
    await status.evaluate((node) => node.scrollWidth <= node.clientWidth),
    'progress never overflows',
  );
}
try {
  await launch();
  assert.equal(
    (await command('prompt', { text: 'Continue the synthetic task.' })).ok,
    true,
  );
  await until(
    async () => (await selected()).compaction?.liveTokens > 0,
    'native summary progress',
  );
  const first = (await selected()).compaction;
  assert.equal(first.status, 'running');
  assert.notEqual(first.trigger, 'tool');
  assert.equal(first.budget.window, 200000);
  assert.ok(
    (await selected()).turn,
    'automatic compaction remains part of its normal turn',
  );
  assert.ok(first.recoveries >= 1);
  await page.getByTestId('compaction-progress').waitFor();
  const worker = (await state()).runtime.processId;
  const heldCount = await requestCount();
  await page.reload();
  await page.getByTestId('compaction-progress').waitFor();
  assert.equal((await state()).runtime.processId, worker);
  assert.equal((await selected()).compaction.operationId, first.operationId);
  assert.equal(await requestCount(), heldCount);
  checks.push(
    'renderer reload restores automatic compaction progress without replay',
  );
  for (const theme of ['dark', 'light']) {
    assert.equal(
      (await command('save-settings', { settings: { theme } })).ok,
      true,
    );
    await page.waitForFunction(
      (value) => document.documentElement.dataset.theme === value,
      theme,
    );
    await page.setViewportSize({ width: 800, height: 700 });
    await checkProgressLayout();
    await page.screenshot({
      path: join(output, 'compaction-en-' + theme + '.png'),
    });
  }
  await page.setViewportSize({ width: 560, height: 700 });
  await checkProgressLayout();
  await page.screenshot({ path: join(output, 'compaction-en-narrow.png') });
  await page.setViewportSize({ width: 800, height: 700 });
  await page.evaluate(() => {
    location.hash = '/page/settings';
  });
  await page.getByRole('button', { name: '简体中文', exact: true }).click();
  await page.evaluate((id) => {
    location.hash = '/session/' + id;
  }, sessionId);
  await page
    .getByTestId('compaction-progress')
    .filter({ hasText: '正在' })
    .waitFor();
  assert.match(
    await page.getByTestId('compaction-progress').innerText(),
    /正在压缩 \d+\/\d+/,
  );
  for (const theme of ['dark', 'light']) {
    assert.equal(
      (await command('save-settings', { settings: { theme } })).ok,
      true,
    );
    await page.waitForFunction(
      (value) => document.documentElement.dataset.theme === value,
      theme,
    );
    await checkProgressLayout();
    await page.screenshot({ path: join(output, `compaction-zh-${theme}.png`) });
  }
  checks.push(
    'one concise progress line aligns with the input in both languages, themes and narrow windows',
  );
  await writeFile(gate, 'release');
  await until(
    async () => (await selected()).compaction?.status === 'succeeded',
    'native compaction success',
  );
  await until(
    async () => (await selected()).state === 'idle',
    'the original turn resumes after compaction',
  );
  const completed = await selected();
  assert.equal(completed.compaction.covered, completed.compaction.sourceSize);
  assert.ok(completed.compaction.attempts > 1);
  assert.equal(completed.meters.contextEstimated, false);
  assert.equal(
    completed.compaction.usage.input_tokens,
    completed.compaction.attempts * 100,
  );
  assert.equal(
    completed.compaction.usage.output_tokens,
    3 + (completed.compaction.attempts - 1) * 20,
  );
  assert.equal(
    completed.messages.filter(
      (m) => m.compaction?.operationId === first.operationId,
    ).length,
    1,
  );
  checks.push(
    'context-limit recovery completes, covers history and updates estimated context',
  );
  await page.evaluate(() => {
    location.hash = '/page/settings';
  });
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await app.close();
  app = undefined;

  seed('additional-');
  await fixture(Array.from({ length: 64 }, () => reply(secondGate)));
  await launch();
  const autoBefore = await requestCount();
  assert.equal(
    (
      await command('prompt', {
        text: 'Start the cancellable automatic compaction.',
      })
    ).ok,
    true,
  );
  await until(
    async () => (await selected()).compaction?.liveTokens > 0,
    'cancellable automatic compaction',
  );
  const autoCancelled = (await selected()).compaction.operationId;
  assert.ok((await selected()).turn);
  const input = page.getByRole('textbox', { name: 'message', exact: true });
  await input.fill('keep this draft');
  await page
    .getByRole('button', { name: 'pause conversation', exact: true })
    .click();
  await until(
    async () =>
      (await selected()).compaction?.status === 'cancelled' &&
      (await selected()).state === 'idle',
    'automatic compaction cancelled with its turn',
  );
  assert.equal(await input.inputValue(), 'keep this draft');
  assert.equal(
    (await selected()).messages.filter(
      (m) => m.compaction?.operationId === autoCancelled,
    ).length,
    1,
  );
  assert.equal(
    (await selected()).messages.filter((m) => m.id.startsWith('failure-'))
      .length,
    0,
    'automatic cancellation has no duplicate turn error',
  );
  assert.equal(
    (await selected()).messages.filter((m) => m.id.startsWith('interrupted-'))
      .length,
    0,
  );
  assert.equal(await requestCount(), autoBefore + 1);
  checks.push(
    'automatic compaction cancellation ends its turn, keeps the draft and records one interruption',
  );
  const before = await requestCount();
  assert.equal((await command('compact')).ok, true);
  await until(
    async () => (await selected()).compaction?.liveTokens > 0,
    'cancellable native compaction',
  );
  const cancelling = (await selected()).compaction;
  await page.getByTestId('compaction-progress').waitFor();
  await checkProgressLayout();
  assert.equal(
    (await selected()).turn,
    undefined,
    'manual compaction does not invent an assistant turn',
  );
  await input.fill('keep this draft');
  assert.equal(
    (await command('abort', { compactionOperationId: autoCancelled })).ok,
    true,
  );
  assert.equal((await selected()).compaction.status, 'running');
  await page
    .getByRole('button', { name: 'pause conversation', exact: true })
    .click();
  await until(
    async () => (await selected()).compaction?.status === 'cancelled',
    'native cancel',
  );
  assert.equal(await input.inputValue(), 'keep this draft');
  assert.equal(
    (await selected()).messages.filter(
      (m) => m.compaction?.operationId === cancelling.operationId,
    ).length,
    1,
  );
  assert.equal(await requestCount(), before + 1);
  checks.push(
    'operation-bound cancellation keeps the draft and one persistent result',
  );

  assert.equal((await command('compact')).ok, true);
  await until(
    async () => (await selected()).compaction?.liveTokens > 0,
    'compaction before worker crash',
  );
  const crashed = (await selected()).compaction.operationId;
  const runtimePid = (await state()).runtime.processId;
  assert.notEqual(runtimePid, process.pid);
  assert.notEqual(runtimePid, app.process().pid);
  assert(
    await app.evaluate(
      ({ app }, pid) => app.getAppMetrics().some((row) => row.pid === pid),
      runtimePid,
    ),
  );
  const beforeCrash = await requestCount();
  await page.evaluate(
    ({ priorPid, sessionId, deadline }) => {
      window.__compactionRestart = new Promise((resolve, reject) => {
        const unsubscribe = window.circleDesktop.onRuntime((update) => {
          const next = update.snapshot;
          if (!next.runtime?.connected)
            window.__compactionStoppedStatus = next.sessions.find(
              (s) => s.id === sessionId,
            )?.compaction?.status;
          if (
            next.runtime?.connected &&
            next.runtime.processId !== priorPid &&
            next.sessions.find((s) => s.id === sessionId)?.compaction
              ?.status === 'interrupted'
          ) {
            clearTimeout(timer);
            unsubscribe();
            resolve(true);
          }
        });
        const timer = setTimeout(() => {
          unsubscribe();
          reject(
            new Error(
              'worker restart did not restore recoverable compaction after its lease wait',
            ),
          );
        }, deadline);
      });
    },
    {
      priorPid: runtimePid,
      sessionId,
      deadline: RUNTIME_RESTART_DELAY_MS + patience(20000),
    },
  );
  process.kill(runtimePid, 'SIGKILL'); // Only the utility process of this isolated test app.
  await until(
    () =>
      page.evaluate(() => window.__compactionStoppedStatus === 'interrupted'),
    'worker exit retires live compaction immediately',
  );
  await page.evaluate(() => window.__compactionRestart);
  assert.equal((await selected()).compaction.operationId, crashed);
  assert.ok((await selected()).compaction.unknownCalls >= 1);
  assert.equal(
    await requestCount(),
    beforeCrash,
    'opening/restarting never resends the failed request',
  );
  assert.equal(await input.inputValue(), 'keep this draft');
  await writeFile(secondGate, 'release');
  assert.equal((await command('compact')).ok, true);
  await until(
    async () => (await selected()).compaction?.status === 'succeeded',
    'explicit native resume',
  );
  const resumed = await selected();
  assert.equal(resumed.compaction.covered, resumed.compaction.sourceSize);
  assert.equal(resumed.meters.contextEstimated, true);
  assert.equal(
    new Set(resumed.messages.filter((m) => m.compaction).map((m) => m.id)).size,
    resumed.messages.filter((m) => m.compaction).length,
  );
  checks.push(
    'worker restart preserves progress and requires an explicit resume',
  );
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        checks,
        packaged: info.packaged,
        hiddenWindow: true,
        requests: await requestCount(),
        operationIds: resumed.messages
          .filter((m) => m.compaction)
          .map((m) => m.compaction.operationId),
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ checks: checks.length, packaged: info.packaged, output }),
  );
} catch (error) {
  const observed = await state().catch((failure) => ({
    error: String(failure),
  }));
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify(
      {
        error: String(error),
        runtime: observed.runtime,
        activeSessionId: observed.activeSessionId,
        sessions: observed.sessions?.map((s) => ({
          id: s.id,
          state: s.state,
          compaction: s.compaction,
        })),
        requests: await requestCount(),
        nativeErrors,
      },
      null,
      2,
    ),
  );
  for (const file of ['runtime.log', 'main.log']) {
    try {
      await writeFile(
        join(output, file),
        await readFile(join(data, 'logs', file)),
      );
    } catch {}
  }
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
