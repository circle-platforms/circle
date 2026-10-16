import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalManager } from '../../desktop/src/workspace/terminal.ts';
import { openNativeTerminalInspector } from '../../desktop/test/helpers/native-terminal-journey.mjs';
import { journeyNodeCommand } from '../../desktop/test/helpers/native-journey-platform.mjs';
const root = await mkdtemp(join(tmpdir(), 'circle-terminal-fit-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
const fixture = join(workspace, 'actual-viewport.cjs');
await writeFile(
  fixture,
  "console.log('NATIVE_VIEWPORT_'+process.stdout.columns+'x'+process.stdout.rows);\n",
);
const output =
  process.env.CIRCLE_TERMINAL_FIT_EVIDENCE ?? join(root, 'evidence');
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
  server: { host: '127.0.0.1', port: 0 },
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
            'test/native-terminal-fit-ui.html?theme=' +
            theme,
        );
        const panel = await openNativeTerminalInspector(page);
        await panel
          .getByRole('button', { name: 'new terminal', exact: true })
          .first()
          .click();
        await page
          .locator('.xterm-helper-textarea')
          .waitFor({ state: 'attached' });
        const id = (await manager.list('session1')).at(-1).id;
        const input = page.locator(`#terminal-${id} .xterm-helper-textarea`);
        const original = await input.elementHandle();
        const samples = [];
        // Observe real rendered frames, rather than fitting a terminal into a fixed-height component fixture.
        for (let frame = 0; frame < 90; frame++) {
          await page.evaluate(() => new Promise(requestAnimationFrame));
          if (frame % 10 === 0) {
            const geometry = await page.evaluate((id) => {
              const selectors = [
                '.inspector-body',
                '#inspector-terminal-terminal',
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
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .click();
        await openNativeTerminalInspector(page);
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
