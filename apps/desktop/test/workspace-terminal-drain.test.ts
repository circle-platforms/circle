import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WorkspaceServices } from '../src/workspace/workspace-services.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  TerminalManager,
  type TerminalEvent,
} from '../src/workspace/terminal.ts';

test('dispose drains queued final PTY events before releasing its consumer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-terminal-drain-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: TerminalEvent[] = [];
  const manager = new TerminalManager(
    { workspaceRoot: root, logRoot: join(root, 'logs'), stopGraceMs: 100 },
    async (event) => {
      await gate;
      seen.push(event);
    },
  );
  try {
    const terminal = await manager.create({
      owner: 'owner',
      sessionId: 's',
      command: {
        file: process.execPath,
        args: ['-e', "process.stdout.write('FINAL_TAIL')"],
      },
    });
    for (let i = 0; i < 200; i++) {
      if ((await manager.list('owner'))[0]?.status === 'exited') break;
      await delay(10);
    }
    assert.equal((await manager.list('owner'))[0]?.status, 'exited');
    let disposed = false;
    const closing = manager.dispose().then(() => {
      disposed = true;
    });
    await delay(20);
    assert.equal(
      disposed,
      false,
      'a gated consumer must keep disposal pending',
    );
    assert.equal(seen.length, 0);
    release();
    await closing;
    assert.equal(seen.at(-1)?.kind, 'exit');
    assert.ok(
      seen.some(
        (event) => event.kind === 'data' && event.data?.includes('FINAL_TAIL'),
      ),
    );
    assert.ok(
      (await readFile(terminal.logPath, 'utf8')).includes('FINAL_TAIL'),
    );
    const count = seen.length;
    await delay(20);
    assert.equal(
      seen.length,
      count,
      'no background callback survives disposal',
    );
    const replay = await manager.replay('owner', terminal.id, 0, 100);
    assert.deepEqual(
      replay.events.map((event) => event.sequence),
      seen.map((event) => event.sequence),
    );
  } finally {
    release();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace disposal commits PTY tail and exit queued behind the durable writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-workspace-drain-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: join(root, 'data'),
    runtimeExecutable: process.execPath,
    ghPath: 'absent',
    emit: () => {},
    eventStreamOptions: { beforeWrite: () => gate },
  });
  try {
    const terminal = await service.terminals.create({
      owner: 'owner',
      sessionId: 's',
      command: {
        file: process.execPath,
        args: ['-e', "process.stdout.write('DURABLE_TAIL')"],
      },
    });
    for (let i = 0; i < 200; i++) {
      if ((await service.terminals.list('owner'))[0]?.status === 'exited')
        break;
      await delay(10);
    }
    assert.equal((await service.terminals.list('owner'))[0]?.status, 'exited');
    const closing = service.dispose();
    await delay(20);
    release();
    await closing;
    const journalPath = join(
      root,
      'data',
      'workspaces',
      createHash('sha256').update(root).digest('hex'),
      'events.jsonl',
    );
    const journal = await readFile(journalPath, 'utf8');
    const events = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter(
        (event) =>
          event.service === 'terminal' && event.resourceId === terminal.id,
      );
    assert.equal(events.at(-1)?.data.kind, 'exit');
    assert.ok(
      events.some(
        (event) =>
          event.data.kind === 'data' &&
          event.data.data.includes('DURABLE_TAIL'),
      ),
    );
    await delay(20);
    assert.equal(await readFile(journalPath, 'utf8'), journal);
    assert.equal(service.eventHealth.error, undefined);
  } finally {
    release();
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'a stalled event consumer makes shutdown fail explicitly within a finite bound',
  { timeout: 8000 },
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'circle-terminal-drain-timeout-'),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new TerminalManager(
      { workspaceRoot: root, logRoot: join(root, 'logs') },
      () => gate,
    );
    try {
      await manager.create({
        owner: 'owner',
        sessionId: 's',
        command: { file: process.execPath, args: ['-e', 'process.exit(0)'] },
      });
      await assert.rejects(
        manager.dispose(),
        (error: unknown) =>
          error instanceof AggregateError &&
          error.errors.some((cause) =>
            /terminal event delivery did not finish/.test(String(cause)),
          ),
      );
    } finally {
      release();
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
