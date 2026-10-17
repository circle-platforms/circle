import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
const output = resolve(
  process.env.CIRCLE_RECOVERY_UI_EVIDENCE_DIR ??
    'artifacts/recovery-panel-headless',
);
await mkdir(output, { recursive: true });
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const theme of ['light', 'dark'])
    for (const language of ['en', 'zh-CN'])
      for (const width of [1000, 375]) {
        const surface = await browser.newPage({
          viewport: { width, height: 650 },
        });
        await surface.goto(
          `${server.resolvedUrls.local[0]}test/recovered-input-ui.html?theme=${theme}&language=${language}`,
        );
        await surface
          .getByRole('button', {
            name:
              language === 'en' ? 'return input to draft' : '复制输入到草稿',
            exact: true,
          })
          .waitFor();
        assert.equal(
          await surface.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        assert.equal(
          await surface
            .locator('.task-recovery')
            .evaluate((node) => getComputedStyle(node).backgroundColor),
          'rgba(0, 0, 0, 0)',
          'recovery must keep the existing composer background',
        );
        assert.equal(
          (await surface.evaluate(() => window.calls)).filter(
            (call) => call.payload.method === 'resolve',
          ).length,
          0,
        );
        await surface.screenshot({
          animations: 'disabled',
          path: join(output, `${theme}-${language}-${width}.png`),
        });
        const recovery = surface.locator('.recovered-inputs');
        assert(
          (
            await recovery.locator('.task-recovery-title small').textContent()
          ).endsWith(language === 'en' ? '1 media attachment' : '1 个媒体附件'),
          'a single recovered attachment has the correct localized count',
        );
        const discard = recovery.getByRole('button', {
          name: language === 'en' ? 'discard recovered input' : '移除恢复副本',
          exact: true,
        });
        const assertActionVisible = async () => {
          const panel = await recovery.boundingBox();
          const action = await discard.boundingBox();
          const draft = await surface
            .getByRole('textbox', { name: 'restored draft' })
            .boundingBox();
          assert(panel && action && draft);
          assert(
            action.y >= panel.y &&
              action.y + action.height <= panel.y + panel.height,
            'the complete removal action is visible inside the recovery area',
          );
          assert(
            panel.y + panel.height < draft.y,
            'the recovery area leaves a clear gap before the original draft',
          );
        };
        await assertActionVisible();
        const summary = recovery.locator(
          ':scope > article > details > summary',
        );
        await summary.click();
        assert.match(
          await recovery
            .locator(':scope > article > details > pre')
            .first()
            .textContent(),
          /preserved line 599$/,
        );
        await discard.scrollIntoViewIfNeeded();
        await assertActionVisible();
        assert(
          await recovery.evaluate((node) => node.scrollTop > 0),
          'expanded long content scrolls within the recovery area',
        );
        await recovery.getByRole('checkbox').check();
        assert.equal(await discard.isEnabled(), true);
        await assertActionVisible();
        await surface.screenshot({
          animations: 'disabled',
          path: join(
            output,
            `${theme}-${language}-${width}-expanded-actions.png`,
          ),
        });
        await surface.close();
      }
  const page = await browser.newPage();
  await page.goto(
    `${server.resolvedUrls.local[0]}test/recovered-input-ui.html`,
  );
  const copy = page.getByRole('button', {
    name: 'return input to draft',
    exact: true,
  });
  await copy.waitFor();
  assert.equal(
    (await page.evaluate(() => window.calls)).filter(
      (c) => c.payload.method === 'resolve',
    ).length,
    0,
  );
  await copy.click();
  await page
    .getByText(
      'copied to draft without sending; recovery copy retained until you explicitly remove it',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'restored draft' }).inputValue(),
    'existing draft\n\n' +
      Array.from({ length: 600 }, (_, i) => `preserved line ${i}`).join('\n'),
  );
  assert.equal(
    await page.getByRole('status', { name: 'restored media' }).textContent(),
    'data:image/png;base64,AAEC',
  );
  const discard = page.getByRole('button', {
    name: 'discard recovered input',
    exact: true,
  });
  assert.equal(await discard.isDisabled(), true);
  await page.getByRole('checkbox').check();
  await discard.click();
  await page
    .getByText('recovery copy explicitly removed', { exact: true })
    .waitFor();
  const actions = (await page.evaluate(() => window.calls))
    .filter((c) => c.payload.method === 'resolve')
    .map((c) => c.payload.params.action);
  assert.deepEqual(actions, ['returnToDraft', 'discard']);
  const failurePage = await browser.newPage();
  await failurePage.goto(
    `${server.resolvedUrls.local[0]}test/recovered-input-ui.html?storageFailure=1`,
  );
  await failurePage
    .getByRole('button', { name: 'return input to draft', exact: true })
    .click();
  await failurePage
    .getByRole('alert')
    .filter({ hasText: 'draft is available only in memory' })
    .waitFor();
  assert.equal(
    await failurePage
      .getByText(
        'copied to draft without sending; recovery copy retained until you explicitly remove it',
        { exact: true },
      )
      .count(),
    0,
  );
  const fullDraft =
    'existing draft\n\n' +
    Array.from({ length: 600 }, (_, i) => `preserved line ${i}`).join('\n');
  assert.equal(
    await failurePage
      .getByRole('textbox', { name: 'restored draft' })
      .inputValue(),
    fullDraft,
  );
  assert.equal(
    await failurePage
      .getByRole('button', { name: 'copied in memory; not saved', exact: true })
      .isDisabled(),
    true,
  );
  await failurePage.evaluate(() => window.allowRecoveryStorage());
  await failurePage
    .getByRole('button', { name: 'retry saving recovered draft', exact: true })
    .click();
  await failurePage
    .getByText(
      'draft saved; recovery copy retained until you explicitly remove it',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await failurePage
      .getByRole('textbox', { name: 'restored draft' })
      .inputValue(),
    fullDraft,
  );
  await failurePage.reload();
  await failurePage.getByRole('textbox', { name: 'restored draft' }).waitFor();
  assert.equal(
    await failurePage
      .getByRole('textbox', { name: 'restored draft' })
      .inputValue(),
    fullDraft,
  );
  assert.equal(
    await failurePage
      .getByRole('status', { name: 'restored media' })
      .textContent(),
    'data:image/png;base64,AAEC',
  );
  console.log(
    'recovered input UI: no automatic replay, complete 600-line draft/media and explicit copy removal passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
