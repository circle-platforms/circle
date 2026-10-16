import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { CheckpointStore, databaseOpenError } from '../src/checkpoint_store.js';
import { cleanup, scratch } from './helpers.js';

const moduleUrl = (name: string) =>
  JSON.stringify(pathToFileURL(join(process.cwd(), 'src', name + '.ts')).href);

function tracked(child: ChildProcess): {
  out: () => string;
  err: () => string;
} {
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr!.on('data', (chunk) => {
    err += chunk;
  });
  return {
    out: () => out,
    err: () => err,
  };
}

async function until(
  predicate: () => boolean,
  timeout: number,
  detail: () => string,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(detail());
    await delay(10);
  }
}

test('a locked database waits and then opens', async (t) => {
  const home = scratch(t);
  const prepared = new CheckpointStore(home);
  prepared.close();
  const db = new DatabaseSync(join(home, 'circle.sqlite'), { timeout: 5000 });
  db.exec('BEGIN EXCLUSIVE');
  const worker = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
      import { writeSync } from 'node:fs';
      import { CheckpointStore } from ${moduleUrl('checkpoint_store')};
      writeSync(1, 'starting\\n');
      const store = new CheckpointStore(process.env.TEST_HOME);
      writeSync(1, 'opened\\n');
      store.close();
    `,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, TEST_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const text = tracked(worker);
  const exited = once(worker, 'exit');
  cleanup(t, async () => {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* Already committed or closed. */
    }
    try {
      db.close();
    } catch {
      /* The holder is already closed. */
    }
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
      await once(worker, 'exit');
    }
  });
  await until(
    () => text.out().includes('starting'),
    5000,
    () => `child did not start\n${text.out()}\n${text.err()}`,
  );
  assert.equal(text.out().includes('opened'), false);
  await delay(300);
  assert.equal(
    text.out().includes('opened'),
    false,
    `opened while the database was locked\n${text.out()}\n${text.err()}`,
  );
  db.exec('COMMIT');
  await until(
    () => text.out().includes('opened'),
    8000,
    () => `child did not open\n${text.out()}\n${text.err()}`,
  );
  const [code] = await exited;
  assert.equal(code, 0, text.err());
});

test('a database lock that outlasts the wait says another Circle is using the folder', () => {
  const locked = Object.assign(new Error('database is locked'), { errcode: 5 });
  const friendly = databaseOpenError(locked);
  assert.match(friendly.message, /another Circle is using this data folder/);
  assert.equal(friendly.cause, locked);
  const busy = new Error('SQLITE_BUSY');
  assert.match(
    databaseOpenError(busy).message,
    /Wait a moment and start again/,
  );
  const other = new Error('unable to open database file');
  assert.equal(databaseOpenError(other), other);
});
