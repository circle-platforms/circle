import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Settings, and the skills, MCP servers, extensions and the rest with them, are one
// dialog over the window: a list of groups at the left, the chosen one at the right,
// every choice applied as it is made. This drives it in the preview, as a person
// would: from the sidebar, from an address and from a slash command.
const output =
  process.env.CIRCLE_UI_EVIDENCE || '/tmp/circle-settings-dialog-ui';
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const base = server.resolvedUrls.local[0];
let browser;
const checks = [];
const settings = (page) => page.locator('.settings-dialog');
// The window answers an address a moment after it changes, so these wait for it.
const headingIs = (page, text) =>
  page.waitForFunction(
    (text) =>
      document.querySelector('.settings-sections h1')?.textContent === text,
    text,
  );
// Another dialog over settings is ready once it has the keyboard; until then an esc may
// reach the dialog under it first, which does not close while one is over it.
const overSettings = async (page, name) => {
  await page.getByRole('dialog', { name, exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      !!document.activeElement?.closest(
        '[role="dialog"]:not(.settings-dialog)',
      ),
  );
};
// A dialog that has just opened is ready for keys once it has taken the focus.
const takenFocus = (page, selector = '[role="dialog"]') =>
  page.waitForFunction(
    (selector) => !!document.activeElement?.closest(selector),
    selector,
  );
const currentIs = (page, text) =>
  page.waitForFunction(
    (text) =>
      document.querySelector('.settings-index [aria-current="page"]')
        ?.textContent === text,
    text,
  );
// A route change commits before the list's scroll effect runs. Measure only
// after the requested section is selected and the list has brought it into view.
const currentInView = (page, text) =>
  page.waitForFunction((text) => {
    const list = document.querySelector('.settings-index-list');
    const current = list?.querySelector('[aria-current="page"]');
    if (!current || current.textContent !== text) return false;
    const a = list.getBoundingClientRect();
    const b = current.getBoundingClientRect();
    return (
      b.left >= a.left - 1 &&
      b.right <= a.right + 1 &&
      b.top >= a.top - 1 &&
      b.bottom <= a.bottom + 1
    );
  }, text);
// What the list shows, group by group, and the heading of the page each opens.
const GROUPS = [
  [
    'general',
    [
      ['appearance', 'appearance', 'appearance'],
      ['sessions', 'behavior', 'sessions'],
      ['shortcuts', 'shortcuts', 'shortcuts'],
      ['help', 'help', 'commands & help'],
      ['about & updates', 'about', 'about & updates'],
      ['launch options', 'launch', 'launch options'],
    ],
  ],
  ['models', [['models & connection', 'models', 'models']]],
  [
    'capabilities',
    [
      ['skills', 'skills', 'skills'],
      ['commands', 'commands', 'commands'],
      ['mcp servers', 'mcp', 'mcp servers'],
      ['extensions', 'extensions', 'extensions'],
      ['tools', 'tools', 'tools'],
      ['hooks', 'hooks', 'hooks'],
    ],
  ],
  [
    'workspace & git',
    [
      ['workspace', 'workspace', 'workspace'],
      ['git', 'git', 'git'],
    ],
  ],
  [
    'permissions & safety',
    [
      ['approvals', 'approvals', 'approvals'],
      ['file access', 'files', 'file access'],
      ['variables & secrets', 'variables', 'variables & secrets'],
    ],
  ],
];
const ZH_LABELS = [
  '外观',
  '会话',
  '快捷键',
  '帮助',
  '关于与更新',
  '启动选项',
  '模型与连接',
  '技能',
  '命令',
  'MCP 服务器',
  '扩展',
  '工具',
  '钩子',
  '工作区',
  'Git',
  '审批',
  '文件访问',
  '变量与密钥',
];
async function open(width, theme, language) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    // A missing icon or font is not what is under test.
    if (
      message.type() === 'error' &&
      !/Failed to load resource/.test(message.text())
    )
      problems.push(message.text());
  });
  await page.addInitScript(
    (language) => localStorage.setItem('circle.workbench.language', language),
    language,
  );
  await page.goto(base + '#/session/session1');
  await page.locator('.composer textarea').waitFor();
  // The theme is chosen where a person chooses it: in the dialog.
  await page.evaluate(() => {
    location.hash = '/page/settings';
  });
  await settings(page).waitFor();
  const zh = language === 'zh-CN';
  await page
    .getByRole('group', { name: zh ? '主题' : 'theme', exact: true })
    .getByRole('button', {
      name: zh ? (theme === 'dark' ? '深色' : '浅色') : theme,
      exact: true,
    })
    .click();
  await page.waitForFunction(
    (theme) => document.documentElement.dataset.theme === theme,
    theme,
  );
  await page.keyboard.press('Escape');
  await settings(page).waitFor({ state: 'detached' });
  return { page, problems };
}
const labelsOf = (page) =>
  page.locator('.settings-index-list button').allTextContents();
const stored = (page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('circle.workbench.preview.v1')).settings,
  );
async function openFromSidebar(page) {
  await page
    .locator('.sidebar-footer')
    .getByRole('button', { name: 'settings', exact: true })
    .click();
  await settings(page).waitFor();
}
async function pick(page, label) {
  await page
    .locator('.settings-index-list')
    .getByRole('button', { name: label, exact: true })
    .click();
  // The list and the page change in one render, so the page is there once it says so.
  await currentIs(page, label);
}
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });

  // --- the window, English, wide ---
  {
    const { page, problems } = await open(1280, 'light', 'en');
    const composer = page.getByRole('textbox', {
      name: 'message',
      exact: true,
    });
    await composer.fill('keep this draft');

    // A shortcut from the composer returns the keyboard to that same field on close.
    await composer.focus();
    const shortcut = await page.evaluate(() =>
      /Mac/.test(navigator.platform) ? 'Meta+,' : 'Control+,',
    );
    await page.keyboard.press(shortcut);
    await settings(page).waitFor();
    await takenFocus(page, '.settings-dialog');
    await page.keyboard.press('Escape');
    await settings(page).waitFor({ state: 'detached' });
    await page.waitForFunction(
      () =>
        document.activeElement === document.querySelector('.composer textarea'),
    );
    await page.keyboard.type(' plus');
    assert.equal(await composer.inputValue(), 'keep this draft plus');
    await composer.fill('keep this draft');
    checks.push('closing settings returns the keyboard to the composer');

    // Search closes after it opens a settings group, so its field is gone by the time
    // settings closes. Return to the window control that opened search instead.
    await composer.focus();
    const searchShortcut = await page.evaluate(() =>
      /Mac/.test(navigator.platform) ? 'Meta+k' : 'Control+k',
    );
    await page.keyboard.press(searchShortcut);
    await page
      .getByRole('textbox', { name: 'global search' })
      .fill('models & connection');
    await page
      .getByRole('button', { name: 'models & connection settings' })
      .click();
    await settings(page).waitFor();
    await takenFocus(page, '.settings-dialog');
    await page.keyboard.press('Escape');
    await settings(page).waitFor({ state: 'detached' });
    await page.waitForFunction(
      () =>
        document.activeElement === document.querySelector('.composer textarea'),
    );
    assert.equal(await composer.inputValue(), 'keep this draft');
    checks.push('settings opened from search returns to the window');

    // Customize is gone from the sidebar, and so is every other entry for the dialog.
    const primary = page.locator('nav.sidebar-primary').first();
    assert.deepEqual(await primary.locator('button, a').allInnerTexts(), [
      'new session',
      'all sessions',
    ]);
    assert.equal(
      await page.getByRole('link', { name: 'customize' }).count(),
      0,
    );
    // The three controls at the end of the footer, in their order.
    assert.deepEqual(
      await page
        .locator('.sidebar-footer-actions button')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('aria-label')),
        ),
      ['search', 'settings', 'hide sidebar'],
    );
    // The top bar has no menu of its own: search, settings, theme, connection and help
    // are in the sidebar and the dialog.
    assert.equal(
      await page
        .locator('header.topbar')
        .getByRole('button', { name: 'more' })
        .count(),
      0,
    );
    checks.push('the sidebar has no customize entry and the top bar no menu');

    await openFromSidebar(page);
    assert.equal(await page.evaluate(() => location.hash), '#/page/settings');
    assert.equal(
      await page.getByRole('dialog', { name: 'settings', exact: true }).count(),
      1,
    );
    // The groups, under their headings, in order.
    assert.deepEqual(
      await page.locator('.settings-group-label').allTextContents(),
      GROUPS.map(([group]) => group),
    );
    assert.deepEqual(
      await labelsOf(page),
      GROUPS.flatMap(([, items]) => items.map(([label]) => label)),
    );
    // What is not there: GitHub has no group of its own, nor has anything that was
    // the old page's.
    for (const gone of ['github', 'customize', 'keyboard', 'session defaults'])
      assert.equal(
        (await labelsOf(page)).some((label) => label.toLowerCase() === gone),
        false,
        `${gone} is no group`,
      );
    await currentIs(page, 'appearance');
    checks.push('the dialog lists the groups under their headings');

    // Each group opens in the dialog, with its own address, and the window stays behind.
    for (const [, items] of GROUPS)
      for (const [label, id, heading] of items) {
        await pick(page, label);
        await page.waitForFunction(
          (id) => location.hash === '#/page/' + id,
          id,
        );
        await headingIs(page, heading);
        await currentIs(page, label);
        assert.equal(await settings(page).count(), 1);
      }
    checks.push('every group opens its page inside the dialog');

    // Appearance applies as it is clicked: there is nothing to save.
    await pick(page, 'appearance');
    await page
      .getByRole('group', { name: 'theme', exact: true })
      .getByRole('button', { name: 'dark', exact: true })
      .click();
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === 'dark',
    );
    assert.equal((await stored(page)).theme, 'dark');
    await page
      .getByRole('group', { name: 'theme', exact: true })
      .getByRole('button', { name: 'light', exact: true })
      .click();
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === 'light',
    );
    assert.equal(await page.getByRole('button', { name: /^save/ }).count(), 0);
    checks.push('a choice applies at once and nothing asks to be saved');

    // Sessions: the double Esc alone, with no model setting among them.
    await pick(page, 'sessions');
    await page
      .getByRole('group', { name: 'double Esc', exact: true })
      .getByRole('button', { name: 'fork the session', exact: true })
      .click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem('circle.workbench.preview.v1')).settings
          .doubleEscape === 'fork',
    );
    assert.equal(
      await page
        .locator('.settings-sections')
        .getByText(/thinking depth|model/i)
        .count(),
      0,
      'a session has no model setting',
    );

    // Models: the default model and thinking depth are here, with the connection.
    await pick(page, 'models & connection');
    const defaults = page
      .locator('.settings-sections section.settings-block')
      .filter({
        has: page.getByRole('heading', {
          name: 'defaults for new sessions',
          exact: true,
        }),
      });
    await defaults
      .getByRole('group', { name: 'thinking depth', exact: true })
      .getByRole('button', { name: 'low', exact: true })
      .click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem('circle.workbench.preview.v1')).settings
          .defaultEffort === 'low',
    );
    assert.ok(
      (await defaults.innerText()).includes((await stored(page)).defaultModel),
      'the default model is named',
    );
    await page
      .locator('.settings-sections')
      .getByRole('button', { name: 'connection', exact: true })
      .waitFor();
    checks.push('the model, its depth and the connection are one group');

    // Git: crediting Circle is its own switch, and not the version's.
    await pick(page, 'git');
    const credit = page.getByRole('checkbox', {
      name: 'credit Circle in commits and pull requests',
      exact: true,
    });
    const before = (await stored(page)).attribution;
    await credit.setChecked(!before);
    await page.waitForFunction(
      (before) =>
        JSON.parse(localStorage.getItem('circle.workbench.preview.v1')).settings
          .attribution !== before,
      before,
    );
    await credit.setChecked(false);
    assert.equal(
      await page
        .locator('.settings-sections')
        .getByText(/^When enabled in a Git repository/)
        .isVisible(),
      true,
      'credit is conditional and the author follows the attribution setting',
    );
    await credit.setChecked(before);
    await pick(page, 'about & updates');
    assert.equal(
      await page.getByRole('checkbox', { name: /credit Circle/ }).count(),
      0,
    );
    await page
      .getByRole('checkbox', { name: 'check for updates', exact: true })
      .waitFor();
    checks.push('crediting Circle is under git, not about');

    // Extensions: GitHub is one, and its details open in the dialog too.
    await pick(page, 'extensions');
    await page
      .locator('.settings-sections')
      .getByRole('button', { name: 'interface components', exact: true })
      .click();
    await page
      .locator('.settings-sections')
      .getByRole('link', { name: 'plugin details', exact: true })
      .click();
    await page.waitForFunction(
      () => location.hash === '#/page/extensions?plugin=github',
    );
    await headingIs(page, 'GitHub');
    await currentIs(page, 'extensions');
    assert.equal(await settings(page).count(), 1);
    await page
      .locator('.settings-sections')
      .getByRole('button', { name: 'back to plugins', exact: true })
      .click();
    await page.waitForFunction(() => location.hash === '#/page/extensions');
    await headingIs(page, 'extensions');
    checks.push('an extension and its details stay inside the dialog');

    // Another dialog from a page opens over settings, and closes alone.
    await pick(page, 'mcp servers');
    await page
      .locator('.settings-sections')
      .getByRole('button', { name: 'add server', exact: true })
      .click();
    await overSettings(page, 'server configuration');
    await page.keyboard.press('Escape');
    await page
      .getByRole('dialog', { name: 'server configuration', exact: true })
      .waitFor({ state: 'detached' });
    assert.equal(await settings(page).count(), 1, 'settings stay open');
    assert.equal(await page.evaluate(() => location.hash), '#/page/mcp');
    // The keyboard goes back to what opened the dialog, inside settings.
    await page.waitForFunction(
      () => document.activeElement?.textContent?.trim() === 'add server',
    );
    await pick(page, 'file access');
    assert.equal(
      await page
        .locator('.settings-sections')
        .getByText(/Commands that reach a file indirectly are not blocked/)
        .isVisible(),
      true,
      'the name-based protection does not promise to block indirect commands',
    );
    await page
      .locator('.settings-sections')
      .getByRole('button', { name: 'manage external file access', exact: true })
      .click();
    await overSettings(page, 'external file access');
    await page.keyboard.press('Escape');
    await page
      .getByRole('dialog', { name: 'external file access', exact: true })
      .waitFor({ state: 'detached' });
    assert.equal(await settings(page).count(), 1);
    await page.waitForFunction(
      () =>
        document.activeElement?.textContent?.trim() ===
        'manage external file access',
    );
    checks.push(
      'a dialog opened from a page is over settings, closes alone and gives the keyboard back',
    );

    // The search narrows the list; enter opens the first match; esc empties it first.
    const search = page.getByRole('textbox', {
      name: 'search settings',
      exact: true,
    });
    await search.fill('github');
    assert.deepEqual(await labelsOf(page), ['extensions']);
    await search.press('Enter');
    await page.waitForFunction(() => location.hash === '#/page/extensions');
    await search.press('Escape');
    assert.equal(await search.inputValue(), '');
    assert.equal(
      await settings(page).count(),
      1,
      'esc emptied the search only',
    );
    await search.fill('commits');
    assert.deepEqual(await labelsOf(page), ['git']);
    await search.fill('keyboard');
    assert.deepEqual(await labelsOf(page), ['shortcuts']);
    await search.fill('thinking');
    assert.deepEqual(await labelsOf(page), ['sessions', 'models & connection']);
    await search.press('Escape');

    // Outside the dialog, or esc, leaves settings: back to the window as it was.
    await page.mouse.click(4, 4);
    await settings(page).waitFor({ state: 'detached' });
    await page.waitForFunction(() => location.hash === '#/session/session1');
    assert.equal(await composer.inputValue(), 'keep this draft');
    await openFromSidebar(page);
    await pick(page, 'tools');
    await page.keyboard.press('Escape');
    await settings(page).waitFor({ state: 'detached' });
    await page.waitForFunction(() => location.hash === '#/session/session1');
    assert.equal(await composer.inputValue(), 'keep this draft');
    checks.push(
      'a click outside, or esc, closes settings and keeps the window',
    );

    // An address opens a group, with what follows the path kept.
    await page.evaluate(() => {
      location.hash = '/page/extensions?plugin=github';
    });
    await settings(page).waitFor();
    await headingIs(page, 'GitHub');
    await takenFocus(page, '.settings-dialog');
    await page.keyboard.press('Escape');
    await settings(page).waitFor({ state: 'detached' });
    // A slash command opens its own group.
    await composer.fill('/hooks');
    await page.getByRole('option', { name: /\/hooks/ }).waitFor();
    await composer.press('Enter');
    await page.waitForFunction(() => location.hash === '#/page/hooks');
    await currentIs(page, 'hooks');
    await takenFocus(page, '.settings-dialog');
    await page.keyboard.press('Escape');
    await settings(page).waitFor({ state: 'detached' });
    await composer.fill('/themes');
    await page.getByRole('option', { name: /\/themes/ }).waitFor();
    await composer.press('Enter');
    await page.waitForFunction(() => location.hash === '#/page/appearance');
    await currentIs(page, 'appearance');
    await takenFocus(page, '.settings-dialog');
    await page.keyboard.press('Escape');
    await settings(page).waitFor({ state: 'detached' });
    checks.push('an address and a slash command open the group they name');

    // Help runs a command in view of the conversation, not behind the dialog.
    await page.evaluate(() => {
      location.hash = '/page/help';
    });
    await settings(page).waitFor();
    await page
      .locator('.settings-sections .command-table')
      .getByRole('button', { name: /^\/hotkeys/ })
      .click();
    await settings(page).waitFor({ state: 'detached' });
    await page
      .getByRole('dialog', { name: 'keyboard shortcuts', exact: true })
      .waitFor();
    await takenFocus(page);
    await page.keyboard.press('Escape');
    // ...but a command for another group stays in the dialog.
    await page.evaluate(() => {
      location.hash = '/page/help';
    });
    await settings(page).waitFor();
    await page
      .locator('.settings-sections .command-table')
      .getByRole('button', { name: /^\/themes/ })
      .click();
    await page.waitForFunction(() => location.hash === '#/page/appearance');
    assert.equal(await settings(page).count(), 1);
    await page.keyboard.press('Escape');
    checks.push('a help command acts in view, or opens its group');
    await page.screenshot({ path: join(output, 'window-light.png') });
    assert.deepEqual(problems, []);
    await page.close();
  }

  // An application-menu action can open settings while a different dialog is already
  // open. The dialog underneath must not trap settings or close with it.
  {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const problems = [];
    page.on('pageerror', (error) => problems.push(String(error)));
    await page.addInitScript(() => {
      localStorage.setItem('circle.workbench.language', 'en');
      window.circleDesktop = new Proxy(
        {
          info: async () => ({
            frontendOnly: true,
            platform: 'darwin',
            language: 'en',
          }),
          onAction: (listener) => {
            window.testMenuAction = listener;
            return () => {};
          },
          browserState: async () => ({ sessionId: 'none' }),
          popouts: async () => [],
        },
        {
          get: (target, key) =>
            key in target
              ? target[key]
              : () =>
                  key.toString().startsWith('on')
                    ? () => {}
                    : Promise.resolve(),
        },
      );
    });
    await page.goto(base + '#/session/session1');
    await page.locator('.composer textarea').waitFor();
    await page.locator('.sidebar-footer .connection-status').click();
    const underneath = page.getByRole('dialog', {
      name: 'frontend preview',
      exact: true,
    });
    await underneath.waitFor();
    await page.evaluate(() => window.testMenuAction('settings'));
    await settings(page).waitFor();
    await takenFocus(page, '.settings-dialog');
    await settings(page).getByRole('button', { name: 'close dialog' }).click();
    await settings(page).waitFor({ state: 'detached' });
    assert.equal(await underneath.count(), 1);
    await page.waitForFunction(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    );
    await page.keyboard.press('Escape');
    await underneath.waitFor({ state: 'detached' });
    assert.deepEqual(problems, []);
    await page.close();
    checks.push('a dialog below settings does not trap it');
  }

  // --- both themes, a Chinese window and a narrow one ---
  for (const [width, theme, language] of [
    [1280, 'dark', 'en'],
    [1280, 'light', 'zh-CN'],
    [1280, 'dark', 'zh-CN'],
    [640, 'light', 'en'],
    [640, 'dark', 'zh-CN'],
  ]) {
    const { page, problems } = await open(width, theme, language);
    await page.evaluate(() => {
      location.hash = '/page/settings';
    });
    await settings(page).waitFor();
    const narrow = width <= 720;
    if (language === 'zh-CN')
      assert.deepEqual(await labelsOf(page), ZH_LABELS, 'the list in Chinese');
    if (language === 'zh-CN' && width === 1280 && theme === 'light') {
      await pick(page, '关于与更新');
      await page.getByText('浏览器布局预览', { exact: true }).waitFor();
      await page.getByText('仅此浏览器', { exact: true }).waitFor();
      await page.getByRole('button', { name: '立即检查', exact: true }).click();
      await page.getByText('检查更新需要桌面应用', { exact: true }).waitFor();
      await pick(page, '启动选项');
      await page
        .getByRole('heading', { name: '启动选项', exact: true })
        .waitFor();
      await page
        .getByRole('textbox', { name: '启动参数', exact: true })
        .fill('--mode rpc');
      await page.getByRole('button', { name: '保存启动草稿' }).click();
      await page
        .getByText('启动草稿已保存，未启动进程', { exact: true })
        .waitFor();
      await page.waitForFunction(() => {
        const snapshot = JSON.parse(
          localStorage.getItem('circle.workbench.preview.v1') ?? 'null',
        );
        return snapshot?.requests?.some(
          (request) =>
            request.kind === 'launch-options' &&
            request.payload.arguments === '--mode rpc',
        );
      });
      await page.screenshot({ path: join(output, 'launch-zh-CN-1280.png') });
      checks.push('Chinese launch draft records the requested arguments');
    }
    // Wide, the list is a column under headings; narrow, one row to scroll along.
    assert.equal(
      await page
        .locator('.settings-index-list')
        .evaluate((node) => getComputedStyle(node).flexDirection),
      narrow ? 'row' : 'column',
    );
    // Every group fits the dialog: nothing makes the window scroll sideways, and the
    // chosen group's name is in view in the list.
    for (const id of [
      'models',
      'extensions',
      'hooks',
      'workspace',
      'git',
      'files',
      'variables',
    ]) {
      const sections = GROUPS.flatMap(([, entries]) => entries);
      const index = sections.findIndex((entry) => entry[1] === id);
      assert.notEqual(index, -1, `known settings section ${id}`);
      const label =
        language === 'zh-CN' ? ZH_LABELS[index] : sections[index][0];
      await page.evaluate((id) => {
        location.hash = '/page/' + id;
      }, id);
      await page.waitForFunction((id) => location.hash === '#/page/' + id, id);
      await page.locator('.settings-sections h1').first().waitFor();
      await currentIs(page, label);
      await currentInView(page, label);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `${id} fits at ${width}px`,
      );
      const inView = await page.evaluate(() => {
        const list = document.querySelector('.settings-index-list');
        const current = list.querySelector('[aria-current="page"]');
        const a = list.getBoundingClientRect();
        const b = current.getBoundingClientRect();
        return (
          b.left >= a.left - 1 &&
          b.right <= a.right + 1 &&
          b.top >= a.top - 1 &&
          b.bottom <= a.bottom + 1
        );
      });
      assert.equal(inView, true, `${id} is in view in the list at ${width}px`);
      const box = await page.locator('.settings-dialog').boundingBox();
      assert.ok(
        box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1,
        'the dialog is inside the window',
      );
    }
    await page.screenshot({
      path: join(output, `${theme}-${language}-${width}.png`),
    });
    assert.deepEqual(problems, []);
    await page.close();
  }
  checks.push('both themes, English and Chinese, wide and narrow');
  console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
