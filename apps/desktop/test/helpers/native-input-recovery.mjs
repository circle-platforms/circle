import { finishNativePasteCleanup } from './native-paste-cleanup.mjs';
import {
  preserveNativeClipboard,
  restoreNativeClipboard,
} from './native-clipboard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Native execution state and renderer-owned persisted drafts have different owners. */
export async function readNativeRecoverySession(state, page, sessionId) {
  const session = (await state()).sessions.find(
    (item) => item.id === sessionId,
  );
  assert(session, 'recovery conversation is unavailable');
  const view = await page.evaluate((id) => {
    const saved = JSON.parse(
      localStorage.getItem('circle.workbench.live.views.v1') ?? '{}',
    );
    const entry = saved.views?.find(([sessionId]) => sessionId === id)?.[1];
    if (!entry) return {};
    if ('draft' in entry && typeof entry.draft !== 'string')
      throw Error('persisted recovery draft is invalid');
    if ('attachments' in entry && !Array.isArray(entry.attachments))
      throw Error('persisted recovery attachments are invalid');
    return {
      ...('draft' in entry ? { draft: entry.draft } : {}),
      ...('attachments' in entry ? { attachments: entry.attachments } : {}),
    };
  }, sessionId);
  return { ...session, ...view };
}

export async function runNativeInputRecovery({
  getApp,
  getPage,
  relaunch,
  state,
  query,
  sessionId,
  fixture,
  requestsPath,
  output,
  until,
}) {
  let page = getPage();
  const longText = Array.from(
    { length: 600 },
    (_, i) =>
      `OUTBOX_LINE_${String(i + 1).padStart(4, '0')} original developer input`,
  ).join('\n');
  const requests = async () => {
    try {
      return (await readFile(requestsPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const current = () => readNativeRecoverySession(state, page, sessionId);
  const composer = () =>
    page.getByRole('textbox', { name: 'message', exact: true });
  let pasteAttempt = 0;
  const pasteImage = async () => {
    pasteAttempt++;
    const observations = { attempt: pasteAttempt };
    const app = getApp();
    const clipboardKey = await preserveNativeClipboard(app);
    let primaryError;
    try {
      const previous = (await current()).attachments;
      const before = previous.length;
      const previousIds = new Set(previous.map((item) => item.id));
      observations.native = await app.evaluate(
        async ({ clipboard, ClipboardItem, nativeImage }) => {
          const png = nativeImage
            .createFromBitmap(Buffer.from([10, 20, 30, 255]), {
              width: 1,
              height: 1,
            })
            .toPNG();
          await clipboard.write([
            new ClipboardItem({
              'image/png': new Blob([png], { type: 'image/png' }),
            }),
          ]);
          return {
            types: (await clipboard.read()).flatMap((item) => item.types),
            pngPresent: await clipboard.has('image/png'),
          };
        },
      );
      assert.equal(
        observations.native.pngPresent,
        true,
        'native PNG is available',
      );
      await page.evaluate(() => {
        const events = [];
        const beforeInputEvents = [];
        const keyEvents = [];
        const keyListener = (event) => {
          const observation = {
            at: Date.now(),
            key: event.key,
            code: event.code,
            keyCode: event.keyCode,
            isComposing: event.isComposing,
            meta: event.metaKey,
            ctrl: event.ctrlKey,
            alt: event.altKey,
            shift: event.shiftKey,
            repeat: event.repeat,
            modifiers: Object.fromEntries(
              ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'AltGraph'].map(
                (name) => [name, event.getModifierState(name)],
              ),
            ),
            target: event.target?.getAttribute('aria-label'),
            capturePrevented: event.defaultPrevented,
          };
          keyEvents.push(observation);
          // A capture-listener microtask can run before the window bubble handler.
          setTimeout(() => {
            observation.finalPrevented = event.defaultPrevented;
            observation.finalAt = Date.now();
          }, 0);
        };
        window.addEventListener('keydown', keyListener, true);
        const beforeInputListener = (event) => {
          const observation = {
            inputType: event.inputType,
            trusted: event.isTrusted,
            prevented: event.defaultPrevented,
          };
          beforeInputEvents.push(observation);
          setTimeout(() => {
            observation.prevented = event.defaultPrevented;
          }, 0);
        };
        document.addEventListener('beforeinput', beforeInputListener, true);
        const listener = (event) =>
          events.push({
            trusted: event.isTrusted,
            types: [...event.clipboardData.types],
            items: [...event.clipboardData.items].map((item) => ({
              kind: item.kind,
              type: item.type,
            })),
            files: [...event.clipboardData.files].map((file) => ({
              type: file.type,
              size: file.size,
            })),
            target: event.target?.getAttribute('aria-label'),
            documentFocused: document.hasFocus(),
          });
        document.addEventListener('paste', listener, true);
        window.__circlePasteObservation = {
          events,
          keyEvents,
          beforeInputEvents,
          cleanup: () => {
            window.removeEventListener('keydown', keyListener, true);
            document.removeEventListener('paste', listener, true);
            document.removeEventListener(
              'beforeinput',
              beforeInputListener,
              true,
            );
          },
        };
      });
      await app.evaluate(({ app, BrowserWindow }) => {
        app.focus({ steal: true });
        BrowserWindow.getAllWindows()
          .find((window) => !window.isDestroyed())
          ?.focus();
      });
      await composer().click();
      observations.focus = await composer().evaluate((node) => ({
        documentFocused: document.hasFocus(),
        inputFocused: document.activeElement === node,
      }));
      const pasteShortcut =
        process.platform === 'darwin' ? 'Meta+v' : 'Control+v';
      observations.pasteMethod = `native keyboard ${pasteShortcut}`;
      await page.keyboard.press(pasteShortcut);
      await until(
        async () => (await current()).attachments.length > before,
        'real native valid PNG paste received',
      );
      const session = await current();
      const pasted = session.attachments.find(
        (item) => item.kind === 'image' && !previousIds.has(item.id),
      );
      assert.match(pasted?.content ?? '', /^data:image\/png;base64,/);
      const bytes = Buffer.from(pasted.content.split(',')[1], 'base64');
      assert.deepEqual(
        [...bytes.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
      await page
        .locator('.composer .attachment-strip')
        .getByText(pasted.name, { exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() =>
          window.__circlePasteObservation.events.some(
            (event) =>
              event.trusted &&
              event.target === 'message' &&
              event.files.some((file) => file.type === 'image/png'),
          ),
        ),
        true,
        'the visible PNG came from an actual trusted native paste',
      );
      observations.received = {
        persistedAttachments: session.attachments.length,
        backendAttachments: (await state()).sessions.find(
          (item) => item.id === sessionId,
        )?.attachments.length,
        pngBytes: bytes.length,
        visibleChip: true,
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishNativePasteCleanup({
        primaryError,
        observe: async () => {
          observations.events = await page.evaluate(() => {
            const observer = window.__circlePasteObservation;
            observer?.cleanup();
            delete window.__circlePasteObservation;
            return {
              paste: observer?.events ?? [],
              beforeinput: observer?.beforeInputEvents ?? [],
              keys: observer?.keyEvents ?? [],
            };
          });
        },
        writeEvidence: () =>
          writeFile(
            join(output, `outbox-paste-${pasteAttempt}-observations.json`),
            JSON.stringify(observations, null, 2),
          ),
        restore: () => restoreNativeClipboard(app, clipboardKey),
      });
    }
  };
  await page
    .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
    .first()
    .click();
  assert.equal(
    (await current()).state,
    'waiting',
    'recovery setup requires the actual held parent turn',
  );
  await composer().fill('OUTBOX_PLAIN_DISCARD');
  await page.keyboard.press('Enter');
  await composer().fill(longText);
  await page.keyboard.press('Alt+Enter');
  await composer().fill('OUTBOX_IMAGE_RESUME');
  await pasteImage();
  const queuedImage = (await current()).attachments.find(
    (a) => a.kind === 'image',
  ).content;
  await page.keyboard.press('Alt+Enter');
  await until(
    async () => (await current()).queue.length === 3,
    'three real inputs queued behind active model request',
  );
  await composer().fill('OUTBOX_UNSENT_DRAFT');
  await pasteImage();
  await until(
    async () =>
      (await current()).draft === 'OUTBOX_UNSENT_DRAFT' &&
      (await current()).attachments.some((a) => a.kind === 'image'),
    'unsent text and image draft persisted',
  );
  const draftImage = (await current()).attachments.find(
    (a) => a.kind === 'image',
  ).content;
  const before = await requests();
  await page.screenshot({
    path: join(output, 'outbox-before-whole-app-quit.png'),
  });
  // ScriptedModel begins at reply zero in each process. The restarted process
  // gets completions, while no request is allowed before an explicit UI action.
  await writeFile(
    fixture,
    JSON.stringify({
      requestsPath,
      replies: Array.from({ length: 8 }, (_, i) => ({
        message: {
          id: 'recovered-completion-' + i,
          role: 'assistant',
          content: 'Explicitly recovered input completed',
        },
      })),
    }),
  );
  await relaunch();
  page = getPage();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  await page
    .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
    .first()
    .click();
  const region = page.getByRole('region', {
    name: 'unsent messages',
    exact: true,
  });
  await region.waitFor();
  const recovered = await query('inputs', 'list');
  assert.equal(recovered.items.length, 3);
  assert(recovered.items.every((i) => i.state === 'recovery_pending'));
  assert.equal((await current()).queue.length, 0);
  await page.waitForTimeout(300);
  assert.equal(
    (await requests()).length,
    before.length,
    'restart must not call any model automatically',
  );
  assert.equal(await composer().inputValue(), 'OUTBOX_UNSENT_DRAFT');
  assert(
    (await current()).attachments.some(
      (a) => a.kind === 'image' && a.content === draftImage,
    ),
  );
  const longItem = region
    .locator('article')
    .filter({ hasText: 'OUTBOX_LINE_0001' });
  await longItem
    .getByRole('button', { name: 'edit in message box', exact: true })
    .click();
  await until(
    async () => (await composer().inputValue()).includes(longText),
    'all600 original lines copied into existing draft',
  );
  assert.equal(
    (await query('inputs', 'list')).items.length,
    3,
    'copying to draft retains durable recovery record',
  );
  await longItem.getByRole('button', { name: 'send now', exact: true }).click();
  const imageItem = region
    .locator('article')
    .filter({ hasText: 'OUTBOX_IMAGE_RESUME' });
  await imageItem
    .getByRole('button', { name: 'send now', exact: true })
    .click();
  const plain = region
    .locator('article')
    .filter({ hasText: 'OUTBOX_PLAIN_DISCARD' });
  // Discarding asks first, then the confirmation removes the record.
  await plain.getByRole('button', { name: 'discard', exact: true }).click();
  await plain.getByRole('button', { name: 'discard', exact: true }).click();
  await until(
    async () => (await query('inputs', 'list')).items.length === 0,
    'explicit resume and discard consume only chosen durable records',
  );
  await until(async () => {
    const rows = (await requests()).slice(before.length);
    const json = JSON.stringify(rows);
    return (
      json.includes(JSON.stringify(longText).slice(1, -1)) &&
      json.includes(queuedImage.split(',')[1])
    );
  }, 'actual resumed model requests contain original600 lines and exactPNG bytes');
  const after = await requests();
  assert((await composer().inputValue()).includes('OUTBOX_UNSENT_DRAFT'));
  assert((await composer().inputValue()).includes(longText));
  assert(
    (await current()).attachments.some(
      (a) => a.kind === 'image' && a.content === draftImage,
    ),
  );
  await writeFile(
    join(output, 'outbox-restart.json'),
    JSON.stringify(
      {
        beforeRequestCount: before.length,
        queuedImage,
        draftImage,
        recovered,
        afterRequests: after.slice(before.length),
        draft: (await current()).draft,
        remaining: await query('inputs', 'list'),
      },
      null,
      2,
    ),
  );
  await page.screenshot({
    path: join(output, 'outbox-after-explicit-recovery.png'),
  });
}
