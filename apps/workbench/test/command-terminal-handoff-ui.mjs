import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createCommandTerminalControllerFixture } from '../../desktop/test/helpers/command-terminal-controller-fixture.ts';
const output =
  process.env.CIRCLE_COMMAND_HANDOFF_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'command-handoff-ui-')));
await mkdir(output, { recursive: true });
let browser;
const receipt = { cases: [] };
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const label of ['native', 'legacy', 'human']) {
    const native = label !== 'legacy';
    const f = await createCommandTerminalControllerFixture(
      { after() {} },
      {
        native,
        childAssistantContent: Array.from(
          { length: 70 },
          (_, index) =>
            `Child evidence ${index}: original process and source ownership remain tied to this task.`,
        ).join('\n\n'),
      },
    );
    const streams = new Set(),
      calls = [];
    let updateIndex = 0,
      eventIndex = 0,
      sequence = 0;
    let deferResolve = false,
      releaseResolve;
    const pump = () => {
      while (updateIndex < f.updates.length) {
        const update = { ...f.updates[updateIndex++], seq: ++sequence };
        for (const response of streams)
          response.write(
            'data: ' +
              JSON.stringify({ kind: 'runtime', value: update }) +
              '\n\n',
          );
      }
      while (eventIndex < f.events.length) {
        const event = f.events[eventIndex++];
        for (const response of streams)
          response.write(
            'data: ' +
              JSON.stringify({ kind: 'workspace', value: event }) +
              '\n\n',
          );
      }
    };
    let server, page, timer;
    const checks = [];
    try {
      let humanRun;
      if (label === 'human') {
        await writeFile(
          join(f.workspace, 'human-ui-input.cjs'),
          `const fs = require('node:fs');
fs.appendFileSync('human-starts', 'once\\n');
process.stdin.setRawMode(true);
let received = Buffer.alloc(0);
process.stdin.on('data', bytes => {
  fs.appendFileSync('human-input', bytes);
  received = Buffer.concat([received, bytes]);
  if (received.includes(13)) process.stdout.write('HUMAN-ECHO:' + received.toString('utf8'), () => process.exit(7));
});
process.stdin.resume();
console.log('HUMAN-READY');
fs.writeFileSync('human-pid', String(process.pid));
`,
        );
        const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
        humanRun = f.call('shell', {
          command: `exec ${quote(process.execPath)} human-ui-input.cjs`,
        });
        await f.until(
          async () => Number(await f.read(f.workspace, 'human-pid')) > 0,
          'actual human command starts before its original card opens',
        );
      }
      const parent =
        label === 'human'
          ? {
              sessionId: f.parentId,
              workspace: f.workspace,
              pid: Number(await f.read(f.workspace, 'human-pid')),
            }
          : await f.startParent();
      let child;
      if (native && label !== 'human') {
        await f.enqueueChild('ui-command-child');
        child = await f.startChild();
      }
      const childStarts = child
        ? await f.read(child.workspace, f.files.starts)
        : undefined;
      server = await createServer({
        root: fileURLToPath(new URL('..', import.meta.url)),
        server: { host: '127.0.0.1', port: 0 },
        logLevel: 'error',
        plugins: [
          {
            name: 'actual-command-controller',
            configureServer(server) {
              server.middlewares.use(
                '/__command_events',
                (request, response) => {
                  response.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                  });
                  response.write(':connected\n\n');
                  streams.add(response);
                  request.on('close', () => streams.delete(response));
                },
              );
              server.middlewares.use(
                '/__command_state',
                (_request, response) => {
                  pump();
                  response.setHeader('Content-Type', 'application/json');
                  response.end(
                    JSON.stringify({
                      seq: ++sequence,
                      connected: true,
                      snapshot: f.controller.snapshot(),
                    }),
                  );
                },
              );
              server.middlewares.use(
                '/__command_dispatch',
                async (request, response) => {
                  try {
                    let body = '';
                    for await (const chunk of request) body += chunk;
                    const command = JSON.parse(body);
                    calls.push(command);
                    const reply = await f.controller.dispatch(command);
                    if (
                      deferResolve &&
                      command.payload?.method === 'resolveCommand'
                    ) {
                      deferResolve = false;
                      await new Promise((resolve) => {
                        releaseResolve = resolve;
                      });
                    }
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
      page = await browser.newPage({
        viewport: { width: native ? 1280 : 375, height: 900 },
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(
        server.resolvedUrls.local[0] +
          `test/command-terminal-handoff-ui.html?theme=${native ? 'light' : 'dark'}#/session/${parent.sessionId}`,
      );
      const composer = page.getByRole('textbox', {
        name: 'message',
        exact: true,
      });
      await composer.waitFor();
      await composer.fill('PARENT_DRAFT_EXACT 保留');
      const parentCard = page.locator('.conversation .tool-call').filter({
        hasText: label === 'human' ? 'human-ui-input.cjs' : 'command-input.cjs',
      });
      const parentGroup = page
        .locator('.conversation .tool-group > button')
        .first();
      if (!(await parentCard.isVisible())) await parentGroup.click();
      await parentCard.waitFor();
      if (!(await parentCard.locator('.tool-content').isVisible()))
        await parentCard.locator('.tool-head').click();
      const parentOpen = parentCard.getByRole('button', {
        name: 'open in terminal',
        exact: true,
      });
      const parentStarts = await f.read(
        parent.workspace,
        label === 'human' ? 'human-starts' : f.files.starts,
      );
      assert.equal(parentStarts.match(/once/g)?.length, 1);
      if (label === 'human') {
        const card = f.controller
          .snapshot()
          .sessions.find((session) => session.id === parent.sessionId)
          .messages.find((message) => message.shell?.interactive);
        assert(card?.shell?.id);
        const userShellId = card.shell.id;
        const resolution = await f.service('terminal', 'resolveCommand', {
          sourceSessionId: parent.sessionId,
          userShellId,
        });
        assert.equal(resolution.available, true);
        assert.equal(resolution.target.origin, 'user-shell');
        assert.equal(resolution.target.userShellId, userShellId);
        assert.equal(resolution.target.toolCallId, undefined);
        assert.equal(f.model.requests.length, 0);
        await parentOpen.click();
        const terminal = page.getByRole('region', {
          name: 'interactive terminal',
          exact: true,
        });
        const input = terminal.locator(
          `#terminal-${resolution.target.terminal.id} .xterm-helper-textarea`,
        );
        await input.waitFor();
        const originalSurface = await terminal
          .locator(`#terminal-${resolution.target.terminal.id}`)
          .elementHandle();
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .click();
        assert.equal(await composer.inputValue(), 'PARENT_DRAFT_EXACT 保留');
        await parentOpen.click();
        await input.waitFor();
        assert.equal(
          await terminal
            .locator(`#terminal-${resolution.target.terminal.id}`)
            .evaluate((node, original) => node === original, originalSurface),
          true,
        );
        const listing = await f.service('terminal', 'command', {
          target: resolution.target,
          action: 'list',
        });
        assert.equal(listing.available, true);
        assert.equal(listing.value[0].managedCommand.commandPid, parent.pid);
        assert.equal(listing.value[0].managedCommand.userShellId, userShellId);
        assert.equal(
          await terminal
            .getByRole('button', { name: 'restart terminal', exact: true })
            .isDisabled(),
          true,
        );
        await input.focus();
        await page.keyboard.type('human-exact-input');
        await page.keyboard.press('Enter');
        const ended = await humanRun;
        assert.equal(ended.ok, true, ended.error);
        assert.equal(ended.data.exit_code, 7);
        assert.equal(
          await f.read(parent.workspace, 'human-input'),
          'human-exact-input\r',
        );
        assert.equal(await f.read(parent.workspace, 'human-starts'), 'once\n');
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .click();
        await parentCard.waitFor();
        await page
          .locator('.conversation article.message.user')
          .filter({ hasText: 'human-ui-input.cjs' })
          .getByText('exit 7', { exact: true })
          .waitFor();
        await parentCard
          .locator('pre')
          .filter({ hasText: 'HUMAN-ECHO:human-exact-input' })
          .first()
          .waitFor();
        await parentOpen.click();
        await input.waitFor();
        assert.equal(await composer.inputValue(), 'PARENT_DRAFT_EXACT 保留');
        await f.restart();
        await page.reload();
        await composer.waitFor();
        await parentCard.waitFor();
        if (!(await parentCard.locator('.tool-content').isVisible()))
          await parentCard.locator('.tool-head').click();
        await parentOpen.click();
        await input.waitFor();
        const restored = await f.service('terminal', 'resolveCommand', {
          sourceSessionId: parent.sessionId,
          userShellId,
        });
        assert.equal(restored.available, true);
        assert.deepEqual(restored.target, resolution.target);
        assert.equal(restored.capabilities.input, false);
        assert.equal(restored.capabilities.stop, false);
        const replay = await f.service('terminal', 'command', {
          target: restored.target,
          action: 'replay',
          params: { limit: 2000 },
        });
        assert.equal(replay.available, true);
        assert(
          replay.value.events
            .filter((event) => event.kind === 'data')
            .map((event) => event.data)
            .join('')
            .includes('HUMAN-ECHO:human-exact-input'),
        );
        assert.equal(
          await terminal
            .getByRole('button', { name: 'stop terminal', exact: true })
            .isDisabled(),
          true,
        );
        assert.equal(
          await terminal
            .getByRole('button', { name: 'restart terminal', exact: true })
            .isDisabled(),
          true,
        );
        assert.equal(await composer.inputValue(), 'PARENT_DRAFT_EXACT 保留');
        assert.equal(f.controller.snapshot().activeSessionId, parent.sessionId);
        assert.equal(await f.read(parent.workspace, 'human-starts'), 'once\n');
        assert.equal(f.model.requests.length, 0);
        const humanResolves = calls.filter(
          (call) => call.payload?.method === 'resolveCommand',
        );
        assert(humanResolves.length >= 4);
        assert(
          humanResolves.every(
            (call) =>
              call.payload.params.userShellId === userShellId &&
              call.payload.params.toolCallId === undefined,
          ),
        );
        assert(
          !calls.some(
            (call) =>
              call.payload?.service === 'terminal' &&
              ['create', 'restart'].includes(call.payload?.method),
          ),
        );
        checks.push(
          'human ! original card opens same PTY without a fake provider call or model request',
          'hide/reopen preserves original surface, actual PID and unsent draft',
          'UI exact stdin reaches original process once and its real exit7 remains visible',
          'restart restores the shared original card and same double-epoch terminal readonly without rerunning',
        );
      } else if (!native) {
        for (let attempt = 0; attempt < 2; attempt++) {
          await parentOpen.click();
          await parentCard
            .getByRole('alert')
            .getByText('this command has no interactive terminal', {
              exact: true,
            })
            .waitFor();
          assert.equal(await parentOpen.isEnabled(), true);
        }
        assert.equal(
          await page.locator('.native-terminal').count(),
          0,
          'unsupported command never opens a replacement PTY',
        );
        assert.equal(
          await f.read(parent.workspace, f.files.starts),
          parentStarts,
        );
        assert.equal(
          await f.read(parent.workspace, f.files.pid),
          String(parent.pid),
        );
        assert.equal(await composer.inputValue(), 'PARENT_DRAFT_EXACT 保留');
        checks.push(
          'real legacy pipe unavailable stays on original card and retries without spawning',
        );
      } else {
        const parentResolution = await f.service('terminal', 'resolveCommand', {
          sourceSessionId: parent.sessionId,
          toolCallId: f.toolCallId,
        });
        assert.equal(parentResolution.available, true);
        const target = parentResolution.target;
        await parentOpen.click();
        const terminal = page.getByRole('region', {
          name: 'interactive terminal',
          exact: true,
        });
        await terminal
          .locator(`#terminal-${target.terminal.id} .xterm-helper-textarea`)
          .waitFor();
        await terminal
          .locator(`#terminal-${target.terminal.id} .xterm-helper-textarea`)
          .focus();
        await page.keyboard.type('parent-exact-input');
        await f.until(
          async () =>
            (await f.read(parent.workspace, f.files.input)) ===
            'parent-exact-input',
          'parent UI typed exact bytes reach original process',
        );
        assert.equal(await f.read(child.workspace, f.files.input), '');
        assert.equal(
          await terminal
            .getByRole('button', { name: 'restart terminal', exact: true })
            .isDisabled(),
          true,
        );
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .click();
        assert.equal(
          await parentOpen.evaluate((node) => document.activeElement === node),
          true,
          'close returns focus without scrolling the command card',
        );
        assert.equal(await composer.inputValue(), 'PARENT_DRAFT_EXACT 保留');
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
        await record
          .locator('header strong')
          .getByText(agent.name, { exact: true })
          .waitFor();
        const childCard = record
          .locator('.tool-call')
          .filter({ hasText: 'command-input.cjs' });
        const childOpen = childCard.getByRole('button', {
          name: 'open in terminal',
          exact: true,
        });
        await childOpen.evaluate((node) =>
          node.scrollIntoView({ block: 'center', behavior: 'instant' }),
        );
        const recordBody = record.locator('.agent-record-body');
        const beforeScroll = await recordBody.evaluate(
          (node) => node.scrollTop,
        );
        assert(
          beforeScroll > 0,
          'actual scripted child evidence produces a nonzero reading position',
        );
        const beforeGeometry = await recordBody.evaluate((n) => ({
          top: n.scrollTop,
          height: n.scrollHeight,
          client: n.clientHeight,
          rect: n.getBoundingClientRect().toJSON(),
          html: n.innerHTML,
        }));
        const recordNode = await recordBody.elementHandle();
        await childOpen.click();
        const childResolution = await f.service('terminal', 'resolveCommand', {
          sourceSessionId: child.sessionId,
          toolCallId: f.toolCallId,
        });
        assert.equal(childResolution.available, true);
        const childTarget = childResolution.target;
        assert.notEqual(childTarget.terminal.id, target.terminal.id);
        const childInput = terminal.locator(
          `#terminal-${childTarget.terminal.id} .xterm-helper-textarea`,
        );
        await childInput.waitFor();
        await childInput.focus();
        await page.keyboard.type('child-exact-input');
        await f.until(
          async () =>
            (await f.read(child.workspace, f.files.input)) ===
            'child-exact-input',
          'child UI typed exact bytes reach actual child process',
        );
        assert.equal(
          await f.read(parent.workspace, f.files.input),
          'parent-exact-input',
        );
        assert.equal(f.controller.snapshot().activeSessionId, parent.sessionId);
        const surface = await terminal
          .locator(`#terminal-${childTarget.terminal.id}`)
          .elementHandle();
        await childOpen.click();
        await f.until(
          () =>
            calls.filter(
              (call) =>
                call.payload?.method === 'resolveCommand' &&
                call.payload.params?.sourceSessionId === child.sessionId,
            ).length >= 2,
          'same child command reopened',
        );
        await childOpen.waitFor({ state: 'visible' });
        assert.equal(
          await terminal
            .locator(`#terminal-${childTarget.terminal.id}`)
            .evaluate((node, previous) => node === previous, surface),
          true,
        );
        await terminal
          .getByRole('button', { name: 'find in terminal', exact: true })
          .click();
        await terminal
          .getByRole('textbox', { name: 'find in terminal', exact: true })
          .fill('READY');
        await terminal
          .getByRole('textbox', { name: 'find in terminal', exact: true })
          .press('Enter');
        await page.waitForTimeout(100);
        assert.equal(
          await terminal
            .getByRole('button', { name: 'add selection to chat', exact: true })
            .isDisabled(),
          true,
          'actual child target never appends to parent draft',
        );
        assert.equal(
          await terminal
            .getByRole('button', { name: 'restart terminal', exact: true })
            .isDisabled(),
          true,
        );
        const rejectedRestart = await f.serviceReply(
          'terminal',
          'restart',
          { id: childTarget.terminal.id },
          child.sessionId,
        );
        assert.equal(
          rejectedRestart.ok,
          false,
          'backend also rejects managed restart',
        );
        assert.equal(
          await f.read(parent.workspace, f.files.starts),
          parentStarts,
        );
        assert.equal(
          (await f.read(child.workspace, f.files.starts)).match(/once/g)
            ?.length,
          1,
        );
        assert.equal(
          await f.read(child.workspace, f.files.pid),
          String(child.pid),
        );
        const stale = await f.service('terminal', 'command', {
          target: { ...childTarget, epoch: 'stale-registry-epoch' },
          action: 'write',
          params: { data: 'MUST_NOT_WRITE' },
        });
        assert.equal(stale.available, false);
        assert.equal(
          await f.read(child.workspace, f.files.input),
          'child-exact-input',
        );
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .click();
        assert.equal(
          await recordBody.evaluate(
            (node, previous) => node === previous,
            recordNode,
          ),
          true,
        );
        const afterScroll = await recordBody.evaluate((node) => node.scrollTop);
        await writeFile(
          join(output, 'child-reading.json'),
          JSON.stringify(
            {
              beforeScroll,
              afterScroll,
              beforeGeometry,
              afterGeometry: await recordBody.evaluate((n) => ({
                top: n.scrollTop,
                height: n.scrollHeight,
                client: n.clientHeight,
                rect: n.getBoundingClientRect().toJSON(),
                html: n.innerHTML,
              })),
            },
            null,
            2,
          ),
        );
        assert.equal(
          (await recordBody.boundingBox()).width,
          beforeGeometry.rect.width,
          'reading oracle uses the same original panel width',
        );
        assert(
          Math.abs(afterScroll - beforeScroll) <= 2,
          `child reading position stays within 2px: ${beforeScroll} -> ${afterScroll}`,
        );
        assert.equal(
          await childOpen.evaluate((node) => document.activeElement === node),
          true,
        );
        await childOpen.click();
        await terminal.waitFor();
        await terminal
          .getByRole('button', { name: 'stop terminal', exact: true })
          .click();
        await f.until(async () => {
          const reply = await f.service('terminal', 'command', {
            target: childTarget,
            action: 'list',
            params: {},
          });
          return (
            reply.available &&
            !['running', 'stopping'].includes(reply.value[0].status)
          );
        }, 'Registry stop closes original managed terminal');
        assert.equal(
          await f.read(child.workspace, f.files.starts),
          childStarts,
        );
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .click();
        deferResolve = true;
        await childOpen.click();
        await f.until(
          () => !!releaseResolve,
          'actual host resolve reply held in transport',
        );
        await record.getByRole('button', { name: 'main', exact: true }).click();
        await composer.waitFor();
        releaseResolve();
        releaseResolve = undefined;
        await page.waitForTimeout(150);
        assert.equal(
          await page
            .getByRole('button', { name: 'terminal panel', exact: true })
            .getAttribute('aria-pressed'),
          'false',
        );
        assert.equal(await composer.inputValue(), 'PARENT_DRAFT_EXACT 保留');
        assert.equal(f.controller.snapshot().activeSessionId, parent.sessionId);
        checks.push(
          'actual parent and task-ledger child same call ID select separate original PTYs',
          'real UI stdin bytes, original PID/start count, repeated open and backend restart denial',
          'Registry stop, stale epoch refusal, exact child DOM/reading offset and parent draft',
          'late actual resolve reply cannot reopen terminal after returning to main',
        );
        const targetCalls = calls.filter(
          (call) =>
            call.payload?.service === 'terminal' &&
            call.payload?.method === 'command',
        );
        assert(targetCalls.length > 0);
        assert(
          targetCalls.every(
            (call) =>
              call.sessionId === parent.sessionId &&
              call.payload.params.target.epoch &&
              call.payload.params.target.terminal.epoch,
          ),
        );
        assert(
          !calls.some(
            (call) =>
              call.payload?.service === 'terminal' &&
              ['create', 'restart'].includes(call.payload?.method),
          ),
          'opening cards never calls a process launch route',
        );
      }
      await page.screenshot({ path: join(output, `${label}.png`) });
      assert.deepEqual(errors, []);
      receipt.cases.push({ native, status: 'passed', checks });
    } catch (error) {
      await writeFile(
        join(output, `${label}-controller-failure.json`),
        JSON.stringify(
          {
            snapshot: f.controller.snapshot(),
            updates: f.updates,
            events: f.events,
          },
          null,
          2,
        ),
      );
      receipt.cases.push({
        native,
        status: 'failed',
        error: String(error),
        checks,
      });
      if (page)
        await writeFile(
          join(output, `${label}-failure.html`),
          await page.content(),
        );
      await page
        ?.screenshot({ path: join(output, `${label}-failure.png`) })
        .catch(() => {});
      throw error;
    } finally {
      releaseResolve?.();
      clearInterval(timer);
      await writeFile(
        join(output, `${label}-requests.json`),
        JSON.stringify(calls, null, 2),
      );
      await page?.close();
      for (const response of streams) response.end();
      await server?.close();
      await f.cleanup();
    }
  }
  console.log(
    'real Controller original-card to original-PTY handoff and legacy unavailable journeys passed',
  );
} finally {
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
  await browser?.close();
}
