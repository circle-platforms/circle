import {
  preserveNativeClipboard,
  restoreNativeClipboard,
} from './native-clipboard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  const current = async () =>
    (await state()).sessions.find((s) => s.id === sessionId);
  const composer = () =>
    page.getByRole('textbox', { name: 'message', exact: true });
  let pasteAttempt = 0;
  const pasteImage = async () => {
    pasteAttempt++;
    const observations = { attempt: pasteAttempt };
    const app = getApp();
    const clipboardKey = await preserveNativeClipboard(app);
    try {
      const before = (await current()).attachments.length;
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
      await page.evaluate(() => {
        const events = [];
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
          cleanup: () => document.removeEventListener('paste', listener, true),
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
      await page.keyboard.press('ControlOrMeta+v');
      await until(
        async () => (await current()).attachments.length > before,
        'real native valid PNG paste received',
      );
    } finally {
      observations.events = await page
        .evaluate(() => {
          const observer = window.__circlePasteObservation;
          observer?.cleanup();
          delete window.__circlePasteObservation;
          return observer?.events ?? [];
        })
        .catch((error) => ({ unavailable: String(error) }));
      await writeFile(
        join(output, `outbox-paste-${pasteAttempt}-observations.json`),
        JSON.stringify(observations, null, 2),
      );
      await restoreNativeClipboard(app, clipboardKey);
    }
  };
  await page
    .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
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
    .click();
  const region = page.getByRole('region', {
    name: 'recovered queued inputs',
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
    .getByRole('button', { name: 'return input to draft', exact: true })
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
  await longItem
    .getByRole('button', { name: 'resume this input', exact: true })
    .click();
  const imageItem = region
    .locator('article')
    .filter({ hasText: 'OUTBOX_IMAGE_RESUME' });
  await imageItem
    .getByRole('button', { name: 'resume this input', exact: true })
    .click();
  const plain = region
    .locator('article')
    .filter({ hasText: 'OUTBOX_PLAIN_DISCARD' });
  await plain
    .getByRole('checkbox', {
      name: 'I have checked the input and want to remove its recovery copy',
      exact: true,
    })
    .check();
  await plain
    .getByRole('button', { name: 'discard recovered input', exact: true })
    .click();
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
