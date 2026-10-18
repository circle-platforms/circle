/** Headless full-App regression over HTTP/SSE, real controller/tasks/PTY. Not Electron performance. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { RuntimeController } from '../../desktop/src/runtime-controller.ts';
import { RuntimeFixtureModel } from '../../desktop/src/runtime-fixture.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { performanceMessages } from '../../desktop/test/helpers/native-performance-fixture.mjs';
import {
  captureNativeTranscriptAnchor,
  armNativeFeedback,
} from '../../desktop/test/helpers/native-performance-observation.mjs';
import { journeyNodeCommand } from '../../desktop/test/helpers/native-journey-platform.mjs';
const temp = await mkdtemp(join(tmpdir(), 'circle-reading-live-pressure-'));
const workspace = join(temp, 'workspace'),
  data = join(temp, 'data'),
  home = join(data, 'runtime-home');
await mkdir(workspace);
await mkdir(home, { recursive: true });
const output =
  process.env.CIRCLE_READING_PRESSURE_EVIDENCE ??
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  join(temp, 'evidence');
await mkdir(output, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', workspace, ...args]);
await writeFile(join(workspace, 'README.md'), '# PERF_README\n');
await writeFile(join(workspace, 'SECOND.md'), '# PERF_SECOND\n');
await writeFile(
  join(workspace, 'pty.cjs'),
  "setInterval(()=>console.log('READING_PTY '+Date.now()),50);\n",
);
git('init', '-q');
git('add', 'README.md', 'SECOND.md', 'pty.cjs');
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'Create fixture',
);
const settings = trustFolder(defaultSettings(), workspace);
settings.workspace_folder = workspace;
saveSettings(settings, home);
const store = new CheckpointStore(home);
store.create(workspace, 'fixture', 'performance alternate', 'perf-alternate');
store.append('perf-alternate', [
  { id: randomUUID(), role: 'assistant', content: 'PERF_ALTERNATE_READY' },
]);
store.create(workspace, 'fixture', 'performance history', 'perf-history');
const png = (
  await readFile(
    new URL(
      '../../desktop/test/fixtures/performance-original.png',
      import.meta.url,
    ),
  )
).toString('base64');
store.append(
  'perf-history',
  performanceMessages({ png, log: 'actual historical tool output' }),
);
store.close();
await writeFile(
  join(home, 'desktop-session.json'),
  JSON.stringify({ workspace, sessionId: 'perf-history' }),
);
const clients = new Set();
let update;
const transport = {};
const emit = (type, value) => {
  if (type === 'update') update = value;
  for (const client of clients) {
    const start = performance.now();
    const wire = JSON.stringify({ type, value });
    const metric = (transport[type] ??= {
      count: 0,
      bytes: 0,
      serializationMs: 0,
      maxBytes: 0,
    });
    metric.count++;
    const bytes = Buffer.byteLength(wire);
    metric.bytes += bytes;
    metric.maxBytes = Math.max(metric.maxBytes, bytes);
    metric.serializationMs += performance.now() - start;
    client.write('data: ' + wire + '\n\n');
  }
};
const model = new RuntimeFixtureModel({
  replies: Array.from({ length: 8 }, () => ({
    chunks: Array.from({ length: 24000 }, (_, i) => `actual stream ${i} `),
    delayMs: 40,
    message: { id: randomUUID(), role: 'assistant', content: 'stream done' },
  })),
});
const controller = new RuntimeController({
  home,
  userHome: home,
  workspace,
  dataFolder: data,
  model,
  workspaceTools: {
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
  },
  emit: (value) => emit('update', value),
  emitTokenDelta: (value) => emit('delta', value),
  emitWorkspaceEvent: (value) => emit('workspace', value),
});
const call = async (name, payload = {}, sessionId = 'perf-history') => {
  const reply = await controller.dispatch({
    id: randomUUID(),
    name,
    payload,
    sessionId,
  });
  if (!reply.ok) throw Error(reply.error);
  return reply.data;
};
await call('state');
if (!update) controller.publish();
const service = (name, method, params = {}) =>
  call('workspace-service', { service: name, method, params });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
  plugins: [
    {
      name: 'actual-reading-controller',
      configureServer(server) {
        server.middlewares.use(
          '/reading-pressure-events',
          (request, response) => {
            response.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
            });
            response.write(': ready\n\n');
            clients.add(response);
            request.on('close', () => clients.delete(response));
          },
        );
        server.middlewares.use(
          '/reading-pressure-state',
          (_request, response) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(update));
          },
        );
        server.middlewares.use(
          '/reading-pressure-command',
          async (request, response) => {
            try {
              let raw = '';
              for await (const chunk of request) raw += chunk;
              response.setHeader('Content-Type', 'application/json');
              response.end(
                JSON.stringify(await controller.dispatch(JSON.parse(raw))),
              );
            } catch (error) {
              response.statusCode = 500;
              response.end(String(error));
            }
          },
        );
      },
    },
  ],
});
let browser, page, terminal;
const receipt = {
  kind: 'headless-live-runtime-regression-not-native-performance',
  temp,
  checks: [],
  transport,
};
const phase = (name) => {
  const value = { name, at: new Date().toISOString() };
  (receipt.phases ??= []).push(value);
  console.log(JSON.stringify({ phase: value }));
  // Keep the last completed oracle and actual transport volume even if the
  // unchanged suite watchdog terminates this process before finally runs.
  writeFileSync(
    join(output, 'receipt.partial.json'),
    JSON.stringify(receipt, null, 2),
  );
};
try {
  phase('setup');
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  await page.goto(
    server.resolvedUrls.local[0] + 'test/reading-live-pressure-ui.html',
  );
  await page.locator('[data-windowed-count="10000"]').waitFor();
  await service('tasks', 'enqueue', {
    operationId: randomUUID(),
    tasks: Array.from({ length: 8 }, (_, i) => ({
      id: 'pressure-' + i,
      prompt: 'stream without file writes',
      access: 'readonly',
      acceptanceCriteria: ['read only'],
    })),
  });
  await service('tasks', 'start');
  const startupDeadline = Date.now() + 30000;
  while (
    (await service('tasks', 'list')).filter((task) => task.state === 'running')
      .length !== 8
  ) {
    if (Date.now() > startupDeadline)
      throw Error('eight real task attempts did not start');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  phase('eight-real-runtimes-running');
  await page
    .getByRole('button', { name: 'terminal panel', exact: true })
    .click();
  await page
    .locator('#inspector-terminal-terminal button[aria-label="new terminal"]')
    .click();
  await page.locator('#inspector-terminal-terminal .xterm').first().waitFor();
  terminal = (await service('terminal', 'list'))[0];
  assert.ok(terminal, 'the actual UI-created PTY is present in the ledger');
  receipt.ownedTerminal = terminal;
  await service('terminal', 'write', {
    id: terminal.id,
    data: journeyNodeCommand(process.execPath, join(workspace, 'pty.cjs')),
  });
  await page.waitForTimeout(500);
  phase('pty-started');
  const input = page.getByRole('textbox', { name: 'message', exact: true });
  const inputFeedback = async (value, apply) => {
    await page.evaluate(armNativeFeedback, {
      kind: 'input',
      selector: 'textarea[aria-label="message"]',
      condition: {
        selector: 'textarea[aria-label="message"]',
        value,
        feedback: {
          selector: 'button[aria-label="send message"]',
          disabled: !value,
        },
      },
    });
    await apply();
    await page.evaluate(() => window.__circleNativePerfPending);
  };
  await input.fill('');
  for (let i = 0; i < 40; i++)
    await inputFeedback(i % 2 ? '' : 'x', () =>
      input.press(i % 2 ? 'Backspace' : 'x'),
    );
  phase('forty-keys-complete');
  const longPaste = Array.from(
    { length: 600 },
    (_, line) => `full pasted line ${line} ${'developer input '.repeat(4)}`,
  ).join('\n');
  for (let i = 0; i < 40; i++) {
    const value = i % 2 ? '' : longPaste;
    await inputFeedback(value, () => input.fill(value));
  }
  phase('forty-long-pastes-complete');
  await input.fill('retained developer draft');
  await input.evaluate((node) => {
    node.focus();
    node.setSelectionRange(3, 10);
  });
  for (let i = 0; i < 40; i++) {
    const open = i % 2 === 1;
    await page.evaluate(armNativeFeedback, {
      kind: 'click',
      selector: 'button[aria-label="terminal panel"]',
      condition: {
        selector: 'button[aria-label="terminal panel"]',
        attribute: 'aria-pressed',
        equals: String(open),
        panel: { selector: '#inspector-terminal-terminal', visible: open },
      },
    });
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    await page.evaluate(() => window.__circleNativePerfPending);
  }
  phase('forty-panel-toggles-complete');
  const anchor = await page.evaluate(captureNativeTranscriptAnchor);
  receipt.beforeAnchor = anchor;
  receipt.before = await page.evaluate(() =>
    window.readingPressure.frames.at(-1),
  );
  receipt.returns = [];
  for (let round = 0; round < 4; round++) {
    for (const title of ['performance alternate', 'performance history']) {
      // The fixture's desktop says darwin (reading-live-pressure-ui.tsx), so search is
      // ⌘K on every runner; ControlOrMeta would press Ctrl on Linux.
      await page.keyboard.press('Meta+k');
      await page
        .getByRole('textbox', { name: 'global search', exact: true })
        .fill(title);
      const link = page
        .locator('.search-results button')
        .filter({ hasText: title });
      await link.evaluate((n) => (n.dataset.pressureSwitch = 'true'));
      await page.evaluate(armNativeFeedback, {
        kind: 'click',
        selector: '[data-pressure-switch="true"]',
        condition: {
          session: {
            id: title.endsWith('alternate') ? 'perf-alternate' : 'perf-history',
            title,
            content: title.endsWith('alternate')
              ? 'PERF_ALTERNATE_READY'
              : 'persisted history',
          },
        },
      });
      await link.click();
      await page.evaluate(() => window.__circleNativePerfPending);
    }
    phase(`return-${round}-feedback-complete`);
    const after = await page.evaluate(captureNativeTranscriptAnchor);
    receipt.afterAnchor = after;
    receipt.returns.push(after);
    assert.equal(
      after.id,
      anchor.id,
      'same stable reading message under pressure',
    );
    assert.ok(
      Math.abs(after.offset - anchor.offset) <= 2,
      'same reading offset within 2px under pressure',
    );
    receipt.checks.push(
      `return-${round}: stable message and offset within 2px`,
    );
  }
  assert.equal(await input.inputValue(), 'retained developer draft');
  receipt.checks.push('exact draft retained across four pressured returns');
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : String(error);
  if (page)
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) {
    receipt.frames = await page
      .evaluate(() => {
        window.readingPressure.stop = true;
        return window.readingPressure.frames;
      })
      .catch(() => []);
  }
  receipt.actualModelRequests = model.requests.length;
  receipt.taskStates = await service('tasks', 'list').catch(() => []);
  // Keep a failure receipt even if resource cleanup itself exposes a defect.
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
  await browser?.close();
  for (const client of clients) client.end();
  await controller.close();
  await server.close();
  if (terminal?.pid) {
    let alive = true;
    try {
      process.kill(terminal.pid, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      alive = false;
    }
    receipt.ownedPtyExited = !alive;
    assert.equal(alive, false, 'controller close stops its actual PTY');
  }
  receipt.cleanupCompleted = true;
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
  console.log(
    JSON.stringify({
      output,
      passed: receipt.passed,
      error: receipt.error,
      modelRequests: receipt.actualModelRequests,
    }),
  );
}
