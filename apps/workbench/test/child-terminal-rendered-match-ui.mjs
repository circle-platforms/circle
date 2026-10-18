import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createCommandTerminalControllerFixture } from '../../desktop/test/helpers/command-terminal-controller-fixture.ts';
import { assertRenderedTerminalMatch } from '../../desktop/test/helpers/native-terminal-rendered-match.mjs';
const output =
  process.env.CIRCLE_CHILD_ECHO_EVIDENCE ??
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-child-echo-display-')));
await mkdir(output, { recursive: true });
const accessibilityEnabled =
  process.env.CIRCLE_CHILD_ECHO_ACCESSIBILITY !== 'off';
const receipt = { status: 'failed', checks: [], accessibilityEnabled };
const f = await createCommandTerminalControllerFixture({ after() {} });
let server, browser, context, page, timer;
const streams = new Set();
let updateIndex = 0,
  eventIndex = 0,
  sequence = 0;
const pump = () => {
  while (updateIndex < f.updates.length) {
    const value = { ...f.updates[updateIndex++], seq: ++sequence };
    for (const response of streams)
      response.write(
        'data: ' + JSON.stringify({ kind: 'runtime', value }) + '\n\n',
      );
  }
  while (eventIndex < f.events.length) {
    const value = f.events[eventIndex++];
    for (const response of streams)
      response.write(
        'data: ' + JSON.stringify({ kind: 'workspace', value }) + '\n\n',
      );
  }
};
try {
  // Real process line assembly matches the native child fixture, preserving the exact input bytes.
  await writeFile(
    join(f.workspace, 'command-input.cjs'),
    String.raw`const fs=require('node:fs');
fs.appendFileSync('starts','once\n');
fs.writeFileSync('actual-pid',String(process.pid));
if(process.stdin.isTTY)process.stdin.setRawMode(true);
let line='';process.stdin.on('data',bytes=>{fs.appendFileSync('actual-input',bytes);line+=bytes.toString();if(/[\r\n]/.test(line)){process.stdout.write('CHILD_HANDOFF_ECHO:'+line);line='';}});
process.stdin.resume();console.log('CHILD_HANDOFF_READY '+process.pid);setInterval(()=>{},1000);
`,
  );
  const git = (...args) =>
    execFileSync('git', ['-C', f.workspace, ...args], { encoding: 'utf8' });
  git('add', 'command-input.cjs');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Use exact child echo fixture',
  );
  const parent = await f.startParent();
  await f.enqueueChild('wrapped-child-echo');
  const child = await f.startChild();
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    logLevel: 'error',
    plugins: [
      {
        name: 'real-child-echo-controller',
        enforce: 'pre',
        transform(code, id) {
          if (!id.endsWith('/test/command-terminal-handoff-ui.tsx')) return;
          // Only the local test host is changed, never the terminal implementation.
          const marker = 'window.circleDesktop = host;';
          assert(
            code.includes(marker),
            'test bridge instrumentation target exists',
          );
          return code.replace(
            marker,
            `Object.assign(host, {
            nativeAccessibility: async () => ({supported:true, enabled:${accessibilityEnabled}, revision:1}),
            onNativeAccessibility: () => () => {},
          });\n${marker}`,
          );
        },
        configureServer(server) {
          server.middlewares.use('/__command_events', (request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.write(':connected\n\n');
            streams.add(response);
            request.on('close', () => streams.delete(response));
          });
          server.middlewares.use('/__command_state', (_request, response) => {
            pump();
            response.setHeader('Content-Type', 'application/json');
            response.end(
              JSON.stringify({
                seq: ++sequence,
                connected: true,
                snapshot: f.controller.snapshot(),
              }),
            );
          });
          server.middlewares.use(
            '/__command_dispatch',
            async (request, response) => {
              try {
                let body = '';
                for await (const part of request) body += part;
                const reply = await f.controller.dispatch(JSON.parse(body));
                pump();
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify(reply));
              } catch (error) {
                response.end(
                  JSON.stringify({ ok: false, error: String(error) }),
                );
              }
            },
          );
        },
      },
    ],
  });
  await server.listen();
  timer = setInterval(pump, 25);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  await page.goto(
    server.resolvedUrls.local[0] +
      `test/command-terminal-handoff-ui.html?theme=light#/session/${parent.sessionId}`,
  );
  let composer = page.getByRole('textbox', { name: 'message', exact: true });
  await composer.waitFor();
  await composer.fill('PARENT_DRAFT_EXACT 保留');
  const openOriginalChildTerminal = async () => {
    await page
      .getByRole('button', { name: 'activity panel', exact: true })
      .click();
    const agent = f.controller
      .snapshot()
      .agents.find((row) => row.id === child.sessionId);
    assert(agent);
    await page
      .locator('.activity-row')
      .filter({ has: page.locator('strong', { hasText: agent.name }) })
      .click();
    await page
      .getByRole('button', { name: 'close inspector', exact: true })
      .click();
    const record = page.locator('.agent-record');
    await record.waitFor();
    for (const group of await record.locator('.tool-group').all()) {
      const summary = group.locator(':scope > button').first();
      if ((await summary.getAttribute('aria-expanded')) !== 'true')
        await summary.click();
    }
    const card = record
      .locator('.tool-call')
      .filter({ has: page.locator('.tool-head code[title="execute"]') });
    await card.waitFor();
    if (
      (await card.locator('.tool-head').getAttribute('aria-expanded')) !==
      'true'
    )
      await card.locator('.tool-head').click();
    await card
      .getByRole('button', { name: 'open in terminal', exact: true })
      .click();
    const resolved = await f.service('terminal', 'resolveCommand', {
      sourceSessionId: child.sessionId,
      toolCallId: f.toolCallId,
    });
    assert.equal(resolved.available, true);
    const target = resolved.target;
    const panel = page.locator('.native-terminal:visible');
    const surface = panel.locator(`#terminal-${target.terminal.id}:visible`);
    await surface.waitFor();
    return { resolved, target, panel, surface };
  };
  const { target, panel, surface } = await openOriginalChildTerminal();
  // The drawer can fit more columns than the old fixed echo contained. Build
  // the exact input from the actual UI -> PTY resize receipt, not a particular
  // panel width or a wall-clock delay. The same bytes must survive journal replay.
  let fitEvent;
  await f.until(() => {
    fitEvent = f.events.findLast(
      (event) =>
        event.service === 'terminal' &&
        event.resourceId === target.terminal.id &&
        event.data.kind === 'resized' &&
        Number.isSafeInteger(event.data.snapshot?.cols) &&
        event.data.snapshot.cols > 0,
    );
    return !!fitEvent;
  }, 'the displayed xterm fits its real PTY before constructing wrapped input');
  const fittedCols = fitEvent.data.snapshot.cols;
  const input = `NATIVE_CHILD_HANDOFF_INPUT_${'WRAP_'.repeat(Math.ceil((fittedCols * 2) / 5))}\r`;
  await surface.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(input.slice(0, -1));
  await page.keyboard.press('Enter');
  await f.until(
    async () => (await f.read(child.workspace, f.files.input)) === input,
    'exact keyboard bytes reach actual child process',
  );
  const expected = 'CHILD_HANDOFF_ECHO:' + input.trimEnd();
  if (accessibilityEnabled) {
    await f.until(
      async () => (await surface.innerText()).includes('CHILD_HANDOFF_ECHO:'),
      'real xterm accessibility output is rendered',
    );
  } else {
    await f.until(
      async () =>
        (await surface.locator('.xterm-accessibility-tree').count()) === 0,
      'native accessibility auto-disabled removes the hidden text tree',
    );
  }
  const originalText = await surface.innerText();
  const listing = await f.service('terminal', 'command', {
    target,
    action: 'list',
  });
  receipt.wrapFixture = {
    constructedFromResize: { sequence: fitEvent.seq, cols: fittedCols },
    fittedCols: listing.value[0].cols,
    expectedCharacters: expected.length,
    inputCharacters: input.length - 1,
    viewport: await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    })),
    terminalBounds: await surface.boundingBox(),
  };
  assert(
    listing.value[0].cols < expected.length,
    'fixture actually soft-wraps the complete echo',
  );
  // Whole-surface text can contain an asynchronous accessibility live announcement.
  // Record it; the real displayed rows and original xterm selection are the stable oracle.
  const physicalRows = async (surface) => {
    let rows = [];
    if (accessibilityEnabled) {
      await f.until(async () => {
        rows = await surface
          .locator('.xterm-accessibility-tree > div')
          .allTextContents();
        return rows.join('\n').includes('CHILD_HANDOFF_ECHO:');
      }, 'physical accessibility rows contain the parsed echo');
      assert.equal(
        rows.join('\n').includes(expected),
        false,
        'the actual physical xterm rows soft-wrap the exact echo',
      );
    } else {
      assert.equal(
        await surface.locator('.xterm-accessibility-tree').count(),
        0,
      );
    }
    return rows;
  };
  const rendered = await assertRenderedTerminalMatch({
    panel,
    surface,
    text: expected,
    until: f.until,
  });
  assert(
    rendered.selectionRectangles.filter(
      (rect) => rect.width > 0 && rect.height > 0,
    ).length >= 2,
    'exact xterm match spans real displayed physical rows',
  );
  const livePhysicalRows = await physicalRows(surface);
  assert.equal(await f.read(parent.workspace, f.files.input), '');
  assert.equal(await f.read(child.workspace, f.files.starts), 'once\n');
  assert.equal(listing.value[0].managedCommand.commandPid, child.pid);
  await page.screenshot({ path: join(output, 'wrapped-child-echo.png') });
  Object.assign(receipt, {
    status: 'running',
    parentSessionId: parent.sessionId,
    childSessionId: child.sessionId,
    target,
    pid: child.pid,
    cols: listing.value[0].cols,
    originalText,
    livePhysicalRows,
    rendered,
    inputBytes: await f.read(child.workspace, f.files.input),
  });
  receipt.checks.push(
    'real delegated child original PID and exact keyboard bytes',
    'physical xterm rows soft-wrap the exact echo; whole-DOM live announcements are recorded',
    'missing output does not select',
    accessibilityEnabled
      ? 'native accessibility on: actual physical rows contain a wrapped echo'
      : 'native accessibility auto-off: real match does not rely on hidden DOM text',
    'real xterm exact rendered match spans the soft-wrapped rows',
    'parent input unchanged and child process starts once',
  );
  // Destroy and recreate the actual controller before mounting a fresh renderer document.
  // The restored view can only read the durable journal, never a still-live xterm instance.
  await page.close();
  await f.restart();
  page = await context.newPage();
  composer = page.getByRole('textbox', { name: 'message', exact: true });
  const requestsAfterClose = f.model.requests.length;
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await page.goto(
    server.resolvedUrls.local[0] +
      `test/command-terminal-handoff-ui.html?theme=light#/session/${parent.sessionId}`,
  );
  const main = page
    .locator('.agent-record:visible')
    .getByRole('button', { name: 'main', exact: true });
  if (await main.isVisible()) await main.click();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), 'PARENT_DRAFT_EXACT 保留');
  const restored = await openOriginalChildTerminal();
  assert.deepEqual(restored.target, target);
  assert.deepEqual(restored.resolved.capabilities, {
    read: true,
    input: false,
    stop: false,
    addToDraft: false,
  });
  if (accessibilityEnabled) {
    await f.until(
      async () =>
        (await restored.surface.innerText()).includes('CHILD_HANDOFF_ECHO:'),
      'actual durable journal output reaches the fresh xterm',
    );
  }
  const restoredDomText = await restored.surface.innerText();

  const restoredMatch = await assertRenderedTerminalMatch({
    panel: restored.panel,
    surface: restored.surface,
    text: expected,
    until: f.until,
  });
  assert(
    restoredMatch.selectionRectangles.filter(
      (rect) => rect.width > 0 && rect.height > 0,
    ).length >= 2,
  );
  const restoredPhysicalRows = await physicalRows(restored.surface);
  for (const name of ['stop terminal', 'restart terminal'])
    assert.equal(
      await restored.panel
        .getByRole('button', { name, exact: true })
        .isEnabled(),
      false,
    );
  const rejected = await f.serviceReply('terminal', 'command', {
    target,
    action: 'write',
    params: { data: 'MUST_NOT_RUN' },
  });
  assert.equal(rejected.ok, false);
  assert.equal(await f.read(child.workspace, f.files.input), input);
  assert.equal(await f.read(child.workspace, f.files.starts), 'once\n');
  assert.equal(Number(await f.read(child.workspace, f.files.pid)), child.pid);
  assert.equal(f.model.requests.length, requestsAfterClose);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await page.screenshot({
    path: join(output, 'wrapped-child-after-controller-restart.png'),
  });
  receipt.afterControllerRestart = {
    sameTarget: true,
    readonly: true,
    noNewProcess: true,
    noModelReplay: true,
    restoredDomText,
    restoredPhysicalRows,
    match: restoredMatch,
  };
  receipt.checks.push(
    'fresh controller and renderer restore the actual journal output',
    'archived target stays readonly and original input/start count/PID/model count remain unchanged',
  );
  receipt.status = 'passed';
  console.log(JSON.stringify(receipt));
} catch (error) {
  receipt.status = 'failed';
  receipt.error = String(error);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
  if (timer) clearInterval(timer);
  await page?.close();
  await browser?.close();
  for (const stream of streams) stream.end();
  await server?.close();
  await f.cleanup();
}
