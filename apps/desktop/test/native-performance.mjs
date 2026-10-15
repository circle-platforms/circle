/** Run serially after build, in both development and packaged app paths.
 * node --import tsx apps/desktop/test/native-performance.mjs
 * Uses real Electron, persisted history, eight scripted streaming AgentRuntimes,
 * native PTY and disk effects. No live model, production account or fake UI state.
 */
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  preserveNativeClipboard,
  restoreNativeClipboardWithRecovery,
} from './helpers/native-clipboard.mjs';
import {
  performanceMessages,
  PERFORMANCE_RAW_MESSAGES,
  PERFORMANCE_PROJECTED_MESSAGES,
} from './helpers/native-performance-fixture.mjs';
import {
  executedNativeBuildEvidence,
  verifyNativeBuildManifest,
} from './helpers/native-build-manifest.mjs';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';
import {
  journeyBundledNodeFromApp,
  assertBundledJourneyNode,
  journeyNodeCommand,
} from './helpers/native-journey-platform.mjs';
const exec = promisify(execFile);
const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-native-performance-'));
const outputBase = resolve(
  process.env.CIRCLE_NATIVE_PERF_OUTPUT ?? join(temp, 'evidence'),
);
const output = join(
  outputBase,
  `attempt-${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID().slice(0, 8)}`,
);
await mkdir(output, { recursive: true });
const workspace = join(temp, 'workspace');
const data = join(temp, 'data');
const home = join(data, 'runtime-home');
await mkdir(workspace);
await mkdir(home, { recursive: true });
const mainSession = 'perf-history';
const otherSession = 'perf-alternate';
const pngBytes = await readFile(
  new URL('./fixtures/performance-original.png', import.meta.url),
);
const png = pngBytes.toString('base64');
const log = Array.from(
  { length: 600 },
  (_, index) =>
    `PERF_LOG_${String(index + 1).padStart(4, '0')} ${'complete original '.repeat(6)}`,
).join('\n');
await writeFile(
  join(workspace, 'README.md'),
  '# PERF_README\n\nperformance source\n',
);
await writeFile(
  join(workspace, 'SECOND.md'),
  '# PERF_SECOND\n\nalternate source\n',
);
await writeFile(
  join(workspace, 'pty-log.cjs'),
  'let n=0;setInterval(()=>console.log("NATIVE_PERF "+Date.now()+" "+n++),50);',
);
await exec('git', ['init', workspace]);
await exec('git', [
  '-C',
  workspace,
  'add',
  'README.md',
  'SECOND.md',
  'pty-log.cjs',
]);
await exec('git', [
  '-C',
  workspace,
  '-c',
  'user.name=Circle test',
  '-c',
  'user.email=circle-test@example.invalid',
  'commit',
  '-m',
  'Create isolated performance fixture',
]);
const settings = trustFolder(defaultSettings(), workspace);
settings.workspace_folder = workspace;
saveSettings(settings, home);
const store = new CheckpointStore(home);
store.create(workspace, 'fixture', 'performance alternate', otherSession);
store.append(otherSession, [
  {
    id: 'alternate-answer',
    role: 'assistant',
    content: 'PERF_ALTERNATE_READY',
  },
]);
store.create(workspace, 'fixture', 'performance history', mainSession);
const messages = performanceMessages({ png, log });
store.append(mainSession, messages);
assert.equal(store.messages(mainSession).length, PERFORMANCE_RAW_MESSAGES);
store.close();
await writeFile(
  join(home, 'desktop-session.json'),
  JSON.stringify({ workspace, sessionId: mainSession }),
);
const fixture = join(temp, 'model.json');
await writeFile(
  fixture,
  JSON.stringify({
    replies: Array.from({ length: 8 }, (_, agent) => ({
      chunks: Array.from(
        { length: 24000 },
        (_, index) => `agent ${agent} progress ${index} `,
      ),
      delayMs: 40,
      message: {
        id: `stream-${agent}`,
        role: 'assistant',
        content: 'performance stream completed',
      },
    })),
  }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({ workspace }),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron');
const appPath = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? desktopRoot);
const samples = {
  inputKeystroke: [],
  inputPaste: [],
  click: [],
  sessionSwitch: [],
  fileSwitch: [],
  save: [],
  eventToFrame: [],
};
const errors = [];
const checks = [];
let app;
let page;
let terminalId;
let taskIds = [];
let clipboardBefore;
const report = {
  schema: 1,
  startedAt: new Date().toISOString(),
  temp,
  workspace,
  executable,
  appPath,
  workload: {
    persistedMessages: PERFORMANCE_RAW_MESSAGES,
    projectedMessages: PERFORMANCE_PROJECTED_MESSAGES,
    activeStreamingAgents: 8,
    agentChunkIntervalMs: 40,
    ptyIntervalMs: 50,
  },
  fixtureImage: {
    sha256: createHash('sha256').update(pngBytes).digest('hex'),
    bytes: pngBytes.length,
    source: 'synthetic native browser capture, development-attempt12, 375x812',
  },
  samples,
  checks,
  errors,
  metrics: {},
  complete: false,
};
const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
};
async function state() {
  return (await page.evaluate(() => window.circleDesktop.runtimeState()))
    .snapshot;
}
async function call(name, payload = {}, sessionId = mainSession) {
  const reply = await page.evaluate(
    async (input) =>
      window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        ...input,
      }),
    { name, payload, sessionId },
  );
  if (!reply.ok) throw Error(reply.error);
  return reply.data;
}
const service = (name, method, params = {}, sessionId = mainSession) =>
  call('workspace-service', { service: name, method, params }, sessionId);
async function waitFor(test, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!(await test())) {
    if (Date.now() > deadline) throw Error(`timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 30));
  }
}
async function arm(kind, selector, condition) {
  await page.evaluate(
    ({ kind, selector, condition }) => {
      window.__circleNativePerfPending = new Promise((resolve, reject) => {
        let started;
        let frames = 0;
        const timeout = setTimeout(() => {
          cleanup();
          reject(Error('visible feedback timed out'));
        }, 10000);
        const cleanup = () => {
          clearTimeout(timeout);
          document.removeEventListener(kind, begin, true);
        };
        const ready = () => {
          const target = document.querySelector(condition.selector);
          if (!target) return false;
          if (condition.feedback) {
            const feedback = document.querySelector(
              condition.feedback.selector,
            );
            if (!feedback || feedback.disabled !== condition.feedback.disabled)
              return false;
          }
          if (condition.attribute)
            return (
              target.getAttribute(condition.attribute) === condition.equals
            );
          if (condition.value !== undefined)
            return target.value === condition.value;
          return (target.textContent ?? '').includes(condition.text);
        };
        const frame = () => {
          if (ready()) {
            if (++frames >= 2) {
              cleanup();
              resolve(performance.now() - started);
              return;
            }
          } else frames = 0;
          requestAnimationFrame(frame);
        };
        const begin = (event) => {
          if (started !== undefined || !event.target.closest(selector)) return;
          started = performance.now();
          requestAnimationFrame(frame);
        };
        document.addEventListener(kind, begin, true);
      });
    },
    { kind, selector, condition },
  );
}
async function finish(metric) {
  const value = await page.evaluate(() => window.__circleNativePerfPending);
  assert.ok(Number.isFinite(value));
  samples[metric].push(value);
}
try {
  app = await electron.launch({
    executablePath: executable,
    args: [appPath],
    cwd: desktopRoot,
    env,
    chromiumSandbox: true,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.bringToFront();
  report.driverHead = (
    await exec('git', ['-C', desktopRoot, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  const manifestPath = process.env.CIRCLE_NATIVE_PERF_BUILD_MANIFEST;
  if (!manifestPath)
    throw Error(
      'CIRCLE_NATIVE_PERF_BUILD_MANIFEST is required before clipboard or stress actions',
    );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  report.executedBuild = verifyNativeBuildManifest(
    manifest,
    await executedNativeBuildEvidence(app, manifest),
  );
  report.sourceBuildHead = report.executedBuild.sourceBuildHead;
  report.buildManifestPath = manifestPath;
  report.source = await sourceEvidence();
  report.renderer = await rendererEvidence(desktopRoot);
  report.appInfo = await page.evaluate(() => window.circleDesktop.info());
  await waitFor(
    async () => {
      const snapshot = await state();
      return (
        snapshot.runtime?.connected &&
        snapshot.activeSessionId === mainSession &&
        snapshot.sessions.find((s) => s.id === mainSession)?.messages.length ===
          PERFORMANCE_PROJECTED_MESSAGES
      );
    },
    '10k history loaded',
    60000,
  );
  report.initialTranscript = await page
    .locator('.transcript')
    .evaluate((node) => {
      const frame = node.getBoundingClientRect();
      const messages = [...node.querySelectorAll('.message')];
      return {
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        mountedMessages: messages.length,
        visibleMessages: messages.filter((message) => {
          const rect = message.getBoundingClientRect();
          return (
            rect.height > 0 &&
            rect.bottom > frame.top &&
            rect.top < frame.bottom
          );
        }).length,
        firstMessageRect: messages[0]?.getBoundingClientRect().toJSON(),
      };
    });
  await page.screenshot({ path: join(output, 'initial-transcript.png') });
  report.initialTranscriptPassed = report.initialTranscript.visibleMessages > 0;
  if (!report.initialTranscriptPassed)
    report.initialTranscriptFailure =
      '10k history loaded with no mounted message intersecting the visible transcript; later scrolling is an explicit stress setup, not recovery acceptance';
  report.stressSetup =
    'explicitly navigate transcript top then bottom to reveal the tail of virtualized history';
  await page.locator('.transcript').evaluate(async (node) => {
    node.scrollTo({ top: 0 });
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    node.scrollTo({ top: node.scrollHeight });
  });
  await page
    .locator('.transcript')
    .getByText('PERF_HISTORY_READY', { exact: false })
    .waitFor();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  clipboardBefore = await preserveNativeClipboard(app);
  taskIds = Array.from(
    { length: 8 },
    (_, index) => `performance-agent-${index}`,
  );
  await service('tasks', 'settings', {
    limits: { agents: 8, builds: 2, ui: 1, browsers: 1 },
  });
  await service('tasks', 'enqueue', {
    operationId: crypto.randomUUID(),
    tasks: taskIds.map((id) => ({
      id,
      prompt:
        'Stream deterministic progress while the developer edits. Do not change files.',
      access: 'readonly',
      acceptanceCriteria: ['maintain the read-only baseline'],
      dependencies: [],
    })),
  });
  await service('tasks', 'start');
  await waitFor(
    async () => {
      const tasks = await service('tasks', 'list');
      return taskIds.every((id) =>
        tasks.some((task) => task.spec.id === id && task.state === 'running'),
      );
    },
    'eight actual running task attempts',
    60000,
  );
  assert.equal(
    (await state()).activeSessionId,
    mainSession,
    'background task startup must retain the developer conversation',
  );
  await page
    .getByRole('button', { name: 'terminal', exact: true })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'new terminal', exact: true })
    .first()
    .click();
  await page.locator('.xterm').first().waitFor();
  const terminals = await service('terminal', 'list');
  terminalId = terminals[0].id;
  const appIdentity = await app.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  }));
  const bundledNode = journeyBundledNodeFromApp(appIdentity);
  report.producerRuntime = await assertBundledJourneyNode(bundledNode);
  await service('terminal', 'write', {
    id: terminalId,
    data: journeyNodeCommand(bundledNode, join(workspace, 'pty-log.cjs')),
  });
  await page.evaluate(() => {
    window.__circleNativePerfEvents = [];
    const seen = new Set();
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          scheduled = false;
          const text = [
            ...document.querySelectorAll('.xterm-accessibility-tree'),
          ]
            .map((node) => node.textContent)
            .join('\n');
          for (const match of text.matchAll(
            /NATIVE_PERF\s+(\d{13})\s+(\d+)/g,
          )) {
            const id = match[1] + ':' + match[2];
            if (seen.has(id)) continue;
            seen.add(id);
            window.__circleNativePerfEvents.push({
              sourceAt: Number(match[1]),
              sampleAt: Date.now(),
              ms: Date.now() - Number(match[1]),
            });
          }
        }),
      );
    });
    observer.observe(document.querySelector('.xterm') ?? document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__circleNativePerfObserver = observer;
  });
  const input = page.getByRole('textbox', { name: 'message', exact: true });
  // Empty/nonempty transitions require React-derived Send state, not only
  // the browser's native textarea value. Keystrokes and whole-input paste
  // updates are reported separately; neither waits for a model request.
  await input.fill('');
  await page
    .getByRole('button', { name: 'send message', exact: true })
    .waitFor();
  for (let index = 0; index < 40; index++) {
    const value = index % 2 ? '' : 'x';
    await arm('input', 'textarea[aria-label="message"]', {
      selector: 'textarea[aria-label="message"]',
      value,
      feedback: {
        selector: 'button[aria-label="send message"]',
        disabled: !value,
      },
    });
    await input.press(index % 2 ? 'Backspace' : 'x');
    await finish('inputKeystroke');
  }
  const longPaste = Array.from(
    { length: 600 },
    (_, line) => `full pasted line ${line} ${'developer input '.repeat(4)}`,
  ).join('\n');
  report.inputWorkloads = {
    keystrokes: 40,
    wholeInputUpdates: 40,
    longPasteLines: 600,
    longPasteCharacters: longPaste.length,
  };
  for (let index = 0; index < 40; index++) {
    const value = index % 2 ? '' : longPaste;
    await arm('input', 'textarea[aria-label="message"]', {
      selector: 'textarea[aria-label="message"]',
      value,
      feedback: {
        selector: 'button[aria-label="send message"]',
        disabled: !value,
      },
    });
    await input.fill(value);
    await finish('inputPaste');
  }
  for (let index = 0; index < 40; index++) {
    const label = index % 2 ? 'task layout' : 'developer layout';
    const button = page.getByRole('button', { name: label, exact: true });
    await button.evaluate((node) => (node.dataset.perfTarget = 'layout'));
    await arm('click', '[data-perf-target="layout"]', {
      selector: '[data-perf-target="layout"]',
      attribute: 'aria-pressed',
      equals: 'true',
    });
    await button.click();
    await finish('click');
  }
  await input.fill('retained developer draft');
  await input.evaluate((node) => {
    node.focus();
    node.setSelectionRange(3, 10);
  });
  await page
    .getByRole('button', { name: 'developer layout', exact: true })
    .click();
  assert.deepEqual(
    await input.evaluate((node) => ({
      value: node.value,
      start: node.selectionStart,
      end: node.selectionEnd,
    })),
    { value: 'retained developer draft', start: 3, end: 10 },
  );
  checks.push('layout retains actual composer value and selection');
  await waitFor(
    async () =>
      await page.evaluate(() => window.__circleNativePerfEvents.length >= 60),
    '60 continuously visible producer-to-frame samples',
    20000,
  );
  const events = await page.evaluate(() => {
    window.__circleNativePerfObserver.disconnect();
    return window.__circleNativePerfEvents;
  });
  samples.eventToFrame.push(
    ...events
      .slice(10)
      .filter((value) => value.ms >= 0)
      .map((value) => value.ms),
  );
  report.eventRaw = events;
  const switchSession = async (title) => {
    await input.press(
      process.platform === 'darwin' ? 'Meta+k' : 'Control+Shift+p',
    );
    await page
      .getByRole('textbox', { name: 'global search', exact: true })
      .fill(title);
    const result = page
      .locator('.search-results button')
      .filter({ hasText: title })
      .first();
    await result.evaluate((node) => (node.dataset.perfTarget = 'switch'));
    await arm('click', '[data-perf-target="switch"]', {
      selector: '.transcript',
      text:
        title === 'performance history'
          ? 'PERF_HISTORY_READY'
          : 'PERF_ALTERNATE_READY',
    });
    await result.click();
    await finish('sessionSwitch');
  };
  for (let index = 0; index < 24; index++)
    await switchSession(
      index % 2 ? 'performance history' : 'performance alternate',
    );
  await page
    .locator('.transcript')
    .evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
  const openSource = async (name, marker) => {
    const link = page.locator(`a[href="${name}#L1"]`).first();
    await link.evaluate((node) => (node.dataset.perfTarget = 'file'));
    await arm('click', '[data-perf-target="file"]', {
      selector: '.monaco-editor .view-lines',
      text: marker,
    });
    await link.click();
    await finish('fileSwitch');
  };
  for (let index = 0; index < 24; index++)
    await openSource(
      index % 2 ? 'README.md' : 'SECOND.md',
      index % 2 ? 'PERF_README' : 'PERF_SECOND',
    );
  await page.getByRole('button', { name: 'edit', exact: true }).click();
  const editor = page.locator('.monaco-editor textarea').first();
  for (let index = 0; index < 24; index++) {
    await editor.focus();
    await editor.press(
      process.platform === 'darwin' ? 'Meta+End' : 'Control+End',
    );
    await editor.press('Enter');
    await editor.type(`saved performance ${index}`);
    await waitFor(
      async () =>
        await page
          .locator('.file-view-toolbar')
          .textContent()
          .then((text) => text.includes('unsaved buffer')),
      'unsaved editor buffer',
    );
    const save = page.getByRole('button', {
      name: 'save to disk',
      exact: true,
    });
    await save.evaluate((node) => (node.dataset.perfTarget = 'save'));
    await arm('click', '[data-perf-target="save"]', {
      selector: '.file-view-toolbar',
      text: 'disk and buffer match',
    });
    await save.click();
    await finish('save');
    assert.ok(
      (await readFile(join(workspace, 'README.md'), 'utf8')).includes(
        `saved performance ${index}`,
      ),
    );
  }
  checks.push(
    'each save completed a real disk write while eight agents stream',
  );
  await page.getByRole('button', { name: 'close file', exact: true }).click();
  const scrollBeforeImage = await page
    .locator('.transcript')
    .evaluate((node) => node.scrollTop);
  await page
    .getByRole('button', { name: 'performance-original.png', exact: true })
    .click();
  const image = page.getByRole('dialog').locator('img');
  await image.waitFor();
  assert.equal(await image.getAttribute('src'), `data:image/png;base64,${png}`);
  assert.equal(
    await image.evaluate(
      (node) =>
        node.complete && node.naturalWidth > 0 && node.naturalHeight > 0,
    ),
    true,
    'historical original PNG decodes into visible image pixels',
  );
  await page.getByRole('button', { name: 'close dialog', exact: true }).click();
  assert.ok(
    Math.abs(
      (await page.locator('.transcript').evaluate((node) => node.scrollTop)) -
        scrollBeforeImage,
    ) <= 2,
  );
  checks.push(
    'historical PNG opens exact persisted original and returns to reading position',
  );
  await page.locator('.tool-summary').last().click();
  await page.locator('.tool-head').last().click();
  await page
    .getByRole('button', { name: 'copy tool output', exact: true })
    .last()
    .click();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(copied, log);
  checks.push('all 600 original historical output lines copied exactly');
  const finalTasks = await service('tasks', 'list');
  assert.equal(
    finalTasks.filter(
      (task) => taskIds.includes(task.spec.id) && task.state === 'running',
    ).length,
    8,
  );
  report.actualTaskRecords = finalTasks.filter((task) =>
    taskIds.includes(task.spec.id),
  );
  await page.screenshot({ path: join(output, 'native-performance.png') });
  for (const [metric, budget] of Object.entries({
    inputKeystroke: 100,
    inputPaste: 100,
    click: 100,
    eventToFrame: 200,
    sessionSwitch: 300,
    fileSwitch: 300,
    save: 500,
  })) {
    assert.ok(samples[metric].length >= 20, `${metric} insufficient samples`);
    report.metrics[metric] = {
      n: samples[metric].length,
      p95: p95(samples[metric]),
      budgetMs: budget,
      passed: p95(samples[metric]) <= budget,
    };
  }
  report.measurement =
    'renderer input requires textarea value plus React-derived Send disabled state; 40 actual x/Backspace key presses and 40 whole-input updates alternating empty/600-line input are reported separately; input/click to two animation frames after actual visible state; PTY producer Date.now to accessibility rows plus two animation frames, a paint-opportunity approximation rather than a compositor pixel timestamp';
  report.complete = true;
  report.passed =
    Object.values(report.metrics).every((metric) => metric.passed) &&
    !errors.length &&
    report.initialTranscriptPassed;
} catch (error) {
  report.failure = String(error.stack ?? error);
  try {
    const actual = await state();
    report.actualStateOnFailure = {
      activeSessionId: actual.activeSessionId,
      runtime: actual.runtime,
      sessions: actual.sessions.map((session) => ({
        id: session.id,
        state: session.state,
        projectedMessages: session.messages.length,
        leafId: session.leafId,
      })),
    };
  } catch (diagnosticError) {
    report.stateReadFailure = String(diagnosticError);
  }
  try {
    if (page) await page.screenshot({ path: join(output, 'failure.png') });
  } catch {}
  process.exitCode = 1;
} finally {
  if (page) {
    for (const id of taskIds)
      try {
        await service('tasks', 'cancel', { id });
      } catch {}
    if (terminalId)
      try {
        await service('terminal', 'close', { id: terminalId });
      } catch {}
    try {
      await page.evaluate(() =>
        window.__circleNativePerfObserver?.disconnect(),
      );
    } catch {}
  }
  if (app) {
    if (clipboardBefore !== undefined) {
      await restoreNativeClipboardWithRecovery(app, clipboardBefore, {
        retryPath: join(output, 'retry-clipboard'),
        onFailure: async (error) => {
          report.clipboardRestoreFailure = String(error);
          report.clipboardRecovery = {
            pending: true,
            appKeptAlive: true,
            retryPath: join(output, 'retry-clipboard'),
          };
          report.passed = false;
          process.exitCode = 1;
          await writeFile(
            join(output, 'report.json'),
            JSON.stringify(report, null, 2),
          );
          console.error(
            'Clipboard restoration pending; app and original main-process checkpoint retained. Create retry-clipboard in the attempt directory to retry.',
          );
        },
      });
      if (report.clipboardRecovery)
        report.clipboardRecovery = {
          ...report.clipboardRecovery,
          pending: false,
          appKeptAlive: false,
          restoredAt: new Date().toISOString(),
        };
    }
    await app.close().catch(() => {});
  }
  for (const [metric, budget] of Object.entries({
    inputKeystroke: 100,
    inputPaste: 100,
    click: 100,
    eventToFrame: 200,
    sessionSwitch: 300,
    fileSwitch: 300,
    save: 500,
  })) {
    if (!report.metrics[metric] && samples[metric].length)
      report.metrics[metric] = {
        n: samples[metric].length,
        p95: p95(samples[metric]),
        budgetMs: budget,
        passed: samples[metric].length >= 20 && p95(samples[metric]) <= budget,
        partial: !report.complete,
      };
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        output,
        complete: report.complete,
        passed: report.passed ?? false,
        metrics: report.metrics,
        failure: report.failure,
      },
      null,
      2,
    ),
  );
  if (report.complete && !report.passed) process.exitCode = 1;
}
