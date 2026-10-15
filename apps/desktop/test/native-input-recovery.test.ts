import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { LiveRuntime } from '../../workbench/src/model/live.ts';
import { createFixtures } from '../../workbench/src/preview/fixtures.ts';
import type { DesktopBridge } from '../src/contracts.ts';
import { readNativeRecoverySession } from './helpers/native-input-recovery.mjs';

function fixture() {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const id = snapshot.sessions[0]!.id;
  snapshot.sessions[0]!.draft = '';
  snapshot.sessions[0]!.attachments = [];
  snapshot.sessions[0]!.state = 'waiting';
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  const host = {
    onRuntime: () => () => {},
  } as unknown as DesktopBridge;
  const initial = { seq: 1, connected: true, snapshot };
  const runtime = new LiveRuntime(host, initial, localStorage);
  const state = async () => structuredClone(snapshot);
  const page = {
    evaluate: async (callback: (...args: any[]) => unknown, arg: unknown) => {
      const context = vm.createContext({ localStorage, arg });
      // Match Playwright's cross-process value serialization, not shared objects.
      return JSON.parse(
        JSON.stringify(await vm.runInContext(`(${callback})(arg)`, context)),
      );
    },
  };
  return { id, runtime, host, initial, state, page, localStorage, storage };
}

test('native recovery reads real LiveRuntime persisted draft and image bytes rather than empty backend presentation fields', async () => {
  const f = fixture();
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
  try {
    assert.equal(
      f.runtime.updateSessionView(f.id, {
        draft: 'unsent actual renderer draft',
        attachments: [
          {
            id: 'image',
            name: 'pasted image 1.png',
            kind: 'image',
            content: png,
            mime: 'image/png',
            size: 67,
          },
        ],
      }),
      true,
    );
    const backend = (await f.state()).sessions.find(
      (item) => item.id === f.id,
    )!;
    assert.deepEqual(backend.attachments, []);
    assert.equal(backend.draft, '');
    const viewed = await readNativeRecoverySession(f.state, f.page, f.id);
    assert.equal(viewed.draft, 'unsent actual renderer draft');
    assert.equal(viewed.attachments[0].content, png);
    assert.equal(viewed.state, backend.state);
    assert.deepEqual(viewed.queue, backend.queue);
    f.runtime.dispose();
    const restored = new LiveRuntime(f.host, f.initial, f.localStorage);
    try {
      const session = restored
        .getSnapshot()
        .sessions.find((item) => item.id === f.id)!;
      assert.equal(session.draft, viewed.draft);
      assert.equal(session.attachments[0]!.content, png);
      assert.equal(
        (await readNativeRecoverySession(f.state, f.page, f.id)).attachments[0]
          .content,
        png,
      );
    } finally {
      restored.dispose();
    }
  } finally {
    f.runtime.dispose();
  }
});

test('native recovery cannot replace authoritative queue or select another session from renderer presentation storage', async () => {
  const f = fixture();
  try {
    f.storage.set(
      'circle.workbench.live.views.v1',
      JSON.stringify({
        views: [
          [
            f.id,
            {
              draft: 'owner draft',
              attachments: [],
              state: 'idle',
              queue: ['forged'],
            },
          ],
          [
            'another',
            { draft: 'foreign draft', attachments: [{ content: 'foreign' }] },
          ],
        ],
      }),
    );
    const viewed = await readNativeRecoverySession(f.state, f.page, f.id);
    assert.equal(viewed.draft, 'owner draft');
    assert.equal(viewed.state, 'waiting');
    assert.deepEqual(viewed.queue, (await f.state()).sessions[0]!.queue);
    assert.deepEqual(viewed.attachments, []);
    await assert.rejects(
      () => readNativeRecoverySession(f.state, f.page, 'another'),
      /unavailable/,
    );
    f.storage.set(
      'circle.workbench.live.views.v1',
      JSON.stringify({ views: [[f.id, { attachments: 'invalid' }]] }),
    );
    await assert.rejects(
      () => readNativeRecoverySession(f.state, f.page, f.id),
      /attachments are invalid/,
    );
  } finally {
    f.runtime.dispose();
  }
});
