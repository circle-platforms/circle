import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  readdir,
  realpath,
  mkdir,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceServices } from '../src/workspace/workspace-services.ts';
import type { WorkspaceDocument } from '../src/workspace/documents.ts';
import type {
  TerminalSnapshot,
  TerminalReplay,
} from '../src/workspace/terminal.ts';
import type { WorkspaceServiceEvent } from '../src/workspace-protocol.ts';
test('workspace routing preserves revisions, isolates terminal owners and persists before delivery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-services-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-services-data-'));
  const events: WorkspaceServiceEvent[] = [];
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: path.join(root, 'missing-adapter'),
    ghPath: path.join(root, 'missing-gh'),
    credentialFiles: ['private.custom'],
    terminalEnv: {
      HOME: root,
      ZDOTDIR: root,
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
    },
    emit: (event) => events.push(event),
  });
  try {
    await writeFile(path.join(root, 'private.custom'), 'not for tools');
    await assert.rejects(
      service.call('session-a', 'documents', 'read', {
        path: 'private.custom',
      }),
      /file is not available in this workspace/,
    );
    await writeFile(path.join(root, 'later.secret'), 'not for tools');
    service.setCredentialFiles(['private.custom', 'later.secret']);
    await assert.rejects(
      service.call('session-a', 'documents', 'read', { path: 'later.secret' }),
      /file is not available in this workspace/,
    );
    await assert.rejects(
      service.call('session-a', 'documents', 'read', { path: 123 }),
      /string/,
    );
    await assert.rejects(
      service.call('session-a', 'terminal', 'create', { cols: '80' }),
      /integer/,
    );
    await assert.rejects(
      service.call('session-a', 'terminal', 'create', {
        command: { file: 123 },
      }),
      /string/,
    );
    await assert.rejects(
      service.call('session-a', 'terminal', 'create', {
        command: { file: 'node' },
        readiness: { port: '80' },
      }),
      /integer/,
    );
    await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
    assert.deepEqual(
      await service.call('session-a', 'documents', 'resolveSource', {
        path: path.join(root, 'a.ts'),
      }),
      { path: 'a.ts' },
    );
    assert.deepEqual(
      await service.call('session-a', 'documents', 'resolveSource', {
        path: 'a.ts',
      }),
      { path: 'a.ts' },
    );
    await writeFile(path.join(data, 'outside.ts'), 'outside');
    await assert.rejects(
      service.call('session-a', 'documents', 'resolveSource', {
        path: path.join(data, 'outside.ts'),
      }),
      /outside/,
    );
    await symlink(path.join(data, 'outside.ts'), path.join(root, 'escape.ts'));
    await assert.rejects(
      service.call('session-a', 'documents', 'resolveSource', {
        path: 'escape.ts',
      }),
      /outside/,
    );
    if (process.platform === 'darwin') {
      const canonical = await realpath(path.join(root, 'a.ts'));
      const alias = canonical.startsWith('/private/var/')
        ? canonical.replace('/private/var/', '/var/')
        : canonical;
      assert.deepEqual(
        await service.call('session-a', 'documents', 'resolveSource', {
          path: alias,
        }),
        { path: 'a.ts' },
      );
    }
    const doc = (await service.call('session-a', 'documents', 'read', {
      path: 'a.ts',
    })) as WorkspaceDocument;
    await service.call('session-a', 'documents', 'save', {
      path: 'a.ts',
      content: 'export const a = 2;\n',
      expectedRevision: doc.revision,
    });
    assert.equal(
      await readFile(path.join(root, 'a.ts'), 'utf8'),
      'export const a = 2;\n',
    );
    assert.ok(
      events.some((e) => e.service === 'documents' && e.data.kind === 'save'),
    );
    const folder = (await readdir(path.join(data, 'workspaces')))[0];
    const journal = await readFile(
      path.join(data, 'workspaces', folder, 'events.jsonl'),
      'utf8',
    );
    assert.ok(journal.includes('"kind":"save"'));
    const firstPage = await service.replay();
    assert.equal(firstPage.events[0].workspaceId.length, 24);
    const event = {
      workspaceId: firstPage.events[0].workspaceId,
      sessionId: 'session-a',
      service: 'tasks' as const,
      resourceId: 'task-1',
      epoch: 'task-runtime',
      seq: 99,
      at: new Date().toISOString(),
      data: { kind: 'progress' },
    };
    await assert.rejects(
      service.publishSource({ ...event, workspaceId: 'foreign-workspace' }),
      /does not belong/,
    );
    await service.publishSource(event);
    const nextPage = await service.replay(firstPage.cursor);
    assert.ok(
      nextPage.events.some(
        (item) => item.sourceSeq === 99 && item.data.kind === 'progress',
      ),
    );

    await assert.rejects(
      service.call('session-a', 'documents', 'save', {
        path: 'a.ts',
        content: 'lost',
        expectedRevision: doc.revision,
      }),
      /changed/i,
    );
    const terminal = (await service.call('session-a', 'terminal', 'create', {
      shell: '/bin/sh',
      owner: 'session-b',
      sessionId: 'session-b',
    })) as TerminalSnapshot;
    assert.equal(terminal.owner, 'session-a');
    await assert.rejects(
      service.call('session-b', 'terminal', 'write', {
        id: terminal.id,
        data: 'echo forbidden\r',
      }),
      /owner|not found|belong|unknown/i,
    );
    await service.call('session-a', 'terminal', 'write', {
      id: terminal.id,
      data: 'echo CIRCLE_NATIVE_ROUTING_OK\r',
    });
    let replay: TerminalReplay | undefined;
    for (let i = 0; i < 100; i++) {
      replay = (await service.call('session-a', 'terminal', 'replay', {
        id: terminal.id,
      })) as TerminalReplay;
      if (
        replay.events.some((e) => e.data?.includes('CIRCLE_NATIVE_ROUTING_OK'))
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(
      replay?.events.some((e) => e.data?.includes('CIRCLE_NATIVE_ROUTING_OK')),
    );
    await service.call('session-a', 'terminal', 'close', { id: terminal.id });
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
test('releasing one session waits for its PTY exit and preserves another session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-session-release-'));
  const data = await mkdtemp(
    path.join(tmpdir(), 'circle-session-release-data-'),
  );
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    terminalEnv: {
      HOME: root,
      ZDOTDIR: root,
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
    },
    emit: () => {},
  });
  try {
    const a = (await service.call('session-a', 'terminal', 'create', {
      shell: '/bin/sh',
    })) as TerminalSnapshot;
    const b = (await service.call('session-b', 'terminal', 'create', {
      shell: '/bin/sh',
    })) as TerminalSnapshot;
    assert.equal(await service.hasActiveSession('session-a'), true);
    assert.equal(await service.hasActiveSessionResources('session-b'), true);
    await service.releaseSession('session-a');
    assert.equal(await service.hasActiveSession('session-a'), false);
    assert.throws(() => process.kill(a.pid!, 0));
    assert.doesNotThrow(() => process.kill(b.pid!, 0));
    assert.equal(await service.hasActiveSession('session-b'), true);
    await service.call('session-b', 'terminal', 'write', {
      id: b.id,
      data: 'echo B_STILL_OWNED\r',
    });
    await service.releaseSession('session-b');
    assert.throws(() => process.kill(b.pid!, 0));
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
test('blocked durable writer bounds 100000 incoming events and exposes one failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-stream-bound-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-stream-bound-data-'));
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const failures: Error[] = [];
  const service = new WorkspaceServices({
    workspaceRoot: root,
    workspaceId: 'bounded',
    terminalEnv: {
      HOME: root,
      ZDOTDIR: root,
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
    },
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    maxPendingEventBytes: 32768,
    eventStreamOptions: { beforeWrite: () => gate },
    emit: () => {},
    onPersistenceError: (error) => failures.push(error),
  });
  try {
    const terminal = (await service.call('session-a', 'terminal', 'create', {
      shell: '/bin/sh',
    })) as TerminalSnapshot;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 100000; i++)
      promises.push(
        service
          .publishSource({
            workspaceId: 'bounded',
            sessionId: 'session-a',
            service: 'tasks',
            resourceId: 'task-a',
            epoch: 'test',
            seq: i + 1,
            at: new Date().toISOString(),
            data: { text: 'x'.repeat(256) },
          })
          .catch(() => undefined),
      );
    assert.ok(service.eventHealth.pendingBytes <= 32768);
    assert.equal(failures.length, 1);
    assert.match(service.eventHealth.error!, /byte limit/);
    unblock();
    await Promise.all(promises);
    assert.equal(service.eventHealth.pendingBytes, 0);
    await service.releaseSession('session-a');
    assert.throws(() => process.kill(terminal.pid!, 0));
  } finally {
    unblock();
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test('initial event journal open failure still allows complete service disposal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-journal-open-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-journal-open-data-'));
  const hash = createHash('sha256').update(path.resolve(root)).digest('hex');
  await mkdir(path.join(data, 'workspaces', hash, 'events.jsonl'), {
    recursive: true,
  });
  const errors: Error[] = [];
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    terminalEnv: {
      HOME: root,
      ZDOTDIR: root,
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
    },
    emit: () => {},
    onPersistenceError: (error) => errors.push(error),
  });
  try {
    await assert.rejects(
      service.call('session-a', 'documents', 'refresh'),
      /EISDIR|directory/i,
    );
    assert.equal(errors.length, 1);
    await assert.doesNotReject(service.dispose());
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
test('document saves invalidate semantic projects without discarding another unsaved overlay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-language-save-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-language-save-data-'));
  await writeFile(path.join(root, 'a.ts'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'b.ts'), 'export const untouched = true;\n');
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    emit: () => {},
  });
  try {
    await service.call('s', 'language', 'open', {
      path: 'b.ts',
      content: 'export const untouched: string = 123;\n',
    });
    const before = (await service.call('s', 'language', 'request', {
      method: 'diagnostics',
      path: 'b.ts',
    })) as unknown[];
    assert.ok(before.length > 0);
    const doc = (await service.call('s', 'documents', 'read', {
      path: 'a.ts',
    })) as WorkspaceDocument;
    await service.call('s', 'documents', 'save', {
      path: 'a.ts',
      content: 'export const value = 2;\n',
      expectedRevision: doc.revision,
    });
    const after = (await service.call('s', 'language', 'request', {
      method: 'diagnostics',
      path: 'b.ts',
    })) as unknown[];
    assert.ok(after.length > 0);
    assert.equal(
      await readFile(path.join(root, 'b.ts'), 'utf8'),
      'export const untouched = true;\n',
    );
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
