import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  groupHasLiveMember,
  signalProcessGroup,
} from '../src/process_group.js';

const posix = process.platform !== 'win32';

test('a live group is signalled and stops', { skip: !posix }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  assert.equal(await groupHasLiveMember(child.pid!), true);
  const exited = once(child, 'exit');
  assert.equal(await signalProcessGroup(child.pid!, 'SIGTERM'), true);
  await exited;
  // Gone and reaped: nothing has the id any more.
  assert.equal(await signalProcessGroup(child.pid!, 'SIGTERM'), false);
});

test(
  'macOS refusing a group of only exited members is a stopped group, not an error',
  { skip: !posix },
  async (t) => {
    const child = spawn(process.execPath, ['-e', ''], {
      detached: true,
      stdio: 'ignore',
    });
    await once(child, 'exit');
    const refuse = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    t.mock.method(process, 'kill', () => {
      throw refuse;
    });
    assert.equal(await signalProcessGroup(child.pid!, 'SIGTERM'), false);
  },
);

test(
  'a refusal while a live member remains still fails',
  { skip: !posix },
  async (t) => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    await once(child, 'spawn');
    t.after(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    });
    const kill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals) => {
      if (pid === -child.pid!)
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    await assert.rejects(signalProcessGroup(child.pid!, 'SIGTERM'), /EPERM/);
    t.mock.restoreAll();
  },
);
