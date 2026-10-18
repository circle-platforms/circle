import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import type { RuntimeCommandName } from '../src/runtime-protocol.ts';
import type { FileRewindPreview } from '../../../src/file_rewind.ts';

for (const externalConflict of [false, true])
  test(`native file undo binds stored turn and ${externalConflict ? 'rejects external changes' : 'restores only files'}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'circle-native-undo-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(home);
    await mkdir(workspace);
    await writeFile(join(workspace, 'a.txt'), '\uFEFFdirty before\r\n');
    saveSettings(trustFolder(defaultSettings(), workspace), home);
    const model = new ScriptedModel(
      [
        {
          id: randomUUID(),
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: randomUUID(),
              name: 'read_file',
              args: { file_path: 'a.txt' },
            },
          ],
        },
        {
          id: randomUUID(),
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: randomUUID(),
              name: 'edit_file',
              args: {
                file_path: 'a.txt',
                old_string: 'before',
                new_string: 'after',
              },
            },
          ],
        },
        { id: randomUUID(), role: 'assistant' as const, content: 'done' },
      ].map((message) => ({
        message: { ...message, role: 'assistant' as const },
      })),
    );
    let wake: (() => void) | undefined;
    const controller = new RuntimeController({
      home,
      workspace,
      userHome: home,
      model,
      emit: () => wake?.(),
    });
    t.after(async () => {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    });
    const call = (
      name: RuntimeCommandName,
      payload: Record<string, unknown> = {},
    ) =>
      controller.dispatch({
        id: randomUUID(),
        name,
        payload,
        sessionId: controller.snapshot().activeSessionId,
      });
    assert.equal((await call('set-auto', { enabled: true })).ok, true);
    assert.equal((await call('prompt', { text: 'edit a' })).ok, true);
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () =>
          reject(
            Error(
              'runtime failed to complete: ' +
                JSON.stringify(
                  controller.snapshot().sessions.map((s) => ({
                    messages: s.messages,
                    turn: s.turn,
                    fileUndoTurns: s.fileUndoTurns,
                  })),
                ) +
                ' interactions ' +
                JSON.stringify(controller.snapshot().interactions),
            ),
          ),
        8000,
      );
      const check = () => {
        const s = controller.snapshot();
        if (
          s.sessions.find((row) => row.id === s.activeSessionId)?.fileUndoTurns
            ?.length &&
          s.sessions.find((row) => row.id === s.activeSessionId)?.state ===
            'idle'
        ) {
          clearTimeout(deadline);
          wake = undefined;
          resolve();
        }
      };
      wake = check;
      check();
    });
    const snapshot = controller.snapshot();
    const session = snapshot.sessions.find(
      (s) => s.id === snapshot.activeSessionId,
    )!;
    const user = session.messages.find((m) => m.role === 'user')!;
    assert.deepEqual(session.fileUndoTurns, [user.id]);
    const preview = await call('preview-file-undo', { turnId: user.id });
    assert.equal(preview.ok, true, preview.error);
    const receipt = preview.data as FileRewindPreview;
    assert.equal(receipt.paths.length, 1);
    if (externalConflict) {
      await writeFile(join(workspace, 'a.txt'), 'external');
      const conflict = await call('restore-turn-files', {
        previewId: receipt.id,
      });
      assert.equal(conflict.ok, false);
      assert.match(conflict.error!, /no files restored/);
      assert.equal(
        await readFile(join(workspace, 'a.txt'), 'utf8'),
        'external',
      );
    } else {
      assert.equal((await call('set-plan-mode', { enabled: true })).ok, true);
      const readOnly = await call('restore-turn-files', {
        previewId: receipt.id,
      });
      assert.equal(readOnly.ok, false);
      assert.match(readOnly.error!, /leave plan mode/);
      assert.equal(
        await readFile(join(workspace, 'a.txt'), 'utf8'),
        '\uFEFFdirty after\r\n',
      );
      assert.equal((await call('set-plan-mode', { enabled: false })).ok, true);
      assert.equal((await call('new-session')).ok, true);
      const stale = await controller.dispatch({
        id: randomUUID(),
        name: 'restore-turn-files',
        payload: { previewId: receipt.id },
        sessionId: session.id,
      });
      assert.equal(stale.ok, false);
      assert.match(stale.error!, /session changed/);
      const otherOwner = await call('restore-turn-files', {
        previewId: receipt.id,
      });
      assert.equal(otherOwner.ok, false);
      assert.match(otherOwner.error!, /preview expired/);
      assert.equal((await call('select-session', { id: session.id })).ok, true);
      const restored = await call('restore-turn-files', {
        previewId: receipt.id,
      });
      assert.equal(restored.ok, true, restored.error);
      assert.equal(
        await readFile(join(workspace, 'a.txt'), 'utf8'),
        '\uFEFFdirty before\r\n',
      );
      assert.equal(
        controller
          .snapshot()
          .sessions.find((s) => s.id === session.id)!
          .messages.filter((m) => m.role === 'user').length,
        1,
      );
      assert.equal(
        (await call('restore-turn-files', { previewId: receipt.id })).ok,
        false,
      );
    }
  });
