import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

// The overview's cards as the conversation's state makes them, in both languages. The
// conversation's state is changed through its runtime, as the live app's snapshots do.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const WORDS = {
  en: {
    plan: 'plan',
    oneSubagent: '1 subagent',
    planAndSubagent: 'plan 1/2 · 1 subagent',
  },
  'zh-CN': {
    plan: '计划',
    oneSubagent: '1 个子代理',
    planAndSubagent: '计划 1/2 · 1 个子代理',
  },
};
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const [language, theme] of [
    ['en', 'light'],
    ['zh-CN', 'dark'],
  ]) {
    const words = WORDS[language];
    const page = await browser.newPage({
      viewport: { width: 1400, height: 950 },
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/response-readability-ui.html?language=${language}&theme=${theme}#/session/session1`,
    );
    await page.locator('.overview-column .overview-card').first().waitFor();
    const settle = () =>
      page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
    const progress = page.locator(
      'section.overview-card[aria-labelledby="overview-progress"]',
    );
    const planRows = progress.locator('.overview-row').filter({
      has: page.locator('.overview-end').getByText(words.plan, {
        exact: true,
      }),
    });

    // A plan whose every step is done is not in progress: with nothing else at work
    // there is no card at all.
    await page.evaluate(() =>
      window.readabilityFixture.runtime.change((state) => {
        const session = state.sessions.find((item) => item.id === 'session1');
        session.todos = [
          { id: 'step-1', text: 'Trace the reconnect', status: 'completed' },
          { id: 'step-2', text: 'Add the regression', status: 'completed' },
        ];
        state.agents = [];
      }),
    );
    await settle();
    assert.equal(
      await progress.count(),
      0,
      `a finished plan alone draws no card (${language})`,
    );
    // A subagent at work: the card is there for it, and the finished plan is neither
    // counted nor shown.
    await page.evaluate(() =>
      window.readabilityFixture.runtime.change((state) => {
        state.agents = [
          {
            id: 'overview-agent',
            sessionId: 'session1',
            name: 'explore: find every reconnect call',
            description: 'explore: find every reconnect call',
            status: 'running',
            model: 'sample-code-model',
            tokens: 0,
            messages: [],
          },
        ];
      }),
    );
    await progress.waitFor();
    assert.equal(
      await progress.locator('.overview-summary').textContent(),
      words.oneSubagent,
    );
    assert.equal(await planRows.count(), 0);
    // A step still to do: the plan is in progress again, with that step.
    await page.evaluate(() =>
      window.readabilityFixture.runtime.change((state) => {
        state.sessions.find((item) => item.id === 'session1').todos[1].status =
          'pending';
      }),
    );
    await planRows.waitFor();
    assert.equal(
      await progress.locator('.overview-summary').textContent(),
      words.planAndSubagent,
    );
    assert.equal(
      await planRows.locator('.overview-name').textContent(),
      'Add the regression',
    );

    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('overview cards: in progress, in English and Chinese');
} finally {
  await browser?.close();
  await server.close();
}
