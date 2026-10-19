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
    waitingApproval: 'needs approval',
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
// How a row of the in progress card fits: anything past the row's or the card's right
// edge, whether the name, the description and the words at the end are cut short.
const rowFit = (row) => {
  const box = (node) => node.getBoundingClientRect();
  const name = row.querySelector('.overview-name');
  const detail = row.querySelector('.overview-detail');
  const end = row.querySelector('.overview-end-text');
  return {
    overflow:
      Math.max(
        ...[...row.querySelectorAll('*')].map((node) => box(node).right),
      ) - box(row).right,
    cardOverflow: box(row).right - box(row.closest('.overview-body')).right,
    nameCut: name.scrollWidth > name.clientWidth,
    detail: detail ? Math.round(box(detail).width) : null,
    endCut: end.scrollWidth > end.clientWidth,
    endWidth: Math.round(box(end).width),
    ellipsis: getComputedStyle(end).textOverflow,
    tooltip: end.title,
  };
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
    assert.equal(
      await agentRow.locator('.overview-end-text').getAttribute('title'),
      'Which target should the build use?',
      'the tooltip over the words is the request too',
    );
    const waitingFit = await agentRow.evaluate(rowFit);
    assert.ok(waitingFit.overflow <= 0.5, JSON.stringify(waitingFit));
    assert.equal(waitingFit.nameCut, false);
    assert.equal(waitingFit.endCut, false, 'the waiting words are whole');

    // A long activity is cut short inside the card, as a 1400-pixel window showed it: the
    // name stays whole, a share of what the subagent was sent to do stays, and the
    // activity ends in an ellipsis with all of it in the tooltip.
    const activity =
      'Bash(npm run test -- --reporter=dot --test-name-pattern="reconnect after close")';
    await page.evaluate(
      (activity) =>
        window.readabilityFixture.runtime.change((state) => {
          state.interactions = [];
          state.agents = [
            {
              id: 'busy-agent',
              sessionId: 'session1',
              name: 'general-purpose: clean the build directory and rebuild',
              description:
                'general-purpose: clean the build directory and rebuild',
              status: 'running',
              activity,
              model: 'sample-code-model',
              tokens: 0,
              messages: [],
            },
          ];
        }),
      activity,
    );
    const busyRow = progress.locator('.overview-row').filter({
      has: page
        .locator('.overview-name')
        .getByText('general-purpose', { exact: true }),
    });
    await busyRow
      .locator('.overview-end-text')
      .getByText(activity, { exact: true })
      .waitFor();
    const busyFit = await busyRow.evaluate(rowFit);
    assert.ok(
      busyFit.overflow <= 0.5 && busyFit.cardOverflow <= 0,
      `nothing runs past the row or the card: ${JSON.stringify(busyFit)}`,
    );
    assert.equal(busyFit.nameCut, false, 'the name is whole');
    assert.ok(busyFit.detail >= 40, 'a share of the description stays');
    assert.deepEqual(
      [busyFit.endCut, busyFit.ellipsis, busyFit.tooltip],
      [true, 'ellipsis', activity],
    );
    // The same subagent waiting for an approval: the state words fit whole beside the
    // default subagent's name, and the long command is only in the tooltips.
    const command = `npm run test -- --reporter=dot ${'--flag '.repeat(20)}`;
    await page.evaluate(
      (command) =>
        window.readabilityFixture.runtime.change((state) => {
          state.agents[0].status = 'waiting';
          state.interactions = [
            {
              id: 'busy-approval',
              sessionId: 'session1',
              kind: 'approval',
              title: 'execute needs your permission',
              tool: 'execute',
              command,
              status: 'pending',
              revision: 1,
              origin: { agent: 'busy-agent', name: 'general-purpose' },
            },
          ];
        }),
      command,
    );
    await busyRow
      .locator('.overview-end-text')
      .getByText(words.waitingApproval, { exact: true })
      .waitFor();
    const askingFit = await busyRow.evaluate(rowFit);
    assert.ok(askingFit.overflow <= 0.5, JSON.stringify(askingFit));
    assert.deepEqual(
      [askingFit.nameCut, askingFit.endCut, askingFit.tooltip],
      [false, false, command],
    );
    assert.equal(await busyRow.getAttribute('title'), command);

    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'overview cards: in progress, context, waiting subagents and long activities, in English and Chinese',
  );
} finally {
  await browser?.close();
  await server.close();
}
