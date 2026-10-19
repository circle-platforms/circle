import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalManager } from '../../desktop/src/workspace/terminal.ts';
import { journeyNodeCommand } from '../../desktop/test/helpers/native-journey-platform.mjs';
// The drawer's terminal mode. Its view stays mounted while the drawer is closed.
const terminalMode = '[data-inspector-resource="terminal"]';
/** Open the terminal mode from the top bar, without closing it when it is already open. */
async function openTerminalMode(page) {
  const toggle = page.getByRole('button', {
    name: 'terminal panel',
    exact: true,
  });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true')
    await toggle.click();
  const panel = page.locator(`${terminalMode} .native-terminal:visible`);
  await panel.waitFor();
  return panel;
}
const root = await mkdtemp(join(tmpdir(), 'circle-terminal-fit-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
const fixture = join(workspace, 'actual-viewport.cjs');
await writeFile(
  fixture,
  "console.log('NATIVE_VIEWPORT_'+process.stdout.columns+'x'+process.stdout.rows);\n",
);
const output = process.env.CIRCLE_FULLVIEW_EVIDENCE ?? join(root, 'evidence');
await mkdir(output, { recursive: true });
const events = [],
  clients = new Set();
const manager = new TerminalManager(
  { workspaceRoot: workspace, logRoot: join(root, 'logs') },
  (event) => {
    const sequence = events.length + 1;
    const envelope = {
      workspaceId: 'terminal-fit-workspace',
      sessionId: event.sessionId,
      service: 'terminal',
      resourceId: event.terminalId,
      epoch: 'fixture-journal',
      seq: sequence,
      at: event.at,
      cursor: { offset: sequence, seq: sequence },
      data: { kind: event.kind },
      sourceSeq: event.sequence,
      sourceEpoch: event.epoch,
    };
    events.push(envelope);
    for (const client of clients)
      client.write('data: ' + JSON.stringify(envelope) + '\n\n');
  },
);
const receipts = [];
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
  plugins: [
    {
      name: 'actual-pty-fit-fixture',
      configureServer(server) {
        server.middlewares.use('/terminal-fit-events', (request, response) => {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          response.write(': connected\n\n');
          clients.add(response);
          request.on('close', () => clients.delete(response));
        });
        server.middlewares.use(
          '/terminal-fit-command',
          async (request, response) => {
            try {
              let body = '';
              for await (const chunk of request) body += chunk;
              const command = JSON.parse(body),
                { service, method, params = {} } = command.payload;
              const owner = command.sessionId;
              let data;
              if (service === 'events') {
                const found = events
                  .filter((event) => event.seq > (params.after?.seq ?? 0))
                  .slice(0, params.limit ?? 256);
                data = {
                  events: found,
                  cursor: found.at(-1)?.cursor ??
                    params.after ?? { offset: 0, seq: 0 },
                  hasMore: found.length && found.at(-1).seq < events.length,
                };
              } else if (service !== 'terminal') data = [];
              else if (method === 'list') data = await manager.list(owner);
              else if (method === 'create')
                data = await manager.create({
                  owner,
                  sessionId: owner,
                  cwd: workspace,
                  ...(process.platform === 'win32' ? {} : { shell: '/bin/sh' }),
                });
              else if (method === 'resize')
                data = await manager.resize(
                  owner,
                  params.id,
                  params.cols,
                  params.rows,
                );
              else if (method === 'write')
                data = await manager.write(owner, params.id, params.data);
              else if (method === 'replay')
                data = await manager.replay(
                  owner,
                  params.id,
                  params.afterSequence ?? 0,
                  params.limit ?? 256,
                );
              else if (method === 'close')
                data = await manager.close(owner, params.id);
              else throw Error('unexpected real PTY operation ' + method);
              response.end(JSON.stringify({ ok: true, data }));
            } catch (error) {
              response.end(JSON.stringify({ ok: false, error: String(error) }));
            }
          },
        );
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const width of [1280, 500])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      try {
        await page.goto(
          server.resolvedUrls.local[0] +
            'test/fullview-resource-ui.html?theme=' +
            theme,
        );
        const panel = await openTerminalMode(page);
        // Earlier cases retain read-only terminals; bind the new owned PTY only.
        const prior = new Set(
          (await manager.list('session1')).map((item) => item.id),
        );
        // The + at the end of the tabs makes a shell in the conversation's folder.
        await panel
          .getByRole('button', { name: 'new terminal or device', exact: true })
          .click();
        await page
          .getByRole('menuitem', { name: /^new local terminal/ })
          .click();
        await page.waitForFunction(
          (prior) =>
            [
              ...document.querySelectorAll(
                '[data-inspector-resource="terminal"] .term-tabs [role="tab"][aria-selected="true"]',
              ),
            ].some(
              (tab) =>
                !prior.includes(
                  tab.getAttribute('aria-controls')?.slice('terminal-'.length),
                ),
            ),
          [...prior],
          { timeout: 5000 },
        );
        const created = (await manager.list('session1')).filter(
          (item) => !prior.has(item.id),
        );
        assert.equal(
          created.length,
          1,
          'the terminal mode creates exactly one new owned PTY',
        );
        const id = created[0].id;
        const input = panel.locator(`#terminal-${id} .xterm-helper-textarea`);
        await input.waitFor({ state: 'attached' });
        await panel
          .locator(`#terminal-${id} .xterm-screen`)
          .waitFor({ state: 'visible' });
        const original = await input.elementHandle();
        const samples = [];
        // Observe real rendered frames, rather than fitting a terminal into a fixed-height component fixture.
        for (let frame = 0; frame < 90; frame++) {
          await page.evaluate(() => new Promise(requestAnimationFrame));
          if (frame % 10 === 0) {
            const geometry = await page.evaluate((id) => {
              const selectors = [
                '.inspector-body',
                '[data-inspector-resource="terminal"]',
                '.native-terminal',
                '.native-terminal-screen',
                '.native-terminal-fit',
                '.xterm-screen',
              ];
              const bounds = Object.fromEntries(
                selectors.map((selector) => {
                  const node = [
                      '.native-terminal-screen',
                      '.native-terminal-fit',
                      '.xterm-screen',
                    ].includes(selector)
                      ? document
                          .getElementById('terminal-' + id)
                          .querySelector(selector)
                      : document.querySelector(selector),
                    r = node.getBoundingClientRect();
                  return [
                    selector,
                    {
                      height: r.height,
                      width: r.width,
                      top: r.top,
                      bottom: r.bottom,
                      left: r.left,
                      right: r.right,
                      clientHeight: node.clientHeight,
                      scrollHeight: node.scrollHeight,
                    },
                  ];
                }),
              );
              return { viewport: innerHeight, bounds };
            }, id);
            const terminal = (await manager.list('session1')).find(
              (item) => item.id === id,
            );
            samples.push({
              frame,
              rows: terminal.rows,
              cols: terminal.cols,
              ...geometry,
            });
          }
        }
        const replay = await manager.replay('session1', id, 0, 2000);
        const resizes = replay.events.filter(
          (event) => event.kind === 'resized',
        );
        const record = {
          width,
          theme,
          id,
          samples,
          resizes: resizes.map((event) => ({
            sequence: event.sequence,
            rows: event.snapshot?.rows,
            cols: event.snapshot?.cols,
          })),
          errors,
        };
        receipts.push(record);
        await writeFile(
          join(output, 'receipt.json'),
          JSON.stringify(
            {
              kind: 'complete actual CircleWorkbench original Inspector with a real PTY',
              receipts,
            },
            null,
            2,
          ),
        );
        await page.screenshot({ path: join(output, `${width}-${theme}.png`) });
        const last = samples.at(-1);
        assert.ok(
          last.bounds['.xterm-screen'].height > 0,
          'the selected real terminal must be visible',
        );
        assert.ok(
          last.bounds['.xterm-screen'].bottom <=
            last.bounds['.native-terminal-fit'].bottom + 1 &&
            last.bounds['.xterm-screen'].right <=
              last.bounds['.native-terminal-fit'].right + 1,
          'the complete terminal canvas must fit the unpadded content viewport',
        );
        assert.ok(
          last.bounds['.xterm-screen'].height <=
            last.bounds['.native-terminal-screen'].height + 1,
          'real xterm CSS screen must fit its visible parent',
        );
        assert.ok(
          last.bounds['.native-terminal'].bottom <=
            last.bounds['.inspector-body'].bottom + 1,
          'original Inspector must bound the terminal',
        );
        assert.deepEqual(
          samples.slice(-3).map((sample) => sample.rows),
          Array(3).fill(last.rows),
          'actual PTY rows must settle across rendered frames',
        );
        assert.ok(
          resizes.length <= 8,
          'opening a finite Inspector must not resize its PTY every frame',
        );
        await input.focus();
        await page.keyboard.type(
          journeyNodeCommand(process.execPath, fixture).slice(0, -1),
        );
        await page.keyboard.press('Enter');
        const marker = `NATIVE_VIEWPORT_${last.cols}x${last.rows}`;
        await page.waitForFunction(
          ({ id, marker }) =>
            document
              .getElementById('terminal-' + id)
              .querySelector('.xterm-accessibility-tree')
              ?.textContent.includes(marker),
          { id, marker },
        );
        const actualReplay = await manager.replay('session1', id, 0, 2000);
        const actualOutput = actualReplay.events
          .filter((event) => event.kind === 'data')
          .map((event) => event.data ?? '')
          .join('');
        assert.ok(
          actualOutput.includes(marker),
          'the real child must observe exactly the bounded PTY columns and rows',
        );
        record.actualProgramViewport = marker;
        await writeFile(
          join(output, `${width}-${theme}.events.json`),
          JSON.stringify(actualReplay, null, 2),
        );
        await writeFile(
          join(output, `${width}-${theme}.raw.log`),
          actualOutput,
        );
        const composer = page.getByRole('textbox', {
          name: 'message',
          exact: true,
        });
        await composer.fill('full view preserves this human draft');
        await composer.evaluate((node) => node.setSelectionRange(5, 14));
        const composerIdentity = await composer.elementHandle();
        if (width === 1280) {
          const pid = (await manager.list('session1')).find(
            (t) => t.id === id,
          ).pid;
          assert.ok(pid > 0, 'real PTY exposes its live child PID');
          const fullTransitions = [];
          for (let turn = 0; turn < 3; turn++) {
            await page
              .getByRole('button', { name: 'full view', exact: true })
              .click();
            await page.locator('.inspector-full .inspector').waitFor();
            assert.equal(
              await page.locator('.inspector').count(),
              1,
              'full view does not duplicate Inspector',
            );
            assert.equal(
              await original.evaluate(
                (node, id) =>
                  node.isConnected &&
                  node ===
                    document.querySelector(
                      `#terminal-${id} .xterm-helper-textarea`,
                    ),
                id,
              ),
              true,
              'full view keeps the same xterm input',
            );
            assert.equal(
              await composerIdentity.evaluate((node) => node.isConnected),
              true,
              'original composer stays mounted',
            );
            assert.equal(
              await composer.inputValue(),
              'full view preserves this human draft',
            );
            assert.equal(
              await composer.isVisible(),
              true,
              'upstream full view keeps original composer below panel',
            );
            assert.equal(
              await page
                .locator('.inspector-full')
                .evaluate((node) => node === document.activeElement),
              true,
              'full view receives focus for Escape',
            );
            await page.screenshot({
              path: join(output, `${width}-${theme}-full-${turn}.png`),
            });
            const full = await page.locator('.inspector-full').boundingBox();
            assert.ok(
              full.width > 600 && full.height > 100,
              'original full panel fills available workspace',
            );
            process.kill(pid, 0);
            const current = (await manager.list('session1')).find(
              (t) => t.id === id,
            );
            assert.equal(current.pid, pid);
            assert.equal(current.status, 'running');
            await page.keyboard.press('Escape');
            await page
              .locator('.inspector-full')
              .waitFor({ state: 'detached' });
            assert.equal(
              await original.evaluate((node) => node.isConnected),
              true,
              'Escape does not recreate native terminal',
            );
            assert.equal(
              await composer.inputValue(),
              'full view preserves this human draft',
            );
            const range = await composer.evaluate((node) => [
              node.selectionStart,
              node.selectionEnd,
            ]);
            assert.deepEqual(range, [5, 14]);
            fullTransitions.push({
              turn,
              pid,
              id,
              full,
              range,
              domIdentity: true,
            });
          }
          record.fullTransitions = fullTransitions;
          await input.focus();
          await page.keyboard.type('printf FULLVIEW_PID_STILL_ALIVE');
          await page.keyboard.press('Enter');
          await page.waitForFunction(
            (id) =>
              document
                .querySelector(`#terminal-${id} .xterm-accessibility-tree`)
                ?.textContent.includes('FULLVIEW_PID_STILL_ALIVE'),
            id,
          );
        } else
          assert.equal(
            await page
              .getByRole('button', { name: 'full view', exact: true })
              .count(),
            0,
            'narrow original overlay does not offer full view',
          );
        // The mode has no title bar: its top-bar button, pressed again, closes it.
        const toggle = page.getByRole('button', {
          name: 'terminal panel',
          exact: true,
        });
        assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
        await toggle.click();
        await page
          .locator(`${terminalMode} .native-terminal`)
          .waitFor({ state: 'hidden' });
        assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
        await openTerminalMode(page);
        assert.equal(
          await original.evaluate(
            (element, id) =>
              element.isConnected &&
              element ===
                document
                  .getElementById('terminal-' + id)
                  .querySelector('.xterm-helper-textarea'),
            id,
          ),
          true,
          'hide/reopen retains the real terminal',
        );
        assert.deepEqual(errors, []);
        record.completed = true;
        await writeFile(
          join(output, 'receipt.json'),
          JSON.stringify(
            {
              kind: 'complete actual CircleWorkbench original Inspector with a real PTY',
              receipts,
            },
            null,
            2,
          ),
        );
      } finally {
        await page.close();
        for (const terminal of await manager.list('session1'))
          if (terminal.status === 'running')
            await manager.close('session1', terminal.id);
      }
    }
} finally {
  await browser?.close();
  for (const client of clients) client.end();
  await server.close();
  await manager.dispose();
  await rm(root, { recursive: true, force: true });
}
console.log('PASS complete original Inspector real PTY bounded sizing');
