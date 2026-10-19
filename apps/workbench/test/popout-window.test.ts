import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRuntime } from '../src/model/live.ts';
import {
  PreviewRuntime,
  STORAGE_KEY,
  currentSession,
} from '../src/model/state.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import { popoutTitle } from '../src/model/popouts.ts';
import {
  addDraftAttachment,
  screenshotAttachment,
} from '../src/model/draft-attachments.ts';
import {
  appendTerminalSelection,
  type TerminalSelectionCapture,
} from '../src/model/terminal-context.ts';
import { validPopoutTitle } from '../../desktop/src/popouts.ts';
import { validPopoutAttachment } from '../../desktop/src/popout-attachment.ts';
import type {
  BrowserCapture,
  DesktopBridge,
} from '../../desktop/src/contracts.ts';
import type { RuntimeUpdate } from '../../desktop/src/runtime-protocol.ts';
import type { TerminalReplay } from '../../desktop/src/workspace/terminal.ts';
import type { Attachment } from '../src/model/types.ts';

// A 1×1 PNG, as the browser's capture returns a picture of the page.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhJkAAAAASUVORK5CYII=';
const capture = {
  sessionId: 'browser:session1',
  url: 'https://app.example.test/status',
  title: 'status',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  dataUrl: PNG,
  sha256: 'hash',
  observedAt: new Date(2026, 9, 19, 12, 4).toISOString(),
  attempts: 1,
  retryErrors: [],
} as BrowserCapture;

/** The storage the windows share, as localStorage is: the main window writes it. */
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}
/** A main process that answers the window with the runtime's snapshot. */
function bridge(update: RuntimeUpdate) {
  let listener: ((update: RuntimeUpdate) => void) | undefined;
  return {
    update(snapshot: RuntimeUpdate['snapshot']) {
      update = { seq: update.seq + 1, connected: true, snapshot };
      listener?.(update);
    },
    async runtimeCommand(command: { id: string }) {
      return { id: command.id, ok: true };
    },
    async runtimeState() {
      return update;
    },
    onRuntime: (callback: (update: RuntimeUpdate) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as DesktopBridge & {
    update(snapshot: RuntimeUpdate['snapshot']): void;
  };
}
function live(store = storage()) {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const host = bridge(update);
  return { runtime: new LiveRuntime(host, update, store), host, store };
}

test('a window title is cut short to what the main process takes, never inside a character', () => {
  assert.equal(
    popoutTitle('browser', 'Fix the reconnect race'),
    'browser · Fix the reconnect race',
  );
  for (const title of [
    'long '.repeat(60).trim(),
    '中文标题'.repeat(80),
    '😀'.repeat(150),
    'x'.repeat(190) + ' ' + 'y'.repeat(30),
  ]) {
    const shown = popoutTitle('browser', title);
    assert.ok(shown.length <= 200, `${shown.length} characters`);
    assert.ok(shown.startsWith('browser · '));
    assert.ok(shown.endsWith('…'));
    assert.equal(validPopoutTitle(shown), shown);
    assert.doesNotMatch(shown, /[\ud800-\udbff](?![\udc00-\udfff])/);
  }
  // Exactly as long as a title may be is kept whole.
  const fits = 'x'.repeat(200 - 'terminal · '.length);
  assert.equal(popoutTitle('terminal', fits), 'terminal · ' + fits);
});

test('the main window keeps what a window of its own adds, in that conversation even when another is shown', async () => {
  const { runtime, host, store } = live();
  const snapshot = runtime.getSnapshot();
  const shown = snapshot.activeSessionId;
  const other = snapshot.sessions.find((session) => session.id !== shown)!;
  const before = structuredClone(currentSession(snapshot).attachments);
  const picture = screenshotAttachment(capture);
  assert.equal(addDraftAttachment(runtime, other.id, picture), true);
  // The same attachment again is saved again, not added twice.
  assert.equal(addDraftAttachment(runtime, other.id, picture), true);
  const after = runtime.getSnapshot();
  assert.deepEqual(currentSession(after).attachments, before);
  assert.deepEqual(
    after.sessions.find((session) => session.id === other.id)!.attachments,
    [picture],
  );
  // Kept with that conversation's draft, so it is there after a restart,
  const reopened = new LiveRuntime(
    bridge({ seq: 0, connected: true, snapshot: structuredClone(snapshot) }),
    { seq: 0, connected: true, snapshot: structuredClone(snapshot) },
    store,
  );
  assert.deepEqual(
    reopened.getSnapshot().sessions.find((session) => session.id === other.id)!
      .attachments,
    [picture],
  );
  reopened.dispose();
  // and in its message box when the person goes there.
  host.update({ ...structuredClone(snapshot), activeSessionId: other.id });
  assert.deepEqual(currentSession(runtime.getSnapshot()).attachments, [
    picture,
  ]);
  // A conversation that is gone has no message box.
  assert.throws(
    () => addDraftAttachment(runtime, 'no-such-session', picture),
    /this conversation is gone/,
  );
  runtime.dispose();
});

test('a page screenshot is what the main process passes on from a browser window', () => {
  const picture = screenshotAttachment(capture);
  assert.equal(picture.name, 'app.example.test 12:04.png');
  assert.equal(
    picture.size,
    Buffer.from(PNG.split(',')[1]!, 'base64').length,
    'its bytes, as they decode',
  );
  assert.deepEqual(
    validPopoutAttachment('browser', picture),
    picture as unknown as ReturnType<typeof validPopoutAttachment>,
  );
});

test('a terminal selection in a window of its own goes to the main window, not into its own copy', async () => {
  const preview = new PreviewRuntime(storage());
  const sessionId = preview.getSnapshot().activeSessionId;
  const own = structuredClone(
    preview.getSnapshot().sessions.find((session) => session.id === sessionId)!
      .attachments,
  );
  const capture: TerminalSelectionCapture = {
    operationId: 'capture-1',
    sourceSessionId: sessionId,
    terminalId: 'pty-1',
    terminalEpoch: 'launch-1',
    outputSequence: 3,
    capturedAt: '2026-10-19T00:00:00.000Z',
    cols: 80,
    rows: 24,
    range: { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
    text: 'CIRCLE_SELECTED 中文',
  };
  const replay = async () =>
    ({
      snapshot: {
        id: 'pty-1',
        sessionId,
        epoch: 'launch-1',
        owner: sessionId,
        label: 'zsh',
        cwd: '/synthetic',
        lastSequence: 3,
      },
      events: [],
      nextSequence: 3,
      hasMore: false,
    }) as unknown as TerminalReplay;
  const sent: [string, Attachment][] = [];
  await appendTerminalSelection(preview, capture, replay, async (id, item) => {
    sent.push([id, item]);
    return true;
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![0], sessionId);
  assert.equal(sent[0]![1].id, 'terminal-selection:capture-1');
  assert.ok(sent[0]![1].content.startsWith(capture.text));
  // What the main process passes on from a terminal window.
  assert.deepEqual(
    validPopoutAttachment('terminal', sent[0]![1]),
    sent[0]![1] as unknown as ReturnType<typeof validPopoutAttachment>,
  );
  assert.deepEqual(
    preview.getSnapshot().sessions.find((session) => session.id === sessionId)!
      .attachments,
    own,
    "the window's own copy is unchanged",
  );
  // The main window had it but could not save it, or could not take it: said here.
  await assert.rejects(
    appendTerminalSelection(
      preview,
      { ...capture, operationId: 'capture-2' },
      replay,
      async () => false,
    ),
    /could not be saved/,
  );
  await assert.rejects(
    appendTerminalSelection(
      preview,
      { ...capture, operationId: 'capture-3' },
      replay,
      async () => {
        throw Error('the main window did not answer');
      },
    ),
    /did not answer/,
  );
});

test("a window of its own follows the main window's text size and, in the preview, its theme", () => {
  // Live: the text size is the window's own setting, which the main window stores.
  const shared = storage();
  const main = live(shared);
  const follower = live({ ...shared, setItem: () => {}, removeItem: () => {} });
  let told = 0;
  follower.runtime.subscribe(() => told++);
  main.runtime.change((state) => {
    state.settings.textSize = 'larger';
  });
  assert.notEqual(follower.runtime.getSnapshot().settings.textSize, 'larger');
  follower.runtime.storageChanged?.('another.key');
  assert.equal(told, 0);
  follower.runtime.storageChanged?.('circle.workbench.live.views.v1');
  assert.equal(follower.runtime.getSnapshot().settings.textSize, 'larger');
  assert.equal(told, 1);
  // Nothing new, nothing told.
  follower.runtime.storageChanged?.(null);
  assert.equal(told, 1);
  main.runtime.dispose();
  follower.runtime.dispose();

  // The preview keeps all of its settings in the storage.
  const previewStorage = storage();
  const previewMain = new PreviewRuntime(previewStorage);
  previewMain.change((state) => {
    state.settings.theme = 'light';
  });
  const previewFollower = new PreviewRuntime({
    ...previewStorage,
    setItem: () => {},
    removeItem: () => {},
  });
  previewMain.change((state) => {
    state.settings.theme = 'dark';
    state.settings.textSize = 'large';
  });
  assert.equal(previewFollower.getSnapshot().settings.theme, 'light');
  previewFollower.storageChanged?.(STORAGE_KEY);
  assert.equal(previewFollower.getSnapshot().settings.theme, 'dark');
  assert.equal(previewFollower.getSnapshot().settings.textSize, 'large');
});
