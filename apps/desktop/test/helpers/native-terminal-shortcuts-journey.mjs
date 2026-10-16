import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, realpath, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { openNativeTerminalInspector } from './native-terminal-journey.mjs';
import { journeyNodeCommand } from './native-journey-platform.mjs';
import {
  preserveNativeClipboard,
  restoreNativeClipboard,
} from './native-clipboard.mjs';

const paths = {
  program: 'native-terminal-shortcuts.cjs',
  prompt: 'native-terminal-shortcuts-prompt.cjs',
  ready: 'native-terminal-shortcuts-ready.json',
  raw: 'native-terminal-shortcuts-stdin',
  line: 'native-terminal-shortcuts-line',
  starts: 'native-terminal-shortcuts-starts',
  interrupted: 'native-terminal-shortcuts-interrupted.json',
  promptDone: 'native-terminal-shortcuts-prompt.json',
};
const markerFile = '.circle-terminal-shortcuts.json';
export async function createNativeTerminalShortcutsFixture(workspace) {
  const id = randomUUID();
  const payload = `  NATIVE_PASTE_中文_${id}  `;
  const promptMarker = `NATIVE_PROMPT_CONTINUES_${id}`;
  const source = `const fs=require('node:fs'),http=require('node:http'),readline=require('node:readline');
fs.appendFileSync(${JSON.stringify(paths.starts)},'once\\n');
const reader=readline.createInterface({input:process.stdin,terminal:false});
process.stdin.on('data',bytes=>fs.appendFileSync(${JSON.stringify(paths.raw)},bytes));
reader.on('line',line=>{fs.appendFileSync(${JSON.stringify(paths.line)},line);console.log('NATIVE_PASTE_LINE_RECEIVED');});
const server=http.createServer((_request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({id:${JSON.stringify(id)},pid:process.pid}));});
process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(paths.interrupted)},JSON.stringify({id:${JSON.stringify(id)},pid:process.pid,signal:'SIGINT'}));reader.close();process.stdin.pause();server.close(()=>{process.stdin.destroy();console.log('NATIVE_CTRL_C_EXIT');});});
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(${JSON.stringify(paths.ready)},JSON.stringify({id:${JSON.stringify(id)},pid:process.pid,port:server.address().port}));console.log('NATIVE_SHORTCUT_READY');});
`;
  await writeFile(join(workspace, paths.program), source, { flag: 'wx' });
  await writeFile(
    join(workspace, paths.prompt),
    `require('node:fs').writeFileSync(${JSON.stringify(paths.promptDone)},JSON.stringify({marker:${JSON.stringify(promptMarker)},pid:process.pid}));console.log(${JSON.stringify(promptMarker)});\n`,
    { flag: 'wx' },
  );
  const fixture = {
    version: 1,
    id,
    paths,
    payload,
    promptMarker,
    files: [paths.program, paths.prompt, markerFile],
  };
  await writeFile(join(workspace, markerFile), JSON.stringify(fixture), {
    flag: 'wx',
  });
  return fixture;
}

export async function readTerminalShortcutReady(workspace, fixture) {
  try {
    const value = JSON.parse(
      await readFile(join(workspace, fixture.paths.ready), 'utf8'),
    );
    return value.id === fixture.id &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      Number.isSafeInteger(value.port) &&
      value.port > 0 &&
      value.port <= 65535
      ? value
      : undefined;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return;
    throw error;
  }
}

export function assertTerminalShortcutInput(raw, payload) {
  const expected = Buffer.from(payload);
  assert.deepEqual(raw.subarray(0, expected.length), expected);
  // Enter is a transport delimiter, not part of the pasted clipboard content.
  // Preserve and report it; never trim whitespace or normalize payload bytes.
  const delimiter = raw.subarray(expected.length).toString('utf8');
  assert.ok(
    ['\r', '\n', '\r\n'].includes(delimiter),
    'one Enter delimiter only',
  );
  return delimiter;
}
export function terminalShortcutPidGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}
export async function terminalShortcutPortFree(port) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => (error ? reject(error) : resolve(true))),
    );
  });
}

/** Reuses an existing manual PTY. Only visible controls and real keys mutate it. */
export async function runNativeTerminalShortcutsJourney({
  page,
  getApp,
  workspace,
  sessionId,
  terminalId,
  fixture,
  nodePath,
  query,
  until,
  output,
}) {
  assert.deepEqual(
    JSON.parse(await readFile(join(workspace, markerFile), 'utf8')),
    fixture,
  );
  const candidates = (await query('terminal', 'list')).filter(
    (item) =>
      item.owner === sessionId &&
      item.sessionId === sessionId &&
      item.kind === 'shell' &&
      !item.managedCommand &&
      item.status === 'running' &&
      (!terminalId || item.id === terminalId),
  );
  assert.equal(candidates.length, 1, 'pass the exact existing live manual PTY');
  const terminal = candidates[0];
  assert.ok(Number.isSafeInteger(terminal.pid) && terminal.pid > 0);
  assert.equal(await realpath(terminal.cwd), await realpath(workspace));
  const app = getApp();
  const clipboardKey = await preserveNativeClipboard(app);
  const receipt = {
    status: 'running',
    terminal: { id: terminal.id, epoch: terminal.epoch, pid: terminal.pid },
    pasteMethod: process.platform === 'darwin' ? 'Meta+v' : 'Control+v',
    interruptMethod: 'Control+c',
    clipboardRestored: false,
    cleanupErrors: [],
  };
  let failure,
    ready,
    closed = false;
  const panel = () => page.locator('.native-terminal:visible');
  const input = () =>
    page.locator(`#terminal-${terminal.id} .xterm-helper-textarea:visible`);
  const select = async () => {
    await openNativeTerminalInspector(page);
    await panel().locator(`[aria-controls="terminal-${terminal.id}"]`).click();
    await input().focus();
  };
  try {
    await select();
    await page.keyboard.type(
      journeyNodeCommand(
        nodePath,
        join(workspace, fixture.paths.program),
      ).slice(0, -1),
    );
    await page.keyboard.press('Enter');
    await until(
      async () =>
        Boolean((ready = await readTerminalShortcutReady(workspace, fixture))),
      'original shell child is listening',
    );
    const response = await fetch(`http://127.0.0.1:${ready.port}`, {
      signal: AbortSignal.timeout(1500),
    });
    assert.deepEqual(await response.json(), { id: fixture.id, pid: ready.pid });
    receipt.childPid = ready.pid;
    receipt.port = ready.port;
    await page
      .getByRole('button', { name: 'close inspector', exact: true })
      .click();
    process.kill(ready.pid, 0);
    await select();
    const reopened = (await query('terminal', 'list')).find(
      (item) => item.id === terminal.id,
    );
    assert.equal(reopened.epoch, terminal.epoch);
    assert.equal(reopened.pid, terminal.pid);
    assert.equal(reopened.status, 'running');
    await app.evaluate(async ({ clipboard, ClipboardItem }, text) => {
      await clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
    }, fixture.payload);
    await page.evaluate(
      ({ id, payload }) => {
        const observation = { events: [], cleanup: undefined };
        const listener = (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(`#terminal-${id}`)
          )
            observation.events.push({
              trusted: event.isTrusted,
              textMatches:
                event.clipboardData?.getData('text/plain') === payload,
            });
        };
        document.addEventListener('paste', listener, true);
        observation.cleanup = () =>
          document.removeEventListener('paste', listener, true);
        window.__circleTerminalShortcutPaste = observation;
      },
      { id: terminal.id, payload: fixture.payload },
    );
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()
        .find((window) => !window.isDestroyed())
        ?.focus();
    });
    await page.locator(`#terminal-${terminal.id} .xterm-screen`).click();
    await input().focus();
    assert.equal(
      await input().evaluate(
        (node) => document.hasFocus() && document.activeElement === node,
      ),
      true,
    );
    await page.keyboard.press(receipt.pasteMethod);
    await page.keyboard.press('Enter');
    await until(
      async () =>
        (await readFile(join(workspace, fixture.paths.line), 'utf8').catch(
          (error) => {
            if (error.code === 'ENOENT') return '';
            throw error;
          },
        )) === fixture.payload,
      'native paste reaches the original child exactly once',
    );
    const raw = await readFile(join(workspace, fixture.paths.raw));
    receipt.enterDelimiter = assertTerminalShortcutInput(raw, fixture.payload);
    receipt.stdinHex = raw.toString('hex');
    receipt.pasteEvents = await page.evaluate(
      () => window.__circleTerminalShortcutPaste.events,
    );
    assert.ok(
      receipt.pasteEvents.some((event) => event.trusted && event.textMatches),
    );
    assert.equal(
      await readFile(join(workspace, fixture.paths.starts), 'utf8'),
      'once\n',
    );
    await input().focus();
    await page.keyboard.press('Control+c');
    await until(
      () => terminalShortcutPidGone(ready.pid),
      'Control+C exits the actual foreground child',
    );
    await until(
      () => terminalShortcutPortFree(ready.port),
      'Control+C releases the actual child port',
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(workspace, fixture.paths.interrupted), 'utf8'),
      ),
      { id: fixture.id, pid: ready.pid, signal: 'SIGINT' },
    );
    assert.deepEqual(
      await readFile(join(workspace, fixture.paths.raw)),
      raw,
      'no late duplicate paste reached the actual child',
    );
    assert.equal(
      await readFile(join(workspace, fixture.paths.line), 'utf8'),
      fixture.payload,
    );
    receipt.controlCConfirmedAt = Date.now();
    const afterInterrupt = (await query('terminal', 'list')).find(
      (item) => item.id === terminal.id,
    );
    assert.equal(afterInterrupt.status, 'running');
    assert.equal(afterInterrupt.pid, terminal.pid);
    assert.equal(afterInterrupt.epoch, terminal.epoch);
    await page.keyboard.type(
      journeyNodeCommand(nodePath, join(workspace, fixture.paths.prompt)).slice(
        0,
        -1,
      ),
    );
    await page.keyboard.press('Enter');
    await until(async () => {
      try {
        return (
          JSON.parse(
            await readFile(join(workspace, fixture.paths.promptDone), 'utf8'),
          ).marker === fixture.promptMarker
        );
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError)
          return false;
        throw error;
      }
    }, 'the same shell accepts another command after Control+C');
    await page.screenshot({
      path: join(output, 'terminal-native-paste-control-c-prompt.png'),
    });
    receipt.promptContinued = true;
    receipt.status = 'passed';
  } catch (error) {
    failure = error;
    receipt.status = 'failed';
    receipt.error = String(error);
    await page
      .screenshot({ path: join(output, 'terminal-shortcuts-failure.png') })
      .catch(() => {});
  } finally {
    // Stop is only teardown, after the independent Control+C oracle above.
    try {
      await select();
      await panel()
        .getByRole('button', { name: 'stop terminal', exact: true })
        .click();
      await until(async () => {
        const value = (await query('terminal', 'list')).find(
          (item) => item.id === terminal.id,
        );
        return (
          value.status !== 'running' &&
          value.status !== 'stopping' &&
          terminalShortcutPidGone(terminal.pid) &&
          (!ready || terminalShortcutPidGone(ready.pid))
        );
      }, 'closing the original PTY leaves no owned child or shell');
      if (ready) assert.equal(await terminalShortcutPortFree(ready.port), true);
      closed = true;
    } catch (error) {
      receipt.cleanupErrors.push(error);
    }
    try {
      await restoreNativeClipboard(app, clipboardKey);
      receipt.clipboardRestored = true;
    } catch (error) {
      receipt.cleanupErrors.push(error);
    }
    try {
      await page.evaluate(() => {
        window.__circleTerminalShortcutPaste?.cleanup();
        delete window.__circleTerminalShortcutPaste;
      });
    } catch (error) {
      receipt.cleanupErrors.push(error);
    }
    receipt.terminalClosed = closed;
    const errors = receipt.cleanupErrors;
    receipt.cleanupErrors = errors.map(String);
    if (errors.length) receipt.status = 'failed';
    try {
      await mkdir(output, { recursive: true });
      await writeFile(
        join(output, 'terminal-native-shortcuts-receipt.json'),
        JSON.stringify(receipt, null, 2),
      );
    } catch (error) {
      errors.push(error);
    }
    if (failure || errors.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...errors],
        'native terminal shortcut journey failed; see receipt',
      );
  }
  return receipt;
}
