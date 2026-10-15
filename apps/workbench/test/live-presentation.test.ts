import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type { RuntimeUpdate } from '../../desktop/src/runtime-protocol.ts';
import type { SessionViewPatch } from '../src/model/types.ts';
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
      presentation: { planCollapsed: true },
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
        .planCollapsed,
      true,
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
