import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnPty } from '../src/workspace/native-pty.ts';

/** This process's descriptors of the kinds a terminal start used to leave behind. */
function descriptors() {
  const counts = { ptmx: 0, tty: 0, kqueue: 0 };
  const listing = execFileSync('lsof', ['-nP', '-p', String(process.pid)], {
    encoding: 'utf8',
  });
  for (const line of listing.split('\n').slice(1)) {
    if (/\s\/dev\/ptmx$/.test(line)) counts.ptmx++;
    else if (/\s\/dev\/ttys\d+$|\(revoked\)/.test(line)) counts.tty++;
    else if (/\sKQUEUE\s/.test(line)) counts.kqueue++;
  }
  return counts;
}

async function terminal() {
  const pty = spawnPty('/bin/sh', ['-c', 'exit 0'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: tmpdir(),
    env: { PATH: '/usr/bin:/bin' },
  });
  await new Promise<void>((done) => pty.onExit(() => done()));
}

test(
  'a terminal that started and exited leaves no pty or kqueue descriptor behind',
  {
    skip: process.platform !== 'darwin' && 'the leaks were in the macOS spawn',
  },
  async () => {
    // One start first, so what the event loop sets up once is not counted.
    await terminal();
    await delay(300);
    const before = descriptors();
    for (let i = 0; i < 6; i++) await terminal();
    // The exit watcher's thread finishes after the exit is delivered.
    await delay(500);
    assert.deepEqual(descriptors(), before);
  },
);
