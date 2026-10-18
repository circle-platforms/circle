import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  endStranded,
  strandedChildren,
  type WindowsChildrenApi,
} from '../src/windows_stranded.js';

const shell = { pid: 100, started: 10_000, ended: 20_000 };
const api = (
  processes: { pid: number; parent: number; started?: number }[],
): WindowsChildrenApi => ({
  processes: () => processes.map(({ pid, parent }) => ({ pid, parent })),
  started: (pid) => processes.find((entry) => entry.pid === pid)?.started,
});

test('a program a stopped Windows shell started while it ran is found, and no other process', () => {
  assert.deepEqual(
    strandedChildren(
      api([
        // Started by the shell after taskkill had looked: it outlived the shell.
        { pid: 200, parent: 100, started: 15_000 },
        // Its recorded start lags the clock Circle read by less than a tick.
        { pid: 201, parent: 100, started: 9_950 },
        // The PID was reused after the shell ended, and that process started this one.
        { pid: 202, parent: 100, started: 20_500 },
        // An earlier process with the same PID started this one before the shell existed.
        { pid: 203, parent: 100, started: 5_000 },
        // Ended before it could be read.
        { pid: 204, parent: 100 },
        { pid: 205, parent: 7, started: 15_000 },
        { pid: 100, parent: 100, started: 15_000 },
      ]),
      shell,
    ),
    [200, 201],
  );
});

test('ending what a stopped shell left running ends each such program with its own tree', async () => {
  const killed: number[] = [];
  assert.deepEqual(
    await endStranded(
      shell,
      async () =>
        api([
          { pid: 200, parent: 100, started: 15_000 },
          { pid: 300, parent: 200, started: 15_100 },
        ]),
      async (pid) => {
        killed.push(pid);
      },
    ),
    [200],
  );
  assert.deepEqual(killed, [200]);
});

test(
  'on Windows a program left running by an ended shell is found and ended',
  { skip: process.platform !== 'win32' && 'uses the Windows process list' },
  async (t) => {
    const started = Date.now();
    // start /b leaves node running after cmd ends, as a program the shell started just after
    // taskkill had looked at its tree.
    const line = `start "" /b "${process.execPath}" -e "console.log(process.pid); setTimeout(function () {}, 30000)"`;
    const shellProcess = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    let output = '';
    shellProcess.stdout.on('data', (chunk: Buffer) => (output += chunk));
    await once(shellProcess, 'exit');
    const ended = Date.now();
    while (!/^\d+\s*$/m.test(output)) await delay(20);
    const orphan = Number(/^(\d+)/m.exec(output)![1]);
    const alive = (): boolean => {
      try {
        process.kill(orphan, 0);
        return true;
      } catch {
        return false;
      }
    };
    t.after(() => {
      if (alive()) process.kill(orphan);
    });
    assert.ok(alive(), 'the program outlived its shell');
    assert.deepEqual(
      await endStranded({ pid: shellProcess.pid!, started, ended }),
      [orphan],
    );
    while (alive()) await delay(20);
  },
);
