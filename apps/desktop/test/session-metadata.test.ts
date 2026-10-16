import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { SessionMetadata } from '../src/session-metadata.js';
import { cleanup, scratch } from '../../../tests/helpers.js';

test('independent metadata instances merge archive and restore changes instead of overwriting cached state', (t) => {
  const home = scratch(t);
  const first = new SessionMetadata(home),
    second = new SessionMetadata(home);
  first.set(['first'], true);
  second.set(['second'], true);
  first.refresh();
  second.refresh();
  assert.ok(first.archivedAt('first'));
  assert.ok(first.archivedAt('second'));
  second.set(['first'], false);
  first.set(['third'], true);
  const saved = new SessionMetadata(home);
  assert.equal(saved.archivedAt('first'), undefined);
  assert.ok(saved.archivedAt('second'));
  assert.ok(saved.archivedAt('third'));
});

test('independent processes preserve concurrent archive and restore updates', async (t) => {
  const home = scratch(t);
  const initial = new SessionMetadata(home);
  initial.set(['restore-A', 'restore-B'], true);
  const source = new URL('../src/session-metadata.ts', import.meta.url).href;
  const workers = ['A', 'B'].map((name) =>
    spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
    import { SessionMetadata } from ${JSON.stringify(source)};
    const metadata = new SessionMetadata(process.env.CIRCLE_HOME);
    process.send({ready:true});
    process.on('message', () => {
      for (let i=0;i<20;i++) metadata.set([${JSON.stringify(name)}+'-'+i], true);
      metadata.set([${JSON.stringify('restore-' + name)}], false);
      process.send({done:true}); process.disconnect();
    });
  `,
      ],
      {
        env: { ...process.env, CIRCLE_HOME: home },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      },
    ),
  );
  cleanup(t, async () => {
    await Promise.all(
      workers.map(async (worker) => {
        if (worker.exitCode !== null || worker.signalCode !== null) return;
        const exited = once(worker, 'exit');
        worker.kill('SIGKILL');
        await exited;
      }),
    );
  });
  const reply = (worker: (typeof workers)[number]) =>
    Promise.race([
      once(worker, 'message'),
      once(worker, 'exit').then(([code]) => {
        throw new Error(`metadata child exited ${code} before replying`);
      }),
    ]);
  await Promise.all(workers.map(reply));
  const completed = workers.map(reply);
  for (const worker of workers) worker.send('start');
  await Promise.all(completed);
  initial.refresh();
  for (const name of ['A', 'B']) {
    assert.equal(initial.archivedAt('restore-' + name), undefined);
    for (let i = 0; i < 20; i++) assert.ok(initial.archivedAt(name + '-' + i));
  }
});
