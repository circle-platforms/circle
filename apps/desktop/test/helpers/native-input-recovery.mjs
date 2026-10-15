import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1kAAAAASUVORK5CYII=';
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
  const pasteImage = async () => {
    const app = getApp();
    await app.evaluate(({ clipboard, nativeImage }, png) => {
      globalThis.__journeyClipboard = clipboard
        .availableFormats()
        .map((format) => [format, clipboard.readBuffer(format)]);
      clipboard.writeImage(
        nativeImage.createFromBuffer(Buffer.from(png, 'base64')),
      );
    }, png);
    try {
      const before = (await current()).attachments.length;
      await composer().focus();
      await page.keyboard.press('ControlOrMeta+v');
      await until(
        async () => (await current()).attachments.length > before,
        'real native image paste received',
      );
    } finally {
      await app.evaluate(({ clipboard }) => {
        clipboard.clear();
        for (const [format, buffer] of globalThis.__journeyClipboard ?? [])
          clipboard.writeBuffer(format, buffer);
        delete globalThis.__journeyClipboard;
      });
    }
  };
  await page
    .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
    .click();
  assert.equal(
    (await current()).status,
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
