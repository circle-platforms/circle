// A publication renders the transcript rows it changed and no others, while what a row shows
// from elsewhere still reaches it: its open state, its agent, a request, the language, the day.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
  resolve: {
    alias: [
      {
        find: /^\.\.\/model\/presentation$/,
        replacement: fileURLToPath(
          new URL('./transcript-rows-counter.ts', import.meta.url),
        ),
      },
    ],
  },
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
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
  });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const morning = new Date('2026-11-06T10:00:00');
  await page.clock.setFixedTime(morning);
  await page.goto(
    `${server.resolvedUrls.local[0]}test/transcript-rows-ui.html`,
  );
  const fixture = (name, ...args) =>
    page.evaluate(({ name, args }) => window.rowsFixture[name](...args), {
      name,
      args,
    });
  const renders = () => page.evaluate(() => ({ ...window.rowRenders }));
  // Which rows rendered since `before`.
  const renderedSince = (before, after) =>
    Object.keys(after).filter((id) => after[id] !== before[id]);
  // The window has rendered a publication once its title is on screen.
  let titles = 0;
  const publishNothingElse = async () => {
    const title = `publication ${++titles}`;
    await fixture('title', title);
    await page.getByText(title, { exact: true }).first().waitFor();
  };
  const transcript = page.locator('.transcript').first();
  await transcript.getByText('the last prompt', { exact: true }).waitFor();
  const start = await renders();
  assert.ok(
    Object.keys(start).length >= 80,
    `${Object.keys(start).length} rows rendered`,
  );

  // Publications about something else render no row at all.
  for (let count = 0; count < 5; count++) await publishNothingElse();
  assert.deepEqual(
    renderedSince(start, await renders()),
    [],
    'nothing about the rows changed',
  );

  // One finished call: its line and nothing else.
  let before = await renders();
  await fixture('finishRunning');
  await transcript
    .locator('.tool-group[data-busy]')
    .waitFor({ state: 'detached' });
  let rendered = renderedSince(before, await renders());
  assert.ok(rendered.length > 0, 'the changed row rendered');
  assert.ok(
    rendered.every((id) => /task-call|running-call/.test(id)),
    `only the line that changed: ${rendered}`,
  );

  // A new row does not render the ones before it.
  before = await renders();
  await fixture('append');
  await transcript
    .getByText('a prompt that came later', { exact: true })
    .waitFor();
  rendered = renderedSince(before, await renders());
  assert.deepEqual(rendered, ['thinking:appended']);

  // Opening a row renders that row, and it stays open through later publications.
  const group = transcript.locator('.tool-group').first();
  before = await renders();
  await group.locator('.tool-summary').click();
  await group.getByText('output of call-0').waitFor();
  rendered = renderedSince(before, await renders());
  assert.ok(
    rendered.every((id) => id.includes('call-0')),
    `only the opened row: ${rendered}`,
  );
  before = await renders();
  await publishNothingElse();
  assert.deepEqual(renderedSince(before, await renders()), []);
  await group.getByText('output of call-0').waitFor();

  // What a row shows of an agent follows the agent, though the row itself did not change.
  const links = transcript.locator('.tool-agent-links');
  await links.getByText('the child agent').waitFor();
  await fixture('agent', { name: 'the renamed agent' });
  await links.getByText('the renamed agent').waitFor();
  before = await renders();
  await fixture('agent', { description: 'not shown on the row' });
  await publishNothingElse();
  assert.deepEqual(
    renderedSince(before, await renders()),
    [],
    'a change the row does not show',
  );

  // A request waits under the call it is about, and goes when it is answered.
  await fixture('ask');
  const request = transcript.locator('.tool-group').filter({
    hasText: 'src/running-call.ts',
  });
  await request.first().waitFor();
  await fixture('answer');
  await request.first().waitFor({ state: 'detached' });

  // The language reaches every row, and the day reaches a time written as today's.
  const firstAnswer = transcript.locator('.message', { hasText: 'answer 0' });
  await firstAnswer.getByText('thinking', { exact: true }).waitFor();
  await firstAnswer
    .locator('time')
    .getByText(/\d{1,2}:\d{2}/)
    .waitFor();
  assert.doesNotMatch(await firstAnswer.locator('time').innerText(), /Nov/);
  await page.clock.setFixedTime(new Date('2026-11-07T00:10:00'));
  await publishNothingElse();
  await firstAnswer.locator('time').getByText(/Nov/).waitFor();
  await fixture('setLanguage', 'zh-CN');
  await firstAnswer.getByText('思考', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('transcript rows render only what changed');
} finally {
  await browser?.close();
  await server.close();
}
