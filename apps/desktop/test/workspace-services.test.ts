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
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GitWorkspaceService } from '../src/workspace/git.ts';
import { WorkspaceServices } from '../src/workspace/workspace-services.ts';
import { WorkspaceEventStream } from '../src/workspace/event-stream.ts';
import type { WorkspaceDocument } from '../src/workspace/documents.ts';
import type {
  TerminalSnapshot,
  TerminalReplay,
} from '../src/workspace/terminal.ts';
import type { WorkspaceServiceEvent } from '../src/workspace-protocol.ts';
const interactiveShell =
  process.platform === 'win32' ? { args: ['/d', '/q'] } : { shell: '/bin/sh' };

test('workspace routing preserves revisions, isolates terminal owners and persists before delivery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-services-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-services-data-'));
  const events: WorkspaceServiceEvent[] = [];
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    runtimeExecutable: process.execPath,
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
      ...interactiveShell,
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
    runtimeExecutable: process.execPath,
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
      ...interactiveShell,
    })) as TerminalSnapshot;
    const b = (await service.call('session-b', 'terminal', 'create', {
      ...interactiveShell,
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
    runtimeExecutable: process.execPath,
    ghPath: 'unused',
    maxPendingEventBytes: 32768,
    eventStreamOptions: { beforeWrite: () => gate },
    emit: () => {},
    onPersistenceError: (error) => failures.push(error),
  });
  try {
    const terminal = (await service.call('session-a', 'terminal', 'create', {
      ...interactiveShell,
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
  const blockedJournal = path.join(data, 'workspaces', hash, 'events.jsonl');
  await mkdir(blockedJournal, { recursive: true });
  assert.equal((await stat(blockedJournal)).isDirectory(), true);
  const errors: Error[] = [];
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    runtimeExecutable: process.execPath,
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
    const rejection = await service
      .call('session-a', 'documents', 'refresh')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const actualFolders = await readdir(path.join(data, 'workspaces'));
    assert.ok(
      rejection,
      JSON.stringify({
        message: 'directory journal must reject opening',
        root,
        expectedHash: hash,
        actualFolders,
        blockedJournal,
        stillDirectory: (await stat(blockedJournal)).isDirectory(),
        eventHealth: service.eventHealth,
      }),
    );
    assert.match(String(rejection), /EISDIR|directory/i);
    assert.equal(errors.length, 1);
    await assert.doesNotReject(service.dispose());
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
test('a workspace that ran automatic delivery in an earlier version opens, replays its old events and keeps its files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-legacy-delivery-'));
  const data = await mkdtemp(
    path.join(tmpdir(), 'circle-legacy-delivery-data-'),
  );
  const directory = path.join(
    data,
    'workspaces',
    createHash('sha256').update(path.resolve(root)).digest('hex'),
  );
  // What automatic delivery left behind: its cycle ledger and a journal event.
  const ledger = path.join(
    directory,
    'delivery',
    createHash('sha256').update('session-a').digest('hex'),
    'delivery-cycles.json',
  );
  await mkdir(path.dirname(ledger), { recursive: true });
  const saved = JSON.stringify({ version: 1, cycles: [], operations: [] });
  await writeFile(ledger, saved);
  const journal = await WorkspaceEventStream.open(
    path.join(directory, 'events.jsonl'),
  );
  await journal.append({
    workspaceId: 'legacy',
    sessionId: 'session-a',
    service: 'cycles' as never,
    resourceId: 'cycle-one',
    data: { kind: 'cycle', id: 'cycle-one', state: 'waiting_ci', attempt: 1 },
  });
  await journal.close();
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    runtimeExecutable: process.execPath,
    ghPath: 'unused',
    emit: () => {},
  });
  try {
    await writeFile(path.join(root, 'notes.txt'), 'before\n');
    const read = (await service.call('session-a', 'documents', 'read', {
      path: 'notes.txt',
    })) as WorkspaceDocument;
    await service.call('session-a', 'documents', 'save', {
      path: 'notes.txt',
      content: 'after\n',
      expectedRevision: read.revision,
    });
    const page = await service.replay();
    assert.deepEqual(
      [
        page.events[0]?.seq,
        page.events[0]?.service,
        page.events[0]?.resourceId,
      ],
      [1, 'cycles', 'cycle-one'],
    );
    assert.ok(
      page.events.some(
        (event) => event.service === 'documents' && event.data.kind === 'save',
      ),
    );
    assert.deepEqual(
      page.events.map((event) => event.seq),
      page.events.map((_, index) => index + 1),
    );
    assert.equal(service.eventHealth.error, undefined);
  } finally {
    await service.dispose();
  }
  assert.equal(await readFile(ledger, 'utf8'), saved);
  await rm(root, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});
test('concurrent disposal shares completion and late sources are not reported as disk failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-service-close-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-service-close-data-'));
  const failures: Error[] = [];
  const service = new WorkspaceServices({
    workspaceRoot: root,
    workspaceId: 'owned-close',
    dataDir: data,
    runtimeExecutable: process.execPath,
    ghPath: 'unused',
    terminalEnv: {
      HOME: root,
      ZDOTDIR: root,
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
    },
    emit: () => {},
    onPersistenceError: (error) => failures.push(error),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = service.terminals.dispose.bind(service.terminals);
  service.terminals.dispose = async () => {
    await gate;
    await original();
  };
  try {
    const terminal = (await service.call('s', 'terminal', 'create', {
      ...interactiveShell,
    })) as TerminalSnapshot;
    await service.replay();
    let done = false;
    const first = service.dispose().then(() => {
      done = true;
    });
    let secondDone = false;
    const second = service.dispose().then(() => {
      secondDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(done, false);
    assert.equal(secondDone, false);
    release();
    await Promise.all([first, second]);
    assert.equal(done, true);
    assert.equal(secondDone, true);
    assert.throws(() => process.kill(terminal.pid!, 0));
    const journal = await readFile(
      path.join(
        data,
        'workspaces',
        createHash('sha256').update(path.resolve(root)).digest('hex'),
        'events.jsonl',
      ),
      'utf8',
    );
    assert.ok(
      journal
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .some(
          (event) =>
            event.service === 'terminal' &&
            event.resourceId === terminal.id &&
            event.data.kind === 'exit',
        ),
    );
    await assert.rejects(
      service.publishSource({
        workspaceId: 'owned-close',
        sessionId: 's',
        service: 'tasks',
        resourceId: 'late',
        epoch: 'late',
        seq: 1,
        at: new Date().toISOString(),
        data: { kind: 'late' },
      }),
      { code: 'WORKSPACE_SERVICES_CLOSED' },
    );
    assert.equal(failures.length, 0);
    assert.equal(service.eventHealth.error, undefined);
    const reopened = new WorkspaceServices({
      workspaceRoot: root,
      workspaceId: 'owned-close',
      dataDir: data,
      runtimeExecutable: process.execPath,
      ghPath: 'unused',
      emit: () => {},
    });
    await reopened.replay();
    await reopened.dispose();
  } finally {
    release();
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test('Git canonicalizes granted repository aliases without granting its parent to a child workspace', async () => {
  const container = await mkdtemp(
    path.join(tmpdir(), 'circle-git-root-grant-'),
  );
  const root = path.join(container, 'repo');
  const alias = path.join(container, 'repo-alias');
  const child = path.join(root, 'child');
  await mkdir(child, { recursive: true });
  const git = new GitWorkspaceService(root);
  await git.git(['init']);
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const base = {
    dataDir: path.join(container, 'data'),
    runtimeExecutable: process.execPath,
    ghPath: 'unused',
    emit: () => {},
  };
  const granted = new WorkspaceServices({ ...base, workspaceRoot: root });
  const aliased = new WorkspaceServices({ ...base, workspaceRoot: alias });
  const nested = new WorkspaceServices({ ...base, workspaceRoot: child });
  try {
    const ordinary = (await granted.call('s', 'git', 'status')) as {
      root: string;
    };
    assert.equal(await realpath(ordinary.root), await realpath(root));
    const viaAlias = (await aliased.call('s', 'git', 'status')) as {
      root: string;
    };
    assert.equal(await realpath(viaAlias.root), await realpath(root));
    await assert.rejects(
      nested.call('s', 'git', 'status'),
      /open the repository root to grant Git workspace access/,
    );
  } finally {
    await Promise.all([granted.dispose(), aliased.dispose(), nested.dispose()]);
    await rm(container, { recursive: true, force: true });
  }
});
