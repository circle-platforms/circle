import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

// Plan mode's plan opens where a file opens when Circle writes it, once in a turn, and
// again when the plan card asks about it. The card offers the four choices in the
// window's language; a change is sent only with what should change.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const open = async (query, width = 1440) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/plan-review-ui.html?${query}`,
    );
    await page
      .getByRole('textbox', { name: /message|消息/ })
      .first()
      .waitFor();
    const call = (name, ...args) =>
      page.evaluate(({ name, args }) => window.planFixture[name](...args), {
        name,
        args,
      });
    return { page, errors, call };
  };
  const shown = (page) => page.locator('.plan-view').isVisible();
  // What a write would open, it has opened: React renders the change, and its effects run
  // in a task of their own after the frame that shows it.
  const settle = (page) =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const channel = new MessageChannel();
              channel.port1.onmessage = () => done(undefined);
              channel.port2.postMessage(undefined);
            }),
          ),
        ),
    );

  {
    const { page, errors, call } = await open('language=zh-CN&theme=light');
    assert.equal(await shown(page), false, 'no plan, nothing opens');
    await call(
      'write',
      '# 计划\n\n1. 先做数据库迁移\n',
      '2026-10-20T10:00:00.000Z',
    );
    const plan = page.getByRole('region', { name: '计划', exact: true });
    await plan.getByRole('heading', { name: '计划' }).waitFor();
    assert.equal(
      await plan.getByRole('listitem').innerText(),
      '先做数据库迁移',
    );
    assert.equal(
      await page.locator('[data-inspector-resource="files"]').isVisible(),
      true,
      'the plan opens in the files mode, where a file opens',
    );
    // Closed while Circle works, it stays closed for the rest of the turn
    await page.getByRole('button', { name: '关闭计划', exact: true }).click();
    await call(
      'write',
      '# 计划\n\n1. 先做数据库迁移\n2. 再改接口\n',
      '2026-10-20T10:00:05.000Z',
    );
    await settle(page);
    assert.equal(
      await shown(page),
      false,
      'a closed plan stays closed in the turn',
    );
    // The card asks about it: the plan opens beside it, up to date
    await call('endTurn');
    await call('ask', 'card-change');
    const card = page.locator('.inline-request[data-kind="plan-exit"]');
    await card.waitFor();
    await plan.getByRole('listitem').nth(1).waitFor();
    assert.equal(
      await card.locator('header strong').innerText(),
      '计划写好了，接下来怎么做？',
    );
    // A question in words, as the question card's heading is: the monospace font is a
    // tool card's, which names a tool
    const fonts = await card.evaluate((section) => {
      const heading = section.querySelector('header strong');
      return {
        heading: getComputedStyle(heading).fontFamily,
        card: getComputedStyle(section).fontFamily,
      };
    });
    assert.equal(fonts.heading, fonts.card, 'the heading takes the card font');
    assert.deepEqual(
      await card
        .getByRole('radio')
        .evaluateAll((items) =>
          items.map((item) => item.getAttribute('aria-label')),
        ),
      ['自动模式执行', '手动审批执行', '需要修改', '只保存计划，不做修改'],
    );
    await page.getByRole('button', { name: '关闭计划', exact: true }).click();
    await card.getByRole('button', { name: '打开计划', exact: true }).click();
    await plan.waitFor();
    // A change goes only with what should change
    const send = card.getByRole('button', { name: '发送回答', exact: true });
    assert.equal(await send.isDisabled(), true);
    await card.getByRole('radio', { name: '需要修改', exact: true }).check();
    const words = card.getByRole('textbox', {
      name: '要改什么？',
      exact: true,
    });
    await words.waitFor();
    assert.equal(await send.isDisabled(), true, 'nothing written yet');
    await words.fill('先改接口，再做迁移');
    await send.click();
    await card.waitFor({ state: 'detached' });
    assert.deepEqual(JSON.parse(await call('decision', 'card-change')), {
      choices: ['change the plan'],
      comment: '先改接口，再做迁移',
    });
    assert.deepEqual(errors, []);
    await page.close();
  }

  {
    // English, dark, and no plan written: nothing opens and there is none to open. A
    // choice to implement is sent alone.
    const { page, errors, call } = await open('language=en&theme=dark');
    await call('ask', 'card-auto');
    const card = page.locator('.inline-request[data-kind="plan-exit"]');
    await card.waitFor();
    await settle(page);
    assert.equal(await shown(page), false);
    assert.equal(
      await card.getByRole('button', { name: 'open plan' }).count(),
      0,
    );
    assert.equal(
      await card.locator('header strong').innerText(),
      'the plan is ready, what next?',
    );
    await card
      .getByRole('radio', { name: 'implement in auto mode', exact: true })
      .check();
    assert.equal(await card.getByRole('textbox').count(), 0);
    await card
      .getByRole('button', { name: 'send answer', exact: true })
      .click();
    await card.waitFor({ state: 'detached' });
    assert.deepEqual(JSON.parse(await call('decision', 'card-auto')), {
      choices: ['implement in auto mode'],
      comment: '',
    });
    assert.deepEqual(errors, []);
    await page.close();
  }

  {
    // A narrow window lays the drawer over the conversation: the plan waits to be opened
    const { page, errors, call } = await open('language=en', 900);
    await call('write', '# Plan\n', '2026-10-20T10:00:00.000Z');
    await call('endTurn');
    await call('ask', 'card-narrow');
    const card = page.locator('.inline-request[data-kind="plan-exit"]');
    await card.waitFor();
    await settle(page);
    assert.equal(await shown(page), false);
    await card.getByRole('button', { name: 'open plan', exact: true }).click();
    await page.getByRole('region', { name: 'plan', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
console.log('plan review: ok');
