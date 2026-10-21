import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { cleanup, scratch } from './helpers.js';

// Dispatch from the real timers phase while the exit deadline itself is controlled.
const dispatch = globalThis.setTimeout;

async function ownedProcess(t: TestContext) {
  const { default: koffi } = await import('koffi');
  const kernel = koffi.load('kernel32.dll');
  const open = kernel.func(
    'uintptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)',
  );
  const wait = kernel.func(
    'uint32_t __stdcall WaitForSingleObject(uintptr_t handle, uint32_t milliseconds)',
  );
  const close = kernel.func('int __stdcall CloseHandle(uintptr_t handle)');
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('message', () => process.exit(17)); process.send('ready');",
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true },
  );
  // Hold this owned process's handle before it can be told to end. Later PID
  // disappearance would not prove that it had exited at the deadline.
  const handle = open(0x101000, 0, child.pid!);
  cleanup(t, async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        child.kill('SIGKILL');
        await ended;
      }
    } finally {
      if (handle) close(handle);
    }
  });
  assert(handle);
  await once(child, 'message');
  return { child, wait: (timeout: number) => wait(handle, timeout) as number };
}

for (const exits of [true, false])
  test(
    exits
      ? 'a Windows browser exit queued behind its deadline is observed before reporting failure'
      : 'a Windows browser still alive after deadline delivery is not reported as exited',
    { skip: process.platform !== 'win32' },
    async (t) => {
      const root = scratch(t);
      const owned = await ownedProcess(t);
      const browser = new ChromeBrowser({
        executable: process.execPath,
        trustFile: join(root, 'trust.json'),
      });
      const order: string[] = [];
      owned.child.once('exit', () => order.push('exit event'));
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const waiting = (browser as any).waitForExit(owned.child, 40);
      try {
        await new Promise<void>((resolve, reject) =>
          dispatch(() => {
            try {
              if (exits) {
                owned.child.send('exit');
                // A safety bound, not a speed assertion: Windows confirms the
                // actual exit while this callback holds its JS event delivery.
                assert.equal(owned.wait(10_000), 0);
                order.push('native exit');
              } else assert.equal(owned.wait(0), 258);
              assert.equal(owned.child.exitCode, null);
              assert.equal(owned.child.signalCode, null);
              order.push('deadline');
              t.mock.timers.tick(40);
              resolve();
            } catch (error) {
              reject(error);
            } finally {
              t.mock.timers.reset();
            }
          }, 0),
        );
        assert.equal(await waiting, exits);
        order.push('result');
        if (exits) {
          assert.equal(owned.child.exitCode, 17);
          assert.equal(owned.wait(0), 0);
          assert.deepEqual(order, [
            'native exit',
            'deadline',
            'exit event',
            'result',
          ]);
        } else {
          assert.equal(owned.wait(0), 258);
          assert.equal(process.kill(owned.child.pid!, 0), true);
          assert.deepEqual(order, ['deadline', 'result']);
        }
      } finally {
        t.mock.timers.reset();
        t.diagnostic(JSON.stringify({ exits, order }));
      }
    },
  );
