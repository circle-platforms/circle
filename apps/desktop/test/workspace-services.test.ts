import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
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
