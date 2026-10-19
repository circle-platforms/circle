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
    tokens: 'tokens',
    cost: 'cost',
    cache: 'cache',
    waitingApproval: 'waiting for your approval',
    waiting: 'waiting for you',
  },
  'zh-CN': {
    plan: '计划',
    oneSubagent: '1 个子代理',
    planAndSubagent: '计划 1/2 · 1 个子代理',
    tokens: 'token 数',
    cost: '费用',
    cache: '缓存',
    // The words of the design's overview board.
    waitingApproval: '等你批准',
    waiting: '等待你处理',
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

    // The context card: its tokens are how full the model's window is, used of the
    // window, as the percentage above them says; cost and cache stay.
    await page.evaluate(() =>
      window.readabilityFixture.runtime.change((state) => {
        state.sessions.find((item) => item.id === 'session1').meters = {
          input: 912_300,
          output: 41_200,
          cacheRead: 456_150,
          cost: '$0.04',
          contextInput: 14_100,
          contextWindow: 128_000,
        };
      }),
    );
    const context = page.locator('#overview-context');
    await context
      .locator('.overview-summary')
      .getByText('11%', { exact: true })
      .waitFor();
    if (
      (await context.locator('button').getAttribute('aria-expanded')) !== 'true'
    )
      await context.locator('button').click();
    const facts = await page
      .locator('#overview-context-body dl')
      .evaluate((list) =>
        Object.fromEntries(
          [...list.querySelectorAll('dt')].map((term) => [
            term.textContent,
            term.nextElementSibling?.textContent,
          ]),
        ),
      );
    assert.equal(facts[words.tokens], '14.1k / 128.0k');
    assert.equal(facts[words.cost], '$0.04');
    assert.equal(facts[words.cache], '50.0%');
    assert.ok(
      !Object.values(facts).some((value) => value?.includes('↑')),
      'not the tokens sent and received over the whole session',
    );

    // A subagent waiting for an approval says so in the design's words, with the
    // orange dot; what it asked to run is the row's tooltip.
    await page.evaluate(() =>
      window.readabilityFixture.runtime.change((state) => {
        state.agents[0].status = 'waiting';
        state.interactions = [
          {
            id: 'agent-approval',
            sessionId: 'session1',
            kind: 'approval',
            title: 'execute needs your permission',
            tool: 'execute',
            command: 'rm -rf dist',
            status: 'pending',
            revision: 1,
            origin: { agent: 'overview-agent', name: 'explore' },
          },
        ];
      }),
    );
    const agentRow = progress.locator('.overview-row').filter({
      has: page.locator('.overview-name').getByText('explore', { exact: true }),
    });
    await agentRow
      .locator('.overview-end')
      .getByText(words.waitingApproval, { exact: true })
      .waitFor();
    assert.equal(await agentRow.getAttribute('title'), 'rm -rf dist');
    assert.equal(
      await agentRow.locator('.overview-end').textContent(),
      words.waitingApproval,
      'the command is not in the row',
    );
    assert.equal(
      await agentRow.locator('.overview-dot').getAttribute('data-state'),
      'wait',
    );
    // Any other request is waited on in the words every waiting subagent has.
    await page.evaluate(() =>
      window.readabilityFixture.runtime.change((state) => {
        state.interactions = [
          {
            id: 'agent-question',
            sessionId: 'session1',
            kind: 'question',
            title: 'Which target should the build use?',
            choices: ['debug', 'release'],
            status: 'pending',
            revision: 1,
            origin: { agent: 'overview-agent', name: 'explore' },
          },
        ];
      }),
    );
    await agentRow
      .locator('.overview-end')
      .getByText(words.waiting, { exact: true })
      .waitFor();
    assert.equal(
      await agentRow.getAttribute('title'),
      'Which target should the build use?',
    );

    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'overview cards: in progress, context and waiting subagents, in English and Chinese',
  );
} finally {
  await browser?.close();
  await server.close();
}
