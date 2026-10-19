import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type { RuntimeUpdate } from '../../desktop/src/runtime-protocol.ts';
import type { SessionViewPatch } from '../src/model/types.ts';
import { branchMessages, visibleMessages } from '../src/model/state.ts';
import {
  saveSessionScroll,
  sessionScrollAnchor,
} from '../src/model/presentation.ts';
function fixture() {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  snapshot.sessions[0].messages = Array.from({ length: 10000 }, (_, n) => ({
    id: `history-${n}`,
    parentId: null,
    role: 'user' as const,
    text: `history ${n}`,
    at: 'fixture',
  }));
  const saved = new Map<string, string>();
  let receive!: (update: RuntimeUpdate) => void;
  let seq = 1;
  const host = {
    onRuntime: (callback: typeof receive) => {
      receive = callback;
      return () => {};
    },
    runtimeState: async () => ({ seq, connected: true, snapshot }),
    runtimeCommand: async (command: { id: string }) => ({
      id: command.id,
      ok: true,
    }),
  } as unknown as DesktopBridge;
  const runtime = new LiveRuntime(
    host,
    { seq, connected: true, snapshot },
    {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value);
      },
    },
  );
  return {
    runtime,
    saved,
    update: () => receive({ seq: ++seq, connected: true, snapshot }),
  };
}
test('ten thousand historical messages retain identity across draft and scroll updates', () => {
  const { runtime } = fixture();
  try {
    const initial = runtime.getSnapshot();
    const id = initial.sessions[0].id;
    const history = initial.sessions[0].messages,
      other = initial.sessions[1];
    for (let n = 0; n < 100; n++) {
      assert.equal(
        runtime.updateSessionView(id, {
          draft: `typing ${n}`,
          presentation: { scroll: { top: n, follow: false } },
        }),
        true,
      );
      const current = runtime.getSnapshot();
      assert.equal(current.sessions[0].messages, history);
      assert.equal(current.sessions[0].messages[9999], history[9999]);
      assert.equal(current.sessions[1], other);
      assert.equal(current.workspaces, initial.workspaces);
    }
    assert.equal(
      initial.sessions[0].draft,
      '',
      'prior snapshot stays immutable',
    );
    assert.equal(runtime.getSnapshot().sessions[0].draft, 'typing 99');
  } finally {
    runtime.dispose();
  }
});
test('session UI is isolated, survives full updates and rejects secret/core fields before persistence', () => {
  const { runtime, saved, update } = fixture();
  try {
    const [a, b] = runtime.getSnapshot().sessions;
    runtime.updateSessionView(a.id, { draft: 'draft A', showThinking: false });
    runtime.updateSessionView(b.id, {
      draft: 'draft B',
      presentation: { toolTabs: { 'b-tool': 'output' } },
    });
    assert.throws(
      () =>
        runtime.updateSessionView(a.id, {
          apiKey: 'DO_NOT_STORE_SECRET',
        } as unknown as SessionViewPatch),
      /native session/,
    );
    assert.throws(
      () =>
        runtime.updateSessionView(a.id, {
          messages: [],
        } as unknown as SessionViewPatch),
      /native session/,
    );
    assert.equal(
      [...saved.values()].some((text) => text.includes('DO_NOT_STORE_SECRET')),
      false,
    );
    update();
    assert.equal(
      runtime.getSnapshot().sessions.find((s) => s.id === a.id)!.draft,
      'draft A',
    );
    assert.equal(
      runtime.getSnapshot().sessions.find((s) => s.id === b.id)!.draft,
      'draft B',
    );
    assert.equal(
      runtime.getSnapshot().sessions.find((s) => s.id === b.id)!.presentation!
        .toolTabs?.['b-tool'],
      'output',
    );
    assert.equal(
      runtime.updateSessionView('removed-session', {
        draft: 'must not revive',
      }),
      false,
    );
    assert.equal(
      runtime.getSnapshot().sessions.some((s) => s.id === 'removed-session'),
      false,
    );
  } finally {
    runtime.dispose();
  }
});

test('ten thousand message branch projection keeps ordering, hidden rows and source references', () => {
  const { runtime } = fixture();
  try {
    const session = runtime.getSnapshot().sessions[0];
    session.messages = session.messages.map((message, n) => ({
      ...message,
      parentId: n ? session.messages[n - 1].id : null,
    }));
    session.leafId = session.messages.at(-1)!.id;
    const branch = branchMessages(session);
    assert.equal(branch.length, 10000);
    assert.equal(branch[0], session.messages[0]);
    assert.equal(branch.at(-1), session.messages.at(-1));
    session.branchIds = session.messages.map((message) => message.id);
    session.hiddenIds = ['history-0', 'history-9999'];
    const visible = visibleMessages(session);
    assert.equal(visible.length, 9998);
    assert.equal(visible[0], session.messages[1]);
    assert.equal(visible.at(-1), session.messages[9998]);
  } finally {
    runtime.dispose();
  }
});

test('failed local view persistence reports false while retaining recoverable memory and retries identical patches', () => {
  const snapshot = createFixtures();
  const saved = new Map<string, string>();
  let fails = true;
  const host = { onRuntime: () => () => {} } as unknown as DesktopBridge;
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fails) throw Error('QuotaExceededError');
      saved.set(key, value);
    },
  };
  const initial = { seq: 1, connected: true, snapshot };
  const runtime = new LiveRuntime(host, initial, storage);
  const id = snapshot.sessions[0].id;
  const patch = { draft: 'complete recovered text' };
  assert.equal(runtime.updateSessionView(id, patch), false);
  assert.equal(runtime.getSnapshot().sessions[0].draft, patch.draft);
  assert.equal(saved.size, 0);
  fails = false;
  assert.equal(runtime.updateSessionView(id, patch), true);
  assert.equal(saved.size, 1);
  runtime.dispose();
  const restored = new LiveRuntime(host, initial, storage);
  assert.equal(restored.getSnapshot().sessions[0].draft, patch.draft);
  restored.dispose();
});

test('reading identity updates persist even at the same pixel position and stay with the original session', () => {
  const { runtime, saved, update } = fixture();
  try {
    const [owner, other] = runtime.getSnapshot().sessions;
    const history = owner.messages;
    const initial = {
      top: 120,
      follow: false,
      anchor: { messageId: 'history-4', offset: -12.75 },
    };
    saveSessionScroll(runtime, owner.id, undefined, initial);
    const changed = {
      ...initial,
      anchor: { messageId: 'history-5', offset: -6.25 },
    };
    saveSessionScroll(runtime, owner.id, undefined, changed);
    assert.equal(
      runtime.getSnapshot().sessions.find((session) => session.id === owner.id)
        ?.messages,
      history,
      'local reading updates retain the native history identity',
    );
    update();
    assert.deepEqual(
      runtime.getSnapshot().sessions.find((session) => session.id === owner.id)
        ?.presentation?.scroll,
      changed,
    );
    assert.deepEqual(
      runtime.getSnapshot().sessions.find((session) => session.id === other.id)
        ?.presentation?.scroll,
      other.presentation?.scroll,
    );
    assert.deepEqual(
      runtime.getSnapshot().sessions.find((session) => session.id === owner.id)
        ?.messages,
      history,
      'the following authoritative snapshot retains all actual message content',
    );
    assert.ok([...saved.values()].some((text) => text.includes('history-5')));
    assert.ok([...saved.values()].every((text) => !text.includes('history-4')));
    saveSessionScroll(runtime, 'removed-owner', undefined, initial);
    assert.equal(
      runtime
        .getSnapshot()
        .sessions.some((session) => session.id === 'removed-owner'),
      false,
    );
  } finally {
    runtime.dispose();
  }
});

test('legacy and invalid optional reading anchors fall back without replacing the old pixel view', () => {
  for (const value of [
    undefined,
    null,
    {},
    { messageId: '', offset: 0 },
    { messageId: 'history-4', offset: null },
    { messageId: 'history-4', offset: Infinity },
    { messageId: 'history-4', offset: '12' },
  ])
    assert.equal(sessionScrollAnchor(value), undefined);
  assert.deepEqual(
    sessionScrollAnchor({ messageId: 'history-4', offset: -12.75 }),
    { messageId: 'history-4', offset: -12.75 },
  );
  const { runtime } = fixture();
  try {
    const owner = runtime.getSnapshot().sessions[0];
    saveSessionScroll(runtime, owner.id, undefined, {
      top: 120,
      follow: false,
    });
    assert.deepEqual(runtime.getSnapshot().sessions[0].presentation?.scroll, {
      top: 120,
      follow: false,
    });
  } finally {
    runtime.dispose();
  }
});
