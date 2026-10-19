// Extends the serialized native journey. This helper never launches an app.
// All terminal/process mutations come from renderer controls and real keyboard input.
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { journeyNodeCommand } from './native-journey-platform.mjs';
import { patience } from './patience.mjs';
const marker = '.circle-terminal-journey.json';
const outputFile = 'terminal-output-fixture.cjs';
const serviceFile = 'terminal-service-fixture.cjs';
const prefix = 'CIRCLE_TERMINAL_LINE_';
const line = (number) => `${prefix}${String(number).padStart(4, '0')}_中文`;
const serviceMarker = 'CIRCLE_NATIVE_SERVICE_READY';
export async function createNativeTerminalFixture(workspace) {
  await mkdir(workspace, { recursive: true });
  const files = [outputFile, serviceFile, marker];
  for (const name of files) {
    try {
      await access(join(workspace, name));
      throw Error(`terminal fixture already exists: ${name}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await writeFile(
    join(workspace, outputFile),
    `for(let i=1;i<=600;i++)console.log(${JSON.stringify(prefix)}+String(i).padStart(4,'0')+'_中文');\n`,
  );
  await writeFile(
    join(workspace, serviceFile),
    `const http=require('node:http');const port=Number(process.argv[2]);const args=process.argv.slice(3);const server=http.createServer((_request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({marker:${JSON.stringify(serviceMarker)},pid:process.pid,args}));});server.listen(port,'127.0.0.1',()=>console.log(${JSON.stringify(serviceMarker)},port,process.pid));for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));\n`,
  );
  await writeFile(
    join(workspace, marker),
    JSON.stringify({ version: 1, outputFile, serviceFile, lines: 600 }),
  );
  return { files, outputFile, serviceFile };
}
async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done, fail) =>
    server.close((error) => (error ? fail(error) : done())),
  );
  return port;
}
async function canBind(port) {
  const server = createServer();
  try {
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(port, '127.0.0.1', done);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise((done) => server.close(done));
  }
}
/**
 * Open the work drawer's terminal mode without toggling an already open mode closed.
 * A stand-in drawer of the earlier layout, which still has a terminal tab, works too.
 */
export async function openNativeTerminalInspector(page) {
  const toggle = page.getByRole('button', {
    name: 'terminal panel',
    exact: true,
  });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true')
    await toggle.click();
  const tab = page.locator('#inspector-terminal-tab-terminal');
  if (await tab.count()) await tab.click();
  const panel = page.locator(
    ':is([data-inspector-resource="terminal"], #inspector-terminal-terminal) .native-terminal:visible',
  );
  await panel.waitFor();
  return panel;
}
/** Make a shell from the + menu at the end of the terminal tabs. */
export async function chooseNewLocalTerminal(page, panel) {
  await panel
    .getByRole('button', { name: 'new terminal or device', exact: true })
    .click();
  // The item is disabled while another terminal action runs; a click waits for it.
  await page.getByRole('menuitem', { name: /^new local terminal/ }).click();
}
/**
 * Choose what the tab in front can be told to do from its ⋮ menu: find in terminal, add
 * selection to chat, copy complete output, restart, interrupt command, start service.
 * A disabled item is waited for until it is enabled.
 */
export async function chooseTerminalAction(page, panel, name) {
  await panel
    .getByRole('button', { name: 'terminal menu', exact: true })
    .click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
/** Whether an item of the ⋮ menu is enabled; the menu is closed again afterwards. */
export async function terminalActionEnabled(page, panel, name) {
  await panel
    .getByRole('button', { name: 'terminal menu', exact: true })
    .click();
  const item = page.getByRole('menuitem', { name, exact: true });
  await item.waitFor();
  const enabled = (await item.getAttribute('aria-disabled')) !== 'true';
  await page.keyboard.press('Escape');
  await item.waitFor({ state: 'detached' });
  return enabled;
}
/** Requires English interface, an active granted session, and clipboard preservation by the parent driver. */
export async function runNativeTerminalJourney({
  page,
  workspace,
  sessionId,
  output,
  nodePath,
  clipboard,
  query: injectedQuery,
  until: injectedUntil,
  screenshot: injectedScreenshot,
}) {
  const ownership = JSON.parse(await readFile(join(workspace, marker), 'utf8'));
  assert.deepEqual(ownership, {
    version: 1,
    outputFile,
    serviceFile,
    lines: 600,
  });
  assert.equal(
    typeof clipboard?.readText,
    'function',
    'real native clipboard reader is required',
  );
  assert.ok(nodePath, 'pass the verified bundled Node executable');
  const query =
    injectedQuery ??
    (async (service, method, params = {}) =>
      page.evaluate(
        async ({ sessionId, service, method, params }) => {
          const result = await window.circleDesktop.runtimeCommand({
            id: crypto.randomUUID(),
            name: 'workspace-service',
            sessionId,
            payload: { service, method, params },
          });
          if (!result.ok) throw Error(result.error);
          return result.data;
        },
        { sessionId, service, method, params },
      ));
  const until =
    injectedUntil ??
    (async (predicate, label, ms = 20000) => {
      const deadline = Date.now() + patience(ms);
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await page.waitForTimeout(40);
      }
      throw Error('terminal native journey timed out: ' + label);
    });
  const screenshot =
    injectedScreenshot ??
    (async (name) => {
      if (output) {
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: join(output, name + '.png') });
      }
    });
  const checks = [],
    created = [];
  let completed = false;
  let phase = 'create terminal';
  const list = () => query('terminal', 'list');
  const replay = async (id) => {
    let cursor = 0,
      text = '';
    for (let i = 0; i < 200; i++) {
      const result = await query('terminal', 'replay', {
        id,
        afterSequence: cursor,
        limit: 512,
      });
      text += result.events
        .filter((event) => event.kind === 'data')
        .map((event) => event.data ?? '')
        .join('');
      if (!result.hasMore) return text;
      assert(
        result.nextSequence > cursor,
        'terminal replay cursor must advance',
      );
      cursor = result.nextSequence;
    }
    throw Error('unexpected terminal fixture output size');
  };
  const panel = await openNativeTerminalInspector(page);
  const selectedTab = (id) =>
    panel.locator(`[role="tab"][aria-controls="terminal-${id}"]`);
  // A tab's × stops what runs in it and takes the tab out of the row. The filter's
  // locator is evaluated inside each tab, so it does not repeat the panel.
  const closeButton = (id) =>
    panel
      .locator('.term-tab')
      .filter({
        has: page.locator(`[role="tab"][aria-controls="terminal-${id}"]`),
      })
      .locator('.term-tab-x');
  const select = async (id) => {
    await selectedTab(id).click();
    await until(
      async () =>
        (await selectedTab(id).getAttribute('aria-selected')) === 'true',
      'terminal tab selected',
    );
  };
  const create = async () => {
    const prior = new Set((await list()).map((terminal) => terminal.id));
    let terminal;
    await chooseNewLocalTerminal(page, panel);
    await until(
      async () =>
        Boolean(
          (terminal = (await list()).find(
            (terminal) => !prior.has(terminal.id),
          )),
        ),
      'new real terminal created',
    );
    created.push(terminal.id);
    await selectedTab(terminal.id).waitFor();
    return terminal;
  };
  let service;
  try {
    const first = await create();
    const input = panel.locator(`#terminal-${first.id} .xterm-helper-textarea`);
    await input.focus();
    await page.keyboard.type(
      journeyNodeCommand(nodePath, join(workspace, outputFile)).slice(0, -1),
    );
    await page.keyboard.press('Enter');
    await until(
      async () => (await replay(first.id)).includes(line(600)),
      'all 600 actual output lines',
    );
    phase = 'search rendered output';
    const find = panel.getByRole('textbox', {
      name: 'find in terminal',
      exact: true,
    });
    await input.focus();
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
    );
    await until(
      () => find.evaluate((element) => document.activeElement === element),
      'find shortcut focuses the existing terminal search',
    );
    await find.fill(line(1));
    await find.press('Enter');
    await until(
      async () =>
        (await panel
          .locator(`#terminal-${first.id} .xterm-selection div`)
          .count()) > 0 &&
        !(await panel.getByText('no matches', { exact: true }).isVisible()),
      'real xterm selects the complete Chinese match after parsing pending replay',
    );
    assert.equal(
      await panel.getByText('no matches', { exact: true }).isVisible(),
      false,
    );
    await find.press('Escape');
    // The terminal copies with cmd+c, or ctrl+shift+c where ctrl+c interrupts.
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+c' : 'Control+Shift+c',
    );
    await until(
      async () => (await clipboard.readText()).trim() === line(1),
      'search result copies exact selected match',
    );
    // Escape closed the search and returned to the terminal; the shortcut opens it again.
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
    );
    await find.fill('CIRCLE_NO_SUCH_TERMINAL_MATCH');
    await find.press('Enter');
    await panel.getByText('no matches', { exact: true }).waitFor();
    await find.fill('');
    checks.push(
      'real xterm search, no-match feedback, keyboard focus and selected-match copy',
    );
    phase = 'copy complete output';
    await chooseTerminalAction(page, panel, 'copy complete output');
    let copied;
    await until(async () => {
      copied = await clipboard.readText();
      return copied.includes(line(600));
    }, 'complete output reaches native clipboard');
    const copiedLines = copied.match(/CIRCLE_TERMINAL_LINE_\d{4}_中文/g) ?? [];
    assert.deepEqual(
      copiedLines,
      Array.from({ length: 600 }, (_, index) => line(index + 1)),
      'complete clipboard preserves all 600 multilingual lines in order',
    );
    await screenshot('terminal-600-lines-search-and-complete-copy');
    checks.push(
      '600 actual multilingual output lines copied completely and in order',
    );
    const second = await create();
    phase = 'independent terminal buffers';
    await select(first.id);
    await chooseTerminalAction(page, panel, 'copy complete output');
    await until(
      async () => (await clipboard.readText()).includes(line(600)),
      'first terminal retains its output after tab switch',
    );
    await select(second.id);
    await chooseTerminalAction(page, panel, 'copy complete output');
    await until(
      async () => !(await clipboard.readText()).includes(prefix),
      'second terminal has an independent output buffer',
    );
    assert.equal(
      (await list()).find((terminal) => terminal.id === first.id).status,
      'running',
    );
    assert.equal(
      (await list()).find((terminal) => terminal.id === second.id).status,
      'running',
    );
    checks.push(
      'multiple real terminals switch without sharing buffers or stopping another shell',
    );
    await screenshot('terminal-independent-tabs');
    const port = await freePort();
    phase = 'start managed service';
    await chooseTerminalAction(page, panel, 'start service');
    const dialog = page.getByRole('dialog', {
      name: 'start service',
      exact: true,
    });
    await dialog
      .getByLabel('service name', { exact: true })
      .fill('native journey service');
    await dialog
      .getByLabel('service executable', { exact: true })
      .fill(nodePath);
    await dialog.getByLabel('service folder', { exact: true }).fill(workspace);
    const args = [
      join(workspace, serviceFile),
      String(port),
      'space argument',
      '',
    ];
    for (let i = 0; i < args.length; i++) {
      const field = dialog.getByRole('textbox', {
        name: `service argument ${i + 1}`,
        exact: true,
      });
      if (!(await field.count()))
        await dialog
          .getByRole('button', { name: 'add service argument', exact: true })
          .click();
      await field.fill(args[i]);
    }
    await dialog.getByLabel('ready port', { exact: true }).fill(String(port));
    await dialog
      .getByLabel('ready log text', { exact: true })
      .fill(serviceMarker);
    await dialog
      .getByRole('button', { name: 'start service', exact: true })
      .click();
    await dialog.waitFor({ state: 'hidden' });
    await until(
      async () =>
        Boolean(
          (service = (await list()).find(
            (terminal) =>
              terminal.label === 'native journey service' &&
              terminal.serviceState === 'ready',
          )),
        ),
      'real managed HTTP service ready by both port and log',
      // Longer than the service's own 30 s readiness limit, so the journey
      // sees the service's outcome rather than giving up before it.
      40000,
    );
    created.push(service.id);
    const response = async () => {
      const reply = await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(1500),
      });
      assert.equal(reply.status, 200);
      return reply.json();
    };
    let actual = await response();
    assert.equal(actual.pid, service.pid);
    assert.equal(actual.marker, serviceMarker);
    assert.deepEqual(actual.args, ['space argument', '']);
    assert.deepEqual(service.command.args, args);
    // The service has a tab of its own, in front, named as the form named it.
    assert.equal(
      await selectedTab(service.id).getAttribute('aria-selected'),
      'true',
    );
    assert.equal(
      (await selectedTab(service.id).innerText()).trim(),
      'native journey service',
    );
    await screenshot('terminal-managed-service-ready');
    const previous = service;
    const previousProcess = actual.pid;
    phase = 'restart managed service';
    // Restarting stops the running process, then starts the same service again: the new
    // process can only listen on the port once the old one has given it back.
    await chooseTerminalAction(page, panel, 'restart service');
    await until(
      async () =>
        Boolean(
          (service = (await list()).find(
            (terminal) =>
              terminal.restartOf === previous.id &&
              terminal.serviceState === 'ready',
          )),
        ),
      'service restart becomes ready',
      40000,
    );
    created.push(service.id);
    assert.equal(service.serviceId, previous.serviceId);
    assert.notEqual(service.id, previous.id);
    assert.notEqual(service.epoch, previous.epoch);
    assert.equal(
      (await list()).find((terminal) => terminal.id === previous.id)
        .serviceState,
      'stopped',
    );
    actual = await response();
    assert.equal(actual.pid, service.pid);
    assert.notEqual(actual.pid, previousProcess);
    assert.deepEqual(actual.args, ['space argument', '']);
    await screenshot('terminal-managed-service-restarted-same-identity');
    phase = 'stop managed service and release port';
    // The service tab's × stops it and closes the tab.
    await closeButton(service.id).click();
    await until(
      async () =>
        (await list()).find((terminal) => terminal.id === service.id)
          ?.serviceState === 'stopped',
      'managed service stops from its tab',
    );
    await until(() => canBind(port), 'actual service port is released');
    await selectedTab(service.id).waitFor({ state: 'detached' });
    await screenshot('terminal-managed-service-stopped-port-free');
    checks.push(
      'UI service argv, actual HTTP readiness, restart keeps the service identity with a new process epoch after releasing the port, and the tab stops it and releases the port',
    );
    service = undefined;
    const receipt = {
      kind: 'real native xterm and service manager',
      checks,
      lineCount: 600,
      terminals: [first.id, second.id],
      service: {
        id: previous.serviceId,
        initialTerminalId: previous.id,
        restartedTerminalId: (await list()).find(
          (terminal) => terminal.restartOf === previous.id,
        ).id,
        port,
      },
      sessionId,
    };
    if (output)
      await writeFile(
        join(output, 'terminal-extended-journey.json'),
        JSON.stringify(receipt, null, 2),
      );
    completed = true;
    return receipt;
  } catch (error) {
    // Preserve the actual failed screen and original output before UI cleanup
    // changes selection or stops the owned shell. Never capture the user's
    // pre-existing clipboard; the parent preserves and restores it separately.
    if (output) {
      try {
        await mkdir(output, { recursive: true });
        await screenshot('terminal-extended-failure-before-cleanup');
        const terminals = await list();
        const logs = await Promise.all(
          created.map(async (id) => ({ id, text: await replay(id) })),
        );
        const view = await panel.evaluate((element) => ({
          selectedTab: element
            .querySelector('[role="tab"][aria-selected="true"]')
            ?.getAttribute('aria-controls'),
          search: element.querySelector('.native-terminal-search input')?.value,
          text: element.textContent,
        }));
        await writeFile(
          join(output, 'terminal-extended-failure.json'),
          JSON.stringify(
            {
              phase,
              checks,
              terminals,
              logs,
              view,
              error: { message: error.message, stack: error.stack },
            },
            null,
            2,
          ),
        );
      } catch {
        /* Keep the original assertion if renderer evidence is unavailable. */
      }
    }
    throw error;
  } finally {
    // UI-only cleanup: each owned tab's ×. The parent app teardown remains the owner if
    // the renderer fails.
    const failures = [];
    for (const id of created.reverse()) {
      try {
        const terminal = (await list()).find((terminal) => terminal.id === id);
        if (terminal && ['running', 'stopping'].includes(terminal.status)) {
          // A stop already asked for keeps the tab until the process tree has
          // exited, which is slow on Windows.
          if (terminal.status === 'running' && (await closeButton(id).count()))
            await closeButton(id).click();
          await until(
            async () =>
              !['running', 'stopping'].includes(
                (await list()).find((terminal) => terminal.id === id)?.status,
              ),
            'owned terminal cleanup',
          );
        }
      } catch (error) {
        failures.push(error);
        /* Preserve the primary failure; the parent always disposes its isolated app. */
      }
    }
    if (completed && failures.length)
      throw new AggregateError(failures, 'terminal UI cleanup failed');
  }
}
