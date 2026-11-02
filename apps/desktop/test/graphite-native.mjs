import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setViewport, readViewport } from './helpers/viewport.mjs';
import { waitAnimationFrames } from './helpers/frame-readiness.mjs';
import { waitDesktopReady } from './helpers/desktop-readiness.mjs';
import { observePage, captureFailure } from './helpers/diagnostics.mjs';
import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const packaged = Boolean(process.env.CIRCLE_DESKTOP_EXECUTABLE);
const output = join(
  root,
  'artifacts/graphite',
  packaged ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-graphite-native-'));
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'preview',
  CIRCLE_WORKBENCH_LANGUAGE: process.env.CIRCLE_WORKBENCH_LANGUAGE ?? 'zh-CN',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
    workspace: join(temp, 'project'),
  }),
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
};
await mkdir(join(temp, 'project'));
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
const errors = [];
const observations = [];
const checks = [];
const shots = [];
const layout = [];
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  observePage(page, errors);
  await page.locator('.composer textarea').waitFor();
  await page.locator('.composer textarea').fill('synthetic graphite draft');
  await page.waitForFunction(() =>
    localStorage.getItem('circle.workbench.preview.v1'),
  );
  const baseline = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('circle.workbench.preview.v1')),
  );
  async function seed(theme, state) {
    await page.evaluate(
      ({ baseline, theme, state }) => {
        const saved = structuredClone(baseline);
        const session = saved.sessions.find(
          (s) => s.id === saved.activeSessionId,
        );
        session.draft = 'synthetic graphite draft';
        session.mode =
          state === 'plan' || state === 'attention' ? 'plan' : 'manual';
        session.readOnly = session.mode === 'plan';
        session.state =
          state === 'working' || state === 'attention' ? 'waiting' : 'idle';
        session.turn =
          state === 'working' || state === 'attention'
            ? {
                startedAt: Date.now(),
                waited: 0,
                tokens: 120,
                verb: 'thinking',
              }
            : undefined;
        session.todos = [
          { id: 'p1', text: 'Read synthetic source', status: 'completed' },
          { id: 'p2', text: 'Check synthetic lifecycle', status: 'running' },
          { id: 'p3', text: 'Run regression tests', status: 'pending' },
        ];
        session.meters = {
          input: 4280,
          output: 684,
          cacheRead: 0,
          cost: '$0.01',
          contextInput: 4280,
          contextWindow: 128000,
        };
        saved.interactions =
          state === 'attention'
            ? [
                {
                  id: 'graphite-request',
                  sessionId: session.id,
                  kind: 'approval',
                  status: 'pending',
                  revision: 1,
                  title: 'synthetic approval',
                  tool: 'write_file',
                  target: 'synthetic.txt',
                  choices: ['allow once', 'reject'],
                },
              ]
            : [];
        saved.jobs = [
          {
            id: 'j1',
            sessionId: session.id,
            kind: 'command',
            title: 'npm test -- synthetic',
            state: 'running',
            elapsed: '14s',
            output: 'synthetic output',
            outputPath: '',
            stopRequested: false,
          },
        ];
        saved.settings.theme = theme;
        localStorage.setItem('circle.workbench.overview', '0');
        window.addEventListener(
          'pagehide',
          () =>
            localStorage.setItem(
              'circle.workbench.preview.v1',
              JSON.stringify(saved),
            ),
          { once: true },
        );
        location.hash = '/session/' + session.id;
      },
      { baseline, theme, state },
    );
    await page.reload();
    await page.locator(`.composer[data-composer-state="${state}"]`).waitFor();
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    await waitAnimationFrames(page, {
      label: 'graphite state ready',
      timeoutMs: 15000,
    });
  }
  for (const width of [1440, 1024]) {
    const sizing = await setViewport(app, page, { width, height: 980 });
    for (const theme of ['dark', 'light'])
      for (const state of ['default', 'plan', 'working', 'attention']) {
        await seed(theme, state);
        const sample = await page.evaluate(() => {
          const box = (node) => {
            const r = node.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              right: r.right,
              bottom: r.bottom,
            };
          };
          const composer = document.querySelector('.composer');
          const foot = composer.querySelector('.composer-footbar');
          return {
            viewport: { width: innerWidth, height: innerHeight },
            sidebar: box(document.querySelector('.desktop-sidebar')),
            composer: box(composer),
            footer: box(foot),
            background: getComputedStyle(composer).backgroundColor,
            ring: getComputedStyle(composer, '::before').backgroundImage,
            animation: getComputedStyle(composer, '::before').animationDuration,
            reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
            send: !!composer.querySelector('.send'),
            brand: document.querySelector('.brand').textContent,
            contentWidth:
              document.querySelector('.transcript-column').clientWidth - 56,
          };
        });
        assert.equal(Math.round(sample.sidebar.width), 232);
        assert.ok(sample.composer.width <= 760.5);
        assert.ok(sample.contentWidth <= 760.5);
        assert.ok(
          sample.footer.y >= sample.composer.y &&
            sample.footer.bottom <= sample.composer.bottom + 1,
        );
        assert.ok(sample.composer.bottom <= sample.viewport.height);
        assert.equal(sample.send, state !== 'working');
        if (state === 'working') {
          assert.match(sample.ring, /conic-gradient/);
          if (!sample.reduced) assert.equal(sample.animation, '3.6s');
        }
        if (state === 'attention')
          assert.equal(await page.locator('.interaction-summary').count(), 1);
        assert.match(sample.brand, /circle/);
        assert.equal(await page.locator('.conversation-jobs li').count(), 1);
        const name = `${theme}-${width}-${state}.png`;
        const bytes = await page.screenshot({ path: join(output, name) });
        shots.push({
          path: name,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        observations.push({ theme, state, sizing, ...sample });
      }
  }
  checks.push(
    'sixteen native theme/width/state samples keep the footer inside a bounded composer and show the correct action',
  );
  await seed('light', 'default');
  await setViewport(app, page, { width: 1440, height: 980 });
  await page.locator('.transcript').evaluate((node) => (node.scrollTop = 0));
  await waitAnimationFrames(page, {
    label: 'transcript first message',
    timeoutMs: 15000,
  });
  const userMessage = await page
    .locator('.message.user .bubble')
    .first()
    .evaluate((node) => ({
      radius: getComputedStyle(node).borderRadius,
      border: getComputedStyle(node).borderWidth,
    }));
  assert.equal(userMessage.radius, '10px');
  assert.equal(userMessage.border, '0px');
  const topName = 'light-1440-messages.png';
  const topBytes = await page.screenshot({ path: join(output, topName) });
  shots.push({
    path: topName,
    sha256: createHash('sha256').update(topBytes).digest('hex'),
  });
  await seed('dark', 'default');
  await setViewport(app, page, { width: 1440, height: 980 });
  // Opening a mode replaces overview; opening a document may still widen that mode.
  await page
    .locator('.drawer-mode-button')
    .filter({ has: page.locator('svg') })
    .nth(1)
    .click();
  await page.locator('.work-drawer').waitFor();
  const drawer = await waitDesktopReady(
    () => page.locator('.inspector-column').boundingBox(),
    (box) => !!box && Math.abs(box.width - 380) <= 1,
    { label: 'default drawer pixel width', timeoutMs: 15000, stableMs: 100 },
  );
  layout.push({ drawerWidth: drawer.sample.width });
  assert.equal(await page.locator('.overview-column').count(), 0);
  checks.push(
    'the mode opens at 380px and never coexists with overview as a fourth pane',
  );
  await setViewport(app, page, { width: 1180, height: 800 });
  assert.equal(
    await page
      .locator('#workbench-columns')
      .getAttribute('data-inspector-mode'),
    'split',
  );
  await setViewport(app, page, { width: 1179, height: 800 });
  await page.waitForFunction(
    () =>
      document.getElementById('workbench-columns').dataset.inspectorMode ===
      'closed',
  );
  await setViewport(app, page, { width: 700, height: 800 });
  assert.equal(await page.locator('.desktop-sidebar').isVisible(), false);
  await page.locator('.topbar-title > .icon-button').click();
  await page.locator('.dialog-content .sidebar').waitFor();
  await page.keyboard.press('Escape');
  checks.push('drawer collapses below 1180 and navigation below 760');
  await setViewport(app, page, { width: 1024, height: 800 });
  await seed('dark', 'attention');
  await page.locator('.inline-request .button.primary').first().click();
  await page.locator('.composer[data-composer-state="working"]').waitFor();
  await page.locator('.composer-send > .icon-button').click();
  await page.locator('.composer[data-composer-state="plan"]').waitFor();
  assert.equal(
    await page.locator('.composer textarea').inputValue(),
    'synthetic graphite draft',
  );
  await page.locator('.composer-send > .icon-button').click();
  await page.locator('.composer[data-composer-state="working"]').waitFor();
  await page.locator('.composer textarea').fill('synthetic steering');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForFunction(() => {
    const state = JSON.parse(
      localStorage.getItem('circle.workbench.preview.v1'),
    );
    return state.sessions
      .find((s) => s.id === state.activeSessionId)
      .queue.some(
        (item) =>
          item.kind === 'steering' && item.text === 'synthetic steering',
      );
  });
  checks.push(
    'answer restores running, stop restores plan with draft intact, resume and Enter preserve steering',
  );
  await seed('light', 'default');
  await setViewport(app, page, { width: 1024, height: 650 });
  await page
    .locator('.composer textarea')
    .fill(
      Array.from({ length: 24 }, (_, i) => `synthetic line ${i}`).join('\n'),
    );
  const inputLayout = await page
    .locator('.composer textarea')
    .evaluate((node) => ({
      height: node.clientHeight,
      scroll: node.scrollHeight,
      line: Number.parseFloat(getComputedStyle(node).lineHeight),
    }));
  assert.ok(inputLayout.scroll > inputLayout.height);
  assert.ok(inputLayout.height <= 12 * inputLayout.line + 24);
  const sendBox = await page.locator('.composer-send').boundingBox();
  assert.ok(
    sendBox && sendBox.y + sendBox.height <= (await readViewport(page)).height,
    JSON.stringify(sendBox),
  );
  checks.push(
    'long drafts scroll within twelve lines and keep the primary action in the native viewport',
  );
  await seed('dark', 'working');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(
    await page
      .locator('.composer')
      .evaluate((node) => getComputedStyle(node, '::before').animationName),
    'none',
  );
  assert.equal(
    await page
      .locator('.spin')
      .evaluateAll((nodes) =>
        nodes.every((node) => getComputedStyle(node).animationName === 'none'),
      ),
    true,
  );
  checks.push(
    'reduced motion disables the composer ring and activity spinners',
  );
  const row = page.locator('.session-row').first();
  await row.hover();
  const menuButton = await row.locator('button.icon-button').boundingBox();
  assert.ok(menuButton);
  await page.mouse.move(
    menuButton.x + menuButton.width / 2,
    menuButton.y + menuButton.height / 2,
  );
  await page.mouse.down();
  await page.locator('.session-menu').waitFor();
  const rename = page.locator('.session-menu [role="menuitem"]').nth(2);
  const renameBox = await rename.boundingBox();
  assert.ok(renameBox);
  await page.mouse.move(
    renameBox.x + renameBox.width / 2,
    renameBox.y + renameBox.height / 2,
  );
  await page.mouse.up();
  assert.equal(await page.locator('.session-menu').isVisible(), true);
  assert.equal(await page.locator('.session-rename').count(), 0);
  await rename.click();
  await page.locator('.session-rename').waitFor();
  await page.keyboard.press('Escape');
  checks.push(
    'reduced motion keeps the opening pointer release from selecting a session menu action, while a fresh click still works',
  );
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.packaged, packaged);
  assert.deepEqual(errors, []);
  const designFiles = await Promise.all(
    [
      'README.md',
      'tokens.json',
      'components/WorkbenchShell/README.md',
      'components/Composer/README.md',
    ].map(async (path) => ({
      path: 'docs/design/circle-design-system/' + path,
      sha256: createHash('sha256')
        .update(
          await readFile(
            join(root, '../../docs/design/circle-design-system', path),
          ),
        )
        .digest('hex'),
    })),
  );
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        packaged,
        viewport: await readViewport(page),
        checks,
        errors,
        observations,
        layout,
        shots,
        sourceFiles: await sourceEvidence(),
        buildFiles: await rendererEvidence(root),
        designFiles,
        scope:
          'synthetic native UI presentation only; runtime effects and final visual approval are separate',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      packaged,
      samples: observations.length,
      checks: checks.length,
      errors,
    }),
  );
} catch (error) {
  if (page) await captureFailure(page, error, errors, output);
  throw error;
} finally {
  try {
    await app?.close();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
