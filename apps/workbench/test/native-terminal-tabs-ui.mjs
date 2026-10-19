import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  TERMINAL_MODE,
  chooseTerminalMenu,
  openTerminalMode,
  terminalMenuItemEnabled,
} from './helpers/terminal-mode.mjs';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_TERMINAL_TABS_EVIDENCE ??
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-terminal-tabs-')));
await mkdir(output, { recursive: true });
let browser, currentPage;
const cases = [];
const serviceCases = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const theme of ['dark', 'light'])
    for (const locale of ['en', 'zh-CN'])
      for (const viewport of [
        { width: 760, height: 720 },
        { width: 500, height: 520 },
      ]) {
        const page = await browser.newPage({ viewport });
        currentPage = page;
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(
          `${server.resolvedUrls.local[0]}test/native-terminal-tabs-ui.html?theme=${theme}`,
        );
        await openTerminalMode(page);
        await page.evaluate(async (locale) => {
          const { setLanguage } = await import('/src/i18n/index.ts');
          setLanguage(locale);
          const actual = window.circleDesktop.runtimeCommand;
          window.serviceFormCalls = [];
          window.circleDesktop.runtimeCommand = async (command) => {
            window.serviceFormCalls.push(command);
            return actual(command);
          };
        }, locale);
        const text =
          locale === 'zh-CN'
            ? {
                menu: '终端菜单',
                start: '启动服务',
                cancel: '取消',
                add: '添加启动参数',
                port: '就绪端口',
                log: '就绪日志文字',
              }
            : {
                menu: 'terminal menu',
                start: 'start service',
                cancel: 'cancel',
                add: 'add service argument',
                port: 'ready port',
                log: 'ready log text',
              };
        // Start service is an item of the ⋮ menu; its dialog is the one it always was.
        await chooseTerminalMenu(page, text.start, { name: text.menu });
        const dialog = page.getByRole('dialog');
        const footerGeometry = () =>
          dialog.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const fields = element.querySelector('.native-service-fields');
            return {
              viewport: { width: innerWidth, height: innerHeight },
              dialog: box.toJSON(),
              fields: {
                height: fields.clientHeight,
                scrollHeight: fields.scrollHeight,
              },
              buttons: [
                ...element.querySelectorAll('.native-service-actions button'),
              ].map((button) => ({
                text: button.textContent,
                rect: button.getBoundingClientRect().toJSON(),
              })),
            };
          });
        const verifyFooter = (geometry) => {
          assert.equal(geometry.buttons.length, 2);
          for (const button of geometry.buttons) {
            assert.ok(button.rect.top >= geometry.dialog.top);
            assert.ok(button.rect.bottom <= geometry.dialog.bottom);
            assert.ok(button.rect.bottom <= geometry.viewport.height);
            assert.ok(
              button.rect.left >= 0 &&
                button.rect.right <= geometry.viewport.width,
            );
          }
        };
        const initial = await footerGeometry();
        verifyFooter(initial);
        assert.ok(
          initial.fields.scrollHeight > initial.fields.height,
          'short service form scrolls inside the original dialog',
        );
        await page.screenshot({
          path: `${output}/${locale}-${theme}-${viewport.width}x${viewport.height}-service.png`,
        });
        for (let index = 0; index < 8; index++)
          await dialog
            .getByRole('button', { name: text.add, exact: true })
            .click();
        await dialog
          .locator('.native-service-argument input')
          .last()
          .fill('tail argument 中文');
        await dialog.getByLabel(text.port, { exact: true }).fill('43127');
        await dialog
          .getByLabel(text.log, { exact: true })
          .fill('SERVICE_READY');
        const expanded = await footerGeometry();
        verifyFooter(expanded);
        assert.ok(expanded.fields.scrollHeight > expanded.fields.height);
        await page.screenshot({
          path: `${output}/${locale}-${theme}-${viewport.width}x${viewport.height}-service-scrolled.png`,
        });
        await dialog
          .getByRole('button', { name: text.start, exact: true })
          .click();
        await dialog.waitFor({ state: 'hidden' });
        const creates = await page.evaluate(() =>
          window.serviceFormCalls.filter(
            (command) => command.payload?.method === 'create',
          ),
        );
        assert.equal(creates.length, 1);
        assert.equal(creates[0].payload.params.command.file, 'npm');
        assert.deepEqual(creates[0].payload.params.command.args, [
          'run',
          'dev',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          'tail argument 中文',
        ]);
        assert.deepEqual(creates[0].payload.params.readiness, {
          port: 43127,
          pattern: 'SERVICE_READY',
        });
        assert.deepEqual(errors, []);
        serviceCases.push({
          theme,
          locale,
          viewport,
          initial,
          expanded,
          submitted: creates[0].payload.params,
        });
        await page.close();
      }
  for (const theme of ['dark', 'light']) {
    for (const connectionError of [
      'native workspace services are not connected',
      "Error invoking remote method 'circle:runtime-command': Error: runtime not enabled",
    ]) {
      const page = await browser.newPage({
        viewport: { width: 500, height: 720 },
      });
      currentPage = page;
      await page.addInitScript((connectionError) => {
        let host;
        Object.defineProperty(window, 'circleDesktop', {
          configurable: true,
          get: () => host,
          set: (value) => {
            host = value;
            host.runtimeCommand = async () => ({
              ok: false,
              error: connectionError,
            });
          },
        });
      }, connectionError);
      await page.goto(
        `${server.resolvedUrls.local[0]}test/native-terminal-tabs-ui.html?theme=${theme}`,
      );
      await openTerminalMode(page);
      await page.evaluate(async () =>
        (await import('/src/i18n/index.ts')).setLanguage('zh-CN'),
      );
      const alert = page.locator('.native-terminal-error[role="alert"]');
      await alert
        .locator(':scope > span')
        .getByText('未连接', { exact: true })
        .waitFor();
      assert.equal(await alert.locator('details').getAttribute('open'), null);
      await alert.getByText('错误详情', { exact: true }).click();
      assert.equal(await alert.locator('pre').textContent(), connectionError);
      await page.screenshot({
        path: `${output}/zh-CN-${theme}-${connectionError.startsWith('Error') ? 'native' : 'disconnected'}-details.png`,
      });
      serviceCases.push({
        theme,
        locale: 'zh-CN',
        disconnectedSummary: '未连接',
        rawErrorRetained: true,
      });
      await page.close();
    }
  }
  await writeFile(
    `${output}/service-receipt.json`,
    JSON.stringify(
      {
        scope: 'existing terminal component fixture, headless browser only',
        cases: serviceCases,
      },
      null,
      2,
    ),
  );
  for (const theme of ['dark', 'light'])
    for (const width of [375, 760, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      currentPage = page;
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(
        `${server.resolvedUrls.local[0]}test/native-terminal-tabs-ui.html?theme=${theme}`,
      );
      const toggle = page.getByRole('button', {
        name: 'terminal panel',
        exact: true,
      });
      await openTerminalMode(page);
      // What the row asks of the terminal service, in order.
      await page.evaluate(() => {
        const actual = window.circleDesktop.runtimeCommand;
        window.terminalCalls = [];
        window.circleDesktop.runtimeCommand = async (command) => {
          window.terminalCalls.push(command);
          return actual(command);
        };
      });
      const sent = (method) =>
        page.evaluate(
          (method) =>
            window.terminalCalls
              .filter(
                (command) =>
                  command.payload?.service === 'terminal' &&
                  command.payload.method === method,
              )
              .map((command) => command.payload.params),
          method,
        );
      const strip = page.locator('.term-tabs');
      await strip
        .getByRole('tab', { name: 'terminal 9', exact: true })
        .waitFor();
      const names = () =>
        strip
          .locator('.term-tab-main')
          .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
      const geometry = () =>
        strip.evaluate((el) => {
          const selected = el.querySelector('[aria-selected="true"]');
          // A tab is its name and its ×: the row keeps both in view.
          const box = el.getBoundingClientRect(),
            tab = selected.closest('.term-tab').getBoundingClientRect();
          return {
            label: selected.textContent.trim(),
            selected: selected.getAttribute('aria-controls'),
            title: selected.getAttribute('title'),
            left: tab.left,
            right: tab.right,
            viewportLeft: box.left + el.clientLeft,
            viewportRight: box.left + el.clientLeft + el.clientWidth,
            scrollLeft: el.scrollLeft,
            pageX: window.scrollX,
            pageY: window.scrollY,
          };
        });
      const visible = async () => {
        await page.waitForFunction(() => {
          const el = document.querySelector('.term-tabs'),
            main = el?.querySelector('[aria-selected="true"]'),
            tab = main?.closest('.term-tab');
          if (!el || !tab || !el.clientWidth) return false;
          const e = el.getBoundingClientRect(),
            t = tab.getBoundingClientRect();
          const left = e.left + el.clientLeft,
            right = left + el.clientWidth;
          if (t.width <= el.clientWidth)
            return t.left >= left - 1 && t.right <= right + 1;
          // A narrow drawer can be narrower than a whole tab. Require every actual
          // character of its name, not off-screen padding, to fit in that case.
          const range = document.createRange();
          range.selectNodeContents(main.querySelector('.term-tab-label'));
          const label = range.getBoundingClientRect();
          return (
            label.width > 0 &&
            label.left >= left - 1 &&
            label.right <= right + 1
          );
        });
        return geometry();
      };
      const initial = await visible();
      assert.equal(initial.label, 'terminal 9');
      // Process ids are for developers: a running shell shows none. Its tooltip says
      // where it runs and how it is, and a shell at rest has no dot.
      assert.equal(initial.title, '/synthetic/workspace · running');
      assert.doesNotMatch(await page.locator(TERMINAL_MODE).innerText(), /pid/);
      assert.equal(await page.locator('.term-tab.on .term-dot').count(), 0);
      await page
        .getByRole('button', { name: 'new terminal or device', exact: true })
        .click();
      await page.getByRole('menuitem', { name: /^new local terminal/ }).click();
      await strip
        .getByRole('tab', { name: 'terminal 10', exact: true })
        .waitFor();
      const created = await visible();
      assert.equal(created.label, 'terminal 10');
      assert.equal(created.selected, 'terminal-terminal-10');
      assert.equal(
        (await sent('create')).length,
        1,
        'one new terminal makes one shell',
      );
      await page.screenshot({
        path: `${output}/${theme}-${width}-terminal10.png`,
      });
      await page
        .locator('#terminal-terminal-10 .xterm-helper-textarea')
        .focus();
      await page.keyboard.type('TAB_SELECTED_INPUT');
      await page.waitForFunction(() =>
        window.terminalTabsFixture.writes
          .map((item) => item.data)
          .join('')
          .includes('TAB_SELECTED_INPUT'),
      );
      const writes = await page.evaluate(
        () => window.terminalTabsFixture.writes,
      );
      assert.ok(writes.every((item) => item.id === 'terminal-10'));
      assert.match(
        writes.map((item) => item.data).join(''),
        /TAB_SELECTED_INPUT/,
      );
      await page.evaluate(() => window.terminalTabsFixture.deferPaste());
      await page
        .locator('#terminal-terminal-10 .xterm-helper-textarea')
        .evaluate((node) => {
          const data = new DataTransfer();
          data.setData('text/plain', '  preserved paste 中文  ');
          node.dispatchEvent(
            new ClipboardEvent('paste', {
              clipboardData: data,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() =>
        window.terminalTabsFixture.pastePending(),
      );
      assert.equal(
        await page.evaluate(() => window.terminalTabsFixture.writes.length),
        writes.length,
      );
      await page.evaluate(() => window.terminalTabsFixture.releasePaste());
      await page.waitForFunction(
        (start) =>
          window.terminalTabsFixture.writes
            .slice(start)
            .map((row) => row.data)
            .join('') === '\x1b[200~  preserved paste 中文  \x1b[201~\r',
        writes.length,
      );
      // Manual history browsing must survive unrelated live output and status renders.
      await strip.evaluate((el) => {
        el.scrollLeft = 0;
      });
      const manual = await geometry();
      await page.evaluate(() => window.terminalTabsFixture.log());
      await strip
        .locator('.term-tab-main[title^="/synthetic/log-update"]')
        .waitFor();
      const afterLog = await geometry();
      assert.equal(afterLog.scrollLeft, manual.scrollLeft);
      assert.equal(afterLog.selected, created.selected);
      await toggle.click();
      await toggle.click();
      const reopened = await visible();
      assert.equal(reopened.selected, created.selected);
      await page.setViewportSize({
        width: width === 1280 ? 760 : 1280,
        height: 900,
      });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      if ((await toggle.getAttribute('aria-pressed')) !== 'true')
        await toggle.click();
      const resized = await visible();
      assert.equal(resized.selected, created.selected);
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      if ((await toggle.getAttribute('aria-pressed')) !== 'true')
        await toggle.click();
      await visible();
      // Real tab keyboard changes. The shell the service labels debug is a shell like any
      // other: its place among the conversation's shells names it. Each key leaves the
      // keyboard on the tab row, once the shell it shows has its screen, and sends the
      // shells nothing.
      const keyed = (
        await page.evaluate(() => window.terminalTabsFixture.writes)
      ).length;
      const settle = async (id) => {
        await page.waitForFunction(
          (id) =>
            document
              .querySelector('.term-tabs [aria-selected="true"]')
              ?.getAttribute('aria-controls') === `terminal-${id}`,
          id,
        );
        await page
          .locator(`#terminal-${id} .xterm-helper-textarea`)
          .waitFor({ state: 'attached' });
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        assert.deepEqual(
          await page.evaluate(() => ({
            role: document.activeElement?.getAttribute('role'),
            controls: document.activeElement?.getAttribute('aria-controls'),
          })),
          { role: 'tab', controls: `terminal-${id}` },
          'the keyboard stays on the tab row',
        );
        assert.equal(
          (await page.evaluate(() => window.terminalTabsFixture.writes)).length,
          keyed,
          'keys that move between tabs never reach a shell',
        );
        return visible();
      };
      await strip
        .getByRole('tab', { name: 'terminal 10', exact: true })
        .focus();
      await page.keyboard.press('Home');
      const first = await settle('terminal-1');
      assert.equal(first.label, 'terminal 1');
      await page.keyboard.press('ArrowRight');
      const debug = await settle('terminal-2');
      assert.equal(debug.label, 'terminal 2');
      await page.keyboard.press('End');
      const last = await settle('terminal-10');
      assert.equal(last.label, 'terminal 10');
      // A shell's × stops it and takes its tab out of the row; the tab in front stays
      // in front and every other shell keeps its name.
      await page
        .getByRole('button', { name: 'stop terminal 1', exact: true })
        .click();
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll('.term-tab-main')].some(
            (node) => node.textContent.trim() === 'terminal 1',
          ),
      );
      assert.deepEqual(await sent('close'), [{ id: 'terminal-1' }]);
      assert.equal((await geometry()).selected, created.selected);
      assert.deepEqual(
        await names(),
        Array.from({ length: 9 }, (_, index) => `terminal ${index + 2}`),
      );
      assert.deepEqual(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem('circle.workbench.terminal-closed')),
        ),
        ['terminal-1'],
        'the closed tab is remembered',
      );
      // Reload the session list after a real session switch, preserving selected id
      // even when the backend list order changes.
      await page.evaluate(() => window.terminalTabsFixture.reorder());
      if ((await toggle.getAttribute('aria-pressed')) === 'true')
        await toggle.click();
      const chooseSession = async (id) => {
        const link = page.locator(
          `.sidebar:visible [data-row-key="recent:${id}"] .session-link`,
        );
        if (!(await link.isVisible()))
          await page
            .getByRole('button', {
              name: 'show or hide the sidebar',
              exact: true,
            })
            .click();
        await link.click();
      };
      // The row reads A's list again when A is shown again.
      const listsOfA = () =>
        page.evaluate(
          () =>
            window.terminalCalls.filter(
              (command) =>
                command.sessionId === 'A' &&
                command.payload?.service === 'terminal' &&
                command.payload.method === 'list',
            ).length,
        );
      const lists = await listsOfA();
      await chooseSession('B');
      await chooseSession('A');
      await openTerminalMode(page);
      await page.waitForFunction(
        (lists) =>
          window.terminalCalls.filter(
            (command) =>
              command.sessionId === 'A' &&
              command.payload?.service === 'terminal' &&
              command.payload.method === 'list',
          ).length > lists,
        lists,
      );
      const reordered = await visible();
      assert.equal(reordered.selected, created.selected);
      // A shell keeps its name whatever order the service lists it in.
      assert.equal(reordered.label, 'terminal 10');
      assert.equal(
        await strip
          .locator('.term-tab-main')
          .first()
          .getAttribute('aria-controls'),
        'terminal-terminal-10',
        'the row follows the order the service gave',
      );
      await page.screenshot({ path: `${output}/${theme}-${width}.png` });
      assert.equal(reordered.pageX, initial.pageX);
      assert.equal(reordered.pageY, initial.pageY);
      assert.deepEqual(errors, []);
      // A command Circle runs in the background: its tab says the command, with a blue
      // dot, no × while it runs, its stop at the end of the row, and a blue ring.
      await page.evaluate(() =>
        window.terminalTabsFixture.showManagedProcess(),
      );
      const command = strip.getByRole('tab', {
        name: 'node managed-display.cjs',
        exact: true,
      });
      await command.waitFor();
      assert.equal(
        await command.getAttribute('aria-controls'),
        'terminal-terminal-10',
      );
      assert.equal(await command.getAttribute('aria-selected'), 'true');
      assert.equal(
        await command.locator('.term-dot').getAttribute('data-state'),
        'run',
      );
      assert.equal(await page.locator('.term-tab.on .term-tab-x').count(), 0);
      assert.equal(
        await page.locator('.term-frame').getAttribute('data-frame'),
        'run',
      );
      assert.equal(
        await page.locator('.native-service-details').count(),
        0,
        "a command's words are its tab, not a details line",
      );
      assert.equal(
        await toggle.locator('.drawer-mode-badge').textContent(),
        '1',
      );
      assert.equal(
        await terminalMenuItemEnabled(page, 'restart terminal'),
        false,
        'managed command restart remains disabled',
      );
      await page.getByRole('button', { name: 'stop', exact: true }).click();
      const exit = page.locator('.native-terminal-exit');
      await exit.waitFor();
      assert.deepEqual((await sent('close')).at(-1), { id: 'terminal-10' });
      // The ended command keeps its process ids in its tooltip, each named for what it is.
      assert.match(
        await exit.getAttribute('title'),
        /\ncommand pid 52010 · pty pid 51010$/,
      );
      assert.equal(
        (await exit.getAttribute('title')).includes('process pid 51010'),
        false,
        'supervisor PID must not be mislabeled as the actual command',
      );
      await page
        .getByRole('button', {
          name: 'close node managed-display.cjs',
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'stop', exact: true }).count(),
        0,
      );
      await page.reload();
      await openTerminalMode(page);
      const reloaded = await visible();
      assert.equal(reloaded.selected, 'terminal-terminal-9');
      assert.equal(
        (await names()).includes('terminal 1'),
        false,
        'a closed tab stays closed after a reload',
      );
      assert.equal(reloaded.label, 'terminal 9');
      assert.deepEqual(errors, []);
      cases.push({
        theme,
        width,
        initial,
        created,
        manual,
        afterLog,
        reopened,
        resized,
        first,
        debug,
        last,
        reordered,
        reloaded,
      });
      await page.close();
    }
  const focusPage = await browser.newPage();
  currentPage = focusPage;
  await focusPage.goto(
    `${server.resolvedUrls.local[0]}test/native-terminal-tabs-ui.html?target=1`,
  );
  await focusPage
    .getByRole('tab', { name: 'terminal 9', exact: true })
    .waitFor();
  await focusPage.evaluate(() =>
    window.terminalTabsFixture.focusTerminal({
      id: 'terminal-2',
      epoch: 'fixture',
      requestId: 'debug-source-1',
    }),
  );
  await focusPage.waitForFunction(
    () =>
      document
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute('aria-controls') === 'terminal-terminal-2',
  );
  await focusPage.evaluate(() =>
    window.terminalTabsFixture.focusTerminal({
      id: 'terminal-1',
      epoch: 'stale',
      requestId: 'debug-source-2',
    }),
  );
  await focusPage
    .getByRole('alert')
    .getByText('terminal is no longer available', { exact: true })
    .waitFor();
  assert.equal(
    await focusPage
      .locator('[role="tab"][aria-selected="true"]')
      .getAttribute('aria-controls'),
    'terminal-terminal-2',
    'stale epochs cannot select a terminal',
  );
  assert.equal(
    (await focusPage.evaluate(() => window.terminalTabsFixture.observed())).ids
      .length,
    9,
    'focus never creates or restarts a process',
  );
  await focusPage.evaluate(() => window.terminalTabsFixture.focusSession('B'));
  await focusPage.waitForFunction(
    () => document.querySelectorAll('[role="tab"]').length === 0,
  );
  await focusPage.evaluate(() => window.terminalTabsFixture.focusSession('A'));
  await focusPage
    .getByRole('tab', { name: 'terminal 2', exact: true })
    .waitFor();
  await focusPage.waitForFunction(
    () => !document.querySelector('[role="alert"]'),
  );
  assert.equal(
    (await focusPage.evaluate(() => window.terminalTabsFixture.observed())).ids
      .length,
    9,
  );
  await focusPage.close();
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify(
      {
        scope:
          'headless whole CircleWorkbench with actual xterm and controlled terminal bridge; no native desktop operation',
        cases,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  if (currentPage && !currentPage.isClosed()) {
    await currentPage
      .screenshot({ path: `${output}/failure.png` })
      .catch(console.error);
    const geometry = await currentPage
      .evaluate(() => {
        const el = document.querySelector('.term-tabs');
        return {
          tabs: el
            ? {
                scrollLeft: el.scrollLeft,
                width: el.clientWidth,
                tabs: [...el.children].map((tab) => ({
                  selected: tab
                    .querySelector('[role="tab"]')
                    ?.getAttribute('aria-selected'),
                  label: tab.textContent,
                  rect: tab.getBoundingClientRect().toJSON(),
                })),
              }
            : null,
          active: {
            tag: document.activeElement?.tagName,
            role: document.activeElement?.getAttribute('role'),
          },
          text: document.body.innerText,
        };
      })
      .catch((reason) => ({ captureError: String(reason) }));
    await writeFile(
      `${output}/failure.json`,
      JSON.stringify({ error: String(error), geometry }, null, 2),
    ).catch(console.error);
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
