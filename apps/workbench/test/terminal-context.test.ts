import assert from 'node:assert/strict';
import test from 'node:test';
import { PreviewRuntime } from '../src/model/state.ts';
import { LiveRuntime } from '../src/model/live.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type { RuntimeUpdate } from '../../desktop/src/runtime-protocol.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import { MAX_FILE_BYTES } from '../../desktop/src/policy.ts';
import type { TerminalReplay } from '../../desktop/src/workspace/terminal.ts';
import {
  appendTerminalSelection,
  MAX_TERMINAL_SELECTION_BYTES,
  type TerminalSelectionCapture,
} from '../src/model/terminal-context.ts';

function fixture() {
  const runtime = new PreviewRuntime({
    getItem: () => JSON.stringify(createFixtures()),
    setItem: () => {},
    removeItem: () => {},
  });
  const sessionId = runtime.getSnapshot().activeSessionId;
  runtime.updateSessionView(sessionId, {
    draft: 'unfinished draft 中文',
    attachments: [
      {
        id: 'existing',
        name: 'existing.txt',
        kind: 'file',
        content: 'keep me',
      },
    ],
  });
  const capture: TerminalSelectionCapture = {
    operationId: 'capture-1',
    sourceSessionId: sessionId,
    terminalId: 'pty-1',
    terminalEpoch: 'launch-1',
    outputSequence: 42,
    capturedAt: '2026-10-16T00:00:00.000Z',
    cols: 80,
    rows: 24,
    range: { start: { x: 0, y: 9 }, end: { x: 6, y: 12 } },
    text: 'line one 中文\nline two\n  exact spaces  ',
  };
  const page = {
    snapshot: {
      id: 'pty-1',
      sessionId,
      epoch: 'launch-1',
      owner: sessionId,
      label: 'zsh',
      cwd: '/owned/project',
      pid: 100,
      lastSequence: 44,
    },
    events: [],
    nextSequence: 42,
    hasMore: false,
  } as unknown as TerminalReplay;
  const current = () =>
    runtime.getSnapshot().sessions.find((s) => s.id === sessionId)!;
  return { runtime, capture, page, current };
}

test('terminal capture keeps complete text and existing draft, and uses authoritative source metadata', async () => {
  assert.equal(MAX_TERMINAL_SELECTION_BYTES, MAX_FILE_BYTES);
  const { runtime, capture, page, current } = fixture();
  await appendTerminalSelection(runtime, capture, async () => page);
  const attachment = current().attachments.at(-1)!;
  assert.equal(current().draft, 'unfinished draft 中文');
  assert.equal(current().attachments[0].id, 'existing');
  assert.equal(attachment.name, 'zsh · selection');
  assert.equal(attachment.kind, 'file');
  assert.equal(attachment.truncated, undefined);
  assert.ok(attachment.content.startsWith(capture.text));
  const metadata = JSON.parse(
    attachment.content.split('\n\n--- terminal capture source ---\n')[1],
  );
  assert.equal(metadata.terminalId, page.snapshot.id);
  assert.equal(metadata.sessionId, page.snapshot.sessionId);
  assert.equal(metadata.terminalEpoch, page.snapshot.epoch);
  assert.equal(metadata.processId, 100);
  assert.equal(metadata.outputSequence, 42);
  assert.equal(metadata.origin, 'user-selected capture');
  assert.match(metadata.textVerification, /not verified/);
  assert.deepEqual(metadata.capturedBufferRange.start, capture.range.start);
  assert.match(metadata.rangeMeaning, /not stable source-file lines/);
  assert.equal(attachment.size, Buffer.byteLength(attachment.content));
});

test('independent captures append against latest context and the same operation is idempotent', async () => {
  const { runtime, capture, page, current } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = appendTerminalSelection(runtime, capture, async () => {
    await gate;
    return page;
  });
  await appendTerminalSelection(
    runtime,
    { ...capture, operationId: 'capture-2' },
    async () => page,
  );
  runtime.updateSessionView(capture.sourceSessionId, {
    attachments: [
      ...current().attachments,
      {
        id: 'picked-during-replay',
        kind: 'file',
        name: 'picked.txt',
        content: 'also keep',
      },
    ],
  });
  release();
  await first;
  assert.deepEqual(
    current().attachments.map((item) => item.id),
    [
      'existing',
      'terminal-selection:capture-2',
      'picked-during-replay',
      'terminal-selection:capture-1',
    ],
  );
  await appendTerminalSelection(runtime, capture, async () => {
    throw Error('must not replay an already-added operation');
  });
  assert.equal(current().attachments.length, 4);
});

test('switching away and back while source validation is pending rejects stale capture without changing either draft', async () => {
  const { runtime, capture, page, current } = fixture();
  const other = runtime
    .getSnapshot()
    .sessions.find((s) => s.id !== capture.sourceSessionId)!;
  const otherBefore = structuredClone(other);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = appendTerminalSelection(runtime, capture, async () => {
    await gate;
    return page;
  });
  runtime.selectSession(other.id);
  runtime.selectSession(capture.sourceSessionId);
  release();
  await assert.rejects(pending, /expired/);
  assert.equal(current().attachments.length, 1);
  assert.equal(current().draft, 'unfinished draft 中文');
  const after = runtime.getSnapshot().sessions.find((s) => s.id === other.id)!;
  assert.deepEqual(after.attachments, otherBefore.attachments);
  assert.equal(after.draft, otherBefore.draft);
});

for (const mutation of ['id', 'sessionId', 'epoch', 'lastSequence'] as const)
  test(`terminal source mismatch ${mutation} leaves draft and context intact`, async () => {
    const { runtime, capture, page, current } = fixture();
    const changed = structuredClone(page);
    if (mutation === 'lastSequence') changed.snapshot.lastSequence = 41;
    else changed.snapshot[mutation] = 'another';
    await assert.rejects(
      appendTerminalSelection(runtime, capture, async () => changed),
      /source changed/,
    );
    assert.equal(current().attachments.length, 1);
    assert.equal(current().draft, 'unfinished draft 中文');
  });

test('over-limit UTF-8 selection and metadata overhead are rejected explicitly without truncating or appending', async () => {
  const { runtime, capture, page, current } = fixture();
  let calls = 0;
  const replay = async () => {
    calls++;
    return page;
  };
  await assert.rejects(
    appendTerminalSelection(
      runtime,
      { ...capture, text: '中'.repeat(1_333_334) },
      replay,
    ),
    /over 4 MB/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    appendTerminalSelection(
      runtime,
      { ...capture, text: 'x'.repeat(MAX_FILE_BYTES) },
      replay,
    ),
    /over 4 MB/,
  );
  assert.equal(calls, 1);
  assert.equal(current().attachments.length, 1);
});

test('same-operation retry persists an in-memory capture after storage recovers without duplication or losing bytes', async () => {
  const { capture, page } = fixture();
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const bridge = {
    onRuntime: () => () => {},
    runtimeState: async () => update,
  } as unknown as DesktopBridge;
  const saved = new Map<string, string>();
  let fail = false;
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail) throw Error('storage unavailable');
      saved.set(key, value);
    },
  };
  const runtime = new LiveRuntime(bridge, update, storage);
  runtime.updateSessionView(capture.sourceSessionId, {
    draft: 'keep draft',
    attachments: [],
  });
  fail = true;
  await assert.rejects(
    appendTerminalSelection(runtime, capture, async () => page),
    /could not be saved/,
  );
  const session = runtime
    .getSnapshot()
    .sessions.find((s) => s.id === capture.sourceSessionId)!;
  const exact = structuredClone(session.attachments);
  assert.equal(exact.length, 1);
  assert.ok(exact[0].content.startsWith(capture.text));
  // Even retrying while the operation is in memory must report persistence failure.
  await assert.rejects(
    appendTerminalSelection(runtime, capture, async () => page),
    /could not be saved/,
  );
  fail = false;
  await appendTerminalSelection(runtime, capture, async () => {
    throw Error('existing capture must not read or append again');
  });
  runtime.dispose();
  const reopened = new LiveRuntime(bridge, update, storage);
  assert.deepEqual(
    reopened
      .getSnapshot()
      .sessions.find((s) => s.id === capture.sourceSessionId)!.attachments,
    exact,
  );
  assert.equal(
    reopened
      .getSnapshot()
      .sessions.find((s) => s.id === capture.sourceSessionId)!.draft,
    'keep draft',
  );
  reopened.dispose();
});
