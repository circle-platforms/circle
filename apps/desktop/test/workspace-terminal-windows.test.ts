import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  TerminalManager,
  type TerminalEvent,
} from '../src/workspace/terminal.ts';

// No shell syntax or Unix signals: this exact fixture runs under Windows ConPTY.
test(
  'native PTY Node child preserves argv, stdin, resize, Ctrl+C, restart and owned port cleanup',
  { timeout: 25_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'circle-portable-pty-'));
    const events: TerminalEvent[] = [];
    const manager = new TerminalManager(
      { workspaceRoot: root, logRoot: join(root, 'logs'), stopGraceMs: 200 },
      (event) => {
        events.push(event);
      },
    );
    const owner = 'portable-pty';
    const output = (id: string) =>
      events
        .filter((e) => e.terminalId === id)
        .map((e) => e.data ?? '')
        .join('');
    const wait = async (predicate: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 8000;
      while (!(await predicate())) {
        if (Date.now() > deadline)
          throw Error('PTY condition timed out: ' + JSON.stringify(events));
        await delay(20);
      }
    };
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    try {
      const terminal = await manager.create({
        owner,
        sessionId: 'portable',
        command: {
          file: process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
          args: [
            fileURLToPath(
              new URL('./fixtures/native-pty-child.cjs', import.meta.url),
            ),
            String(port),
            '',
            'space argument',
            'quote"literal',
          ],
        },
        cols: 90,
        rows: 30,
        readiness: { pattern: 'CHILD_READY:', port, timeoutMs: 8000 },
      });
      await wait(() => output(terminal.id).includes('CHILD_READY:'));
      assert.match(output(terminal.id), /"tty":\[true,true\]/);
      assert.match(
        output(terminal.id),
        /"argv":\["","space argument","quote\\"literal"\]/,
      );
      await manager.resize(owner, terminal.id, 111, 37);
      await manager.write(owner, terminal.id, 'actual-input\r');
      await wait(() =>
        output(terminal.id).includes('CHILD_REPLY:actual-input:SIZE:111:37'),
      );
      assert.equal(
        await (await fetch(`http://127.0.0.1:${port}`)).text(),
        'owned-child',
      );
      await manager.signal(owner, terminal.id, 'SIGINT');
      await wait(
        async () =>
          (await manager.list(owner)).find((entry) => entry.id === terminal.id)
            ?.exitedAt !== undefined,
      );
      await assert.rejects(fetch(`http://127.0.0.1:${port}`));
      const restarted = await manager.restart(owner, terminal.id);
      assert.equal(restarted.restartOf, terminal.id);
      await wait(() => output(restarted.id).includes('CHILD_READY:'));
      assert.equal(
        await (await fetch(`http://127.0.0.1:${port}`)).text(),
        'owned-child',
      );
      await manager.close(owner, restarted.id);
      await assert.rejects(fetch(`http://127.0.0.1:${port}`));
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
