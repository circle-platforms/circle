import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// The right-hand column: the overview pinned beside the conversation and the drawer's mode
// beside the overview, the drawer's edge dragged, the overview stepping aside when the
// conversation would be squeezed and coming back when there is room, and the same in a
// narrow window, where each lies over the conversation. The composer and the modes keep
// their DOM, and the conversation its reading position, through all of it.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
let browser;
let activePage;
const output =
  process.env.CIRCLE_WORKSPACE_LAYOUT_EVIDENCE ||
  '/tmp/circle-workspace-layout';
await mkdir(output, { recursive: true });
const receipts = [];
const MIN_CONVERSATION = 420;
const OVERVIEW = 380;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({
      viewport: { width: 1680, height: 950 },
    });
    page.setDefaultTimeout(8000);
    activePage = page;
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/response-readability-ui.html?theme=${theme}#/session/session1`,
    );
    const input = page.getByRole('textbox', { name: 'message', exact: true });
    await input.waitFor();
    await input.fill('layout retained draft');
    await input.evaluate((el) => el.setSelectionRange(3, 11));
    const inputOwner = await input.elementHandle();
    const geometry = () =>
      page.evaluate(() => {
        const rect = (selector) => {
          const node = document.querySelector(selector);
          if (!node || !node.getClientRects().length) return null;
          const box = node.getBoundingClientRect();
          return { left: box.left, width: box.width, right: box.right };
        };
        const columns = document.getElementById('workbench-columns');
        return {
          mode: columns.dataset.inspectorMode,
          group: rect('#workbench-columns'),
          main: rect('#main'),
          cluster: rect('.inspector-column'),
          overview: rect('.overview-column'),
          drawer: rect('.work-drawer'),
          handle: rect('.cluster-handle'),
        };
      });
    // The layout settles over a frame or two: wait for what is asked, then look.
    const settled = async (what, check) => {
      await page
        .waitForFunction(
          ([source]) => new Function('g', `return (${source})(g)`),
          [check.toString()],
        )
        .catch(() => {});
      const stop = Date.now() + 6000;
      for (;;) {
        const actual = await geometry();
        if (check(actual)) return actual;
        if (Date.now() > stop)
          throw Error(`${what}: ${JSON.stringify(actual)}`);
        await page.waitForTimeout(40);
      }
    };
    const tight = (g) => {
      // The conversation, the overview and the drawer fill the group with no gap
      const used =
        g.main.width +
        (g.overview?.width ?? 0) +
        (g.drawer?.width ?? 0) +
        (g.handle?.width ?? 0) +
        (g.overview ? 1 : 0);
      return Math.abs(g.group.width - used) <= 3;
    };
    await page.evaluate(() =>
      window.readabilityFixture.runtime.change((state) => {
        state.sessions[0].messages[0].text +=
          '\n\n' +
          Array.from(
            { length: 60 },
            (_, i) => `Retained reading paragraph ${i}.`,
          ).join('\n\n');
      }),
    );
    await page.waitForFunction(() => {
      const el = document.querySelector('.transcript');
      return el.scrollHeight > el.clientHeight + 500;
    });
    const transcript = page.locator('.transcript');
    await transcript.hover();
    await page.mouse.wheel(0, -600);
    await page.waitForFunction(() => {
      const el = document.querySelector('.transcript');
      return (
        el.scrollTop > 0 &&
        el.scrollTop < el.scrollHeight - el.clientHeight - 50
      );
    });
    const reading = await transcript.evaluate((el) => el.scrollTop);

    // 1680 wide: the overview is there from the start, and a mode opens beside it.
    const first = await settled(
      'the overview alone',
      (g) => g.overview && !g.drawer && g.main.width >= MIN_CONVERSATION,
    );
    assert.ok(Math.abs(first.overview.width - OVERVIEW) <= 2);
    assert.equal(first.mode, 'split');
    await page.screenshot({ path: `${output}/${theme}-1680-overview.png` });
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    const both = await settled(
      'the overview and the terminal',
      (g) => g.overview && g.drawer && tight(g),
    );
    assert.ok(both.drawer.width >= 500 && both.drawer.width <= 545);
    assert.ok(both.main.width >= MIN_CONVERSATION);
    const resource = await page
      .locator('[data-inspector-resource="terminal"] .term-tabbar')
      .elementHandle();
    await page.screenshot({ path: `${output}/${theme}-1680-both.png` });

    // The drawer's own edge is dragged. Widened past what the conversation can spare beside
    // the overview, it takes the overview's room: the overview steps aside.
    const handle = page.getByRole('separator', {
      name: 'resize inspector',
      exact: true,
    });
    const dragBy = async (dx) => {
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + 200, {
        steps: 12,
      });
      await page.mouse.up();
    };
    await dragBy(-60);
    const wider = await settled(
      'a wider drawer',
      (g) => g.drawer && g.overview && g.drawer.width > both.drawer.width + 40,
    );
    assert.ok(wider.main.width >= MIN_CONVERSATION - 1);
    await dragBy(-400);
    const aside = await settled(
      'the overview steps aside',
      (g) => g.drawer && !g.overview && g.main.width >= MIN_CONVERSATION - 1,
    );
    assert.ok(
      aside.drawer.width > wider.drawer.width,
      'the drawer took the room',
    );
    assert.ok(
      aside.main.width <= MIN_CONVERSATION + 40,
      'the conversation keeps its least',
    );
    await page.screenshot({ path: `${output}/${theme}-1680-aside.png` });
    // Narrowed again, with room and a little over, the overview comes back by itself.
    await dragBy(450);
    const back = await settled(
      'the overview comes back',
      (g) => g.drawer && g.overview && tight(g),
    );
    assert.ok(back.main.width >= MIN_CONVERSATION - 1);
    // Keys move the edge too.
    await handle.focus();
    const before = (await geometry()).drawer.width;
    await page.keyboard.press('ArrowLeft');
    await settled('a key widens it', (g) => g.drawer.width > before + 8);
    await page.keyboard.press('ArrowRight');
    await settled('a key narrows it', (g) => g.drawer.width <= before + 2);

    // Closing the mode, and opening it again, leave the width, the terminal and the reading
    // position where they were; Escape closes it and the overview stays.
    const width = (await geometry()).drawer.width;
    for (let i = 0; i < 3; i++) {
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      const closed = await settled(
        'the mode closed',
        (g) => !g.drawer && g.overview,
      );
      assert.ok(closed.main.width >= MIN_CONVERSATION);
      assert.ok(
        Math.abs((await transcript.evaluate((el) => el.scrollTop)) - reading) <=
          2,
        'the reading position stays',
      );
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      const reopened = await settled(
        'the mode again',
        (g) => g.drawer && g.overview && tight(g),
      );
      assert.ok(
        Math.abs(reopened.drawer.width - width) <= 2,
        'the width the person left is kept',
      );
      assert.equal(await resource.evaluate((el) => el.isConnected), true);
    }
    // Escape, from inside the drawer's own window, closes the mode.
    await handle.focus();
    await page.keyboard.press('Escape');
    await settled('escape closes the mode', (g) => !g.drawer && g.overview);

    // The overview closed by hand stays closed, whatever room there is.
    await page
      .getByRole('button', { name: 'overview panel', exact: true })
      .click();
    const none = await settled(
      'no overview',
      (g) => !g.overview && !g.drawer && g.mode === 'closed',
    );
    assert.equal(none.cluster, null);
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    await settled('a mode alone', (g) => g.drawer && !g.overview && tight(g));
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    await settled('still no overview', (g) => !g.drawer && !g.overview);
    await page
      .getByRole('button', { name: 'overview panel', exact: true })
      .click();
    await settled('the overview asked for', (g) => g.overview && !g.drawer);

    // 1280 wide, with the sidebar: the conversation, the overview and a mode do not all fit,
    // so the mode wins, and the overview that stepped aside returns with the room.
    await page.setViewportSize({ width: 1280, height: 950 });
    await settled('the overview alone at 1280', (g) => g.overview && !g.drawer);
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    const narrowish = await settled(
      'the mode wins at 1280',
      (g) =>
        g.drawer &&
        !g.overview &&
        tight(g) &&
        g.main.width >= MIN_CONVERSATION - 1,
    );
    assert.ok(narrowish.drawer.width >= 290);
    // The terminal is as tall as the drawer below its tab row, not as tall as its rows.
    await page.waitForFunction(() => {
      const drawer = document.querySelector('.work-drawer');
      const terminal = document.querySelector(
        '[data-inspector-resource="terminal"] .native-terminal',
      );
      if (!drawer || !terminal) return false;
      const outer = drawer.getBoundingClientRect();
      const inner = terminal.getBoundingClientRect();
      return inner.height > 0 && outer.bottom - inner.bottom <= 2;
    });
    await page.screenshot({ path: `${output}/${theme}-1280-mode.png` });
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    await settled('the overview is back', (g) => g.overview && !g.drawer);
    // Asking for the overview beside a mode that is too wide gives the mode room or closes it.
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    await settled('the mode again', (g) => g.drawer && !g.overview);
    await page
      .getByRole('button', { name: 'overview panel', exact: true })
      .click();
    await settled(
      'the overview beside what fits, or alone',
      (g) => g.overview && tight(g) && g.main.width >= MIN_CONVERSATION - 1,
    );

    // A file that is open takes 760 pixels: where the sidebar's room gives it that beside the
    // conversation, the sidebar folds, and it unfolds when the file closes.
    await input.focus();
    await page.keyboard.press('ControlOrMeta+p');
    const search = page.getByRole('textbox', {
      name: 'global search',
      exact: true,
    });
    await search.fill('task-model');
    await search.press('Enter');
    const opened = await settled(
      'the file at 760',
      (g) =>
        g.drawer &&
        g.drawer.width >= 700 &&
        g.main.width >= MIN_CONVERSATION - 1,
    );
    assert.equal(
      await page.locator('.workbench.sidebar-collapsed').count(),
      1,
      'the sidebar folded for the file',
    );
    assert.ok(
      opened.group.width >= 1270,
      "the workspace took the sidebar's room",
    );
    await page.screenshot({ path: `${output}/${theme}-1280-file.png` });
    // The person shows the sidebar again beside the file: it stays, and the file has the
    // room that is left.
    const sidebarButton = page.getByRole('button', {
      name: 'show or hide the sidebar',
      exact: true,
    });
    await sidebarButton.click();
    await settled(
      'the sidebar shown by hand beside the file',
      (g) => g.group.width < 1100 && g.drawer && g.main.width > 0,
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    assert.equal(
      await page.locator('.workbench.sidebar-collapsed').count(),
      0,
      'a sidebar shown by hand is not folded again under the person',
    );
    await page.getByRole('button', { name: 'close file', exact: true }).click();
    await settled('the sidebar is back', (g) => g.group.width < 1100);
    assert.equal(await page.locator('.workbench.sidebar-collapsed').count(), 0);
    // A sidebar the person folded by hand stays as they left it, whatever the file does.
    await sidebarButton.click();
    await page.waitForFunction(() =>
      document.querySelector('.workbench.sidebar-collapsed'),
    );
    await input.focus();
    await page.keyboard.press('ControlOrMeta+p');
    await search.fill('task-model');
    await search.press('Enter');
    await settled('the file again', (g) => g.drawer && g.drawer.width >= 700);
    await page.getByRole('button', { name: 'close file', exact: true }).click();
    await settled('the file closed', (g) => !g.drawer || g.drawer.width < 700);
    assert.equal(
      await page.locator('.workbench.sidebar-collapsed').count(),
      1,
      'a sidebar folded by hand is not unfolded for the person',
    );
    await sidebarButton.click();
    await page.waitForFunction(
      () => !document.querySelector('.workbench.sidebar-collapsed'),
    );

    // A narrow window: each lies over the conversation, one at a time.
    const overlays = [];
    for (const narrow of [500, 375, 500, 375]) {
      await page.setViewportSize({ width: narrow, height: 950 });
      await settled('closed when narrow', (g) => !g.drawer);
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      const over = await settled(
        'the terminal over the conversation',
        (g) => g.mode === 'overlay' && g.drawer,
      );
      assert.ok(
        over.drawer.width > 250 &&
          over.drawer.left >= -1 &&
          over.drawer.right <= narrow + 1,
      );
      assert.equal(await resource.evaluate((el) => el.isConnected), true);
      await page
        .getByRole('button', { name: 'overview panel', exact: true })
        .click();
      const ov = await settled(
        'the overview in its place',
        (g) => g.mode === 'overlay' && g.overview && !g.drawer,
      );
      assert.ok(ov.overview.right <= narrow + 1);
      overlays.push({ over, ov });
      await page.screenshot({
        path: `${output}/${theme}-${narrow}-overview.png`,
      });
      await page
        .getByRole('button', { name: 'overview panel', exact: true })
        .click();
      await settled('nothing over it', (g) => !g.overview && !g.drawer);
    }
    // Still narrow: a file opened from the overview, here an instruction file of the
    // context card, takes the overview's place with the room the overview had.
    await page.evaluate(() =>
      window.readabilityFixture.runtime.change((state) => {
        const session = state.sessions[0];
        const workspace = state.workspaces.find(
          (item) => item.id === session.workspaceId,
        );
        workspace.instructions = [
          {
            name: 'AGENTS.md',
            path: `${workspace.path}/AGENTS.md`,
            content: '# project instructions',
          },
        ];
        state.files.push({
          id: 'layout-instructions',
          workspaceId: session.workspaceId,
          path: 'AGENTS.md',
          content: '# project instructions\n\nKeep changes scoped.\n',
          language: 'markdown',
        });
      }),
    );
    await page
      .getByRole('button', { name: 'overview panel', exact: true })
      .click();
    await settled(
      'the overview over the conversation',
      (g) => g.mode === 'overlay' && g.overview && !g.drawer,
    );
    const contextHeading = page.locator('#overview-context button');
    if ((await contextHeading.getAttribute('aria-expanded')) !== 'true')
      await contextHeading.click();
    await page
      .locator('#overview-context-body .overview-link')
      .filter({ hasText: 'AGENTS.md' })
      .click();
    const instruction = await settled(
      "the instruction file in the overview's place",
      (g) =>
        g.mode === 'overlay' && !g.overview && g.drawer && g.drawer.width > 250,
    );
    assert.ok(instruction.drawer.right <= 376);
    await page
      .locator('.work-drawer .file-view')
      .getByText('AGENTS.md', { exact: true })
      .first()
      .waitFor();
    await page.getByRole('button', { name: 'close file', exact: true }).click();
    await settled('nothing over it again', (g) => !g.overview && !g.drawer);
    // Narrow, but with the sidebar still beside the workspace: a file that is open over
    // the conversation takes the sidebar's room too, and gives it back when it closes.
    await page.setViewportSize({ width: 900, height: 950 });
    await settled(
      'the sidebar beside a narrow workspace',
      (g) => g.group.width < 700 && !g.drawer,
    );
    await input.focus();
    await page.keyboard.press('ControlOrMeta+p');
    await search.fill('task-model');
    await search.press('Enter');
    const narrowFile = await settled(
      'the file over the conversation, with the sidebar folded',
      (g) => g.mode === 'overlay' && g.drawer && g.drawer.width >= 890,
    );
    assert.ok(narrowFile.drawer.right <= 901);
    assert.equal(
      await page.locator('.workbench.sidebar-collapsed').count(),
      1,
      'the sidebar folded for the file in a narrow window',
    );
    await page.getByRole('button', { name: 'close file', exact: true }).click();
    await settled(
      'the sidebar back beside the narrow workspace',
      (g) => g.group.width < 700,
    );
    assert.equal(await page.locator('.workbench.sidebar-collapsed').count(), 0);
    await page.setViewportSize({ width: 1680, height: 950 });
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    await settled(
      'split again',
      (g) => g.drawer && g.mode === 'split' && tight(g),
    );
    assert.equal(await resource.evaluate((el) => el.isConnected), true);
    assert.equal(await inputOwner.evaluate((el) => el.isConnected), true);
    assert.equal(await input.inputValue(), 'layout retained draft');
    assert.deepEqual(
      await input.evaluate((el) => [el.selectionStart, el.selectionEnd]),
      [3, 11],
    );
    assert.deepEqual(errors, []);
    receipts.push({ theme, first, both, aside, back, overlays, passed: true });
    await page.close();
  }
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify({ passed: true, native: false, receipts }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, output }));
} catch (error) {
  await activePage
    ?.screenshot({ path: `${output}/failure.png` })
    .catch(() => {});
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify({ passed: false, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
