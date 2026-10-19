// The terminal mode as the window has it now: a mode of the work drawer that its top-bar
// button opens and a second press closes, one row of tabs, and the ⋮ menu that holds
// find, add selection to chat, copy complete output, restart, interrupt and start service.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** The drawer's terminal mode; harnesses that mount the terminal alone have no drawer. */
export const TERMINAL_MODE =
  '.work-drawer [data-inspector-resource="terminal"]';

/** Open the terminal mode without closing one that is already open. */
export async function openTerminalMode(page, { name = 'terminal panel' } = {}) {
  const toggle = page.getByRole('button', { name, exact: true });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true')
    await toggle.click();
  const panel = page.locator(`${TERMINAL_MODE} .native-terminal:visible`);
  await panel.waitFor();
  return panel;
}

/** Close it as a person does: its top-bar button, pressed again. */
export async function closeTerminalMode(
  page,
  { name = 'terminal panel' } = {},
) {
  const toggle = page.getByRole('button', { name, exact: true });
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await toggle.click();
  await page
    .locator(`${TERMINAL_MODE} .native-terminal`)
    .first()
    .waitFor({ state: 'hidden' });
}

/** Open the ⋮ menu of the tab in front; its items are in a portal, not in the panel. */
export async function openTerminalMenu(page, { name = 'terminal menu' } = {}) {
  await page.getByRole('button', { name, exact: true }).click();
  const menu = page.getByRole('menu');
  await menu.waitFor();
  return menu;
}

/**
 * Wait for a closed menu to let go of the keyboard. It gives the keyboard back to its
 * button from a timer queued as it unmounts, so the next step's own focus is not taken
 * away after it was set.
 */
async function menuClosed(page, menu) {
  await menu.waitFor({ state: 'detached' });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () => requestAnimationFrame(() => setTimeout(resolve, 0)),
          0,
        ),
      ),
  );
}

/** Choose one item of the ⋮ menu, and wait for the menu to close. */
export async function chooseTerminalMenu(page, item, options) {
  const menu = await openTerminalMenu(page, options);
  await menu.getByRole('menuitem', { name: item, exact: true }).click();
  await menuClosed(page, menu);
}

/** Whether a ⋮ menu item can be chosen; the menu is closed again with Escape. */
export async function terminalMenuItemEnabled(page, item, options) {
  const menu = await openTerminalMenu(page, options);
  const enabled = await menu
    .getByRole('menuitem', { name: item, exact: true })
    .isEnabled();
  await page.keyboard.press('Escape');
  await menuClosed(page, menu);
  return enabled;
}

/** The terminal's find bar, opened from the ⋮ menu. */
export async function openTerminalFind(page, panel, options) {
  await chooseTerminalMenu(page, 'find in terminal', options);
  const find = panel.getByRole('textbox', {
    name: 'find in terminal',
    exact: true,
  });
  await find.waitFor();
  return find;
}

/** Match the real xterm buffer through the terminal's own find, soft-wrapped output included. */
export async function assertRenderedTerminalMatch({
  page,
  panel,
  surface,
  text,
  until,
}) {
  const find = await openTerminalFind(page, panel);
  const noMatches = panel.getByText('no matches', { exact: true });
  const selection = surface.locator('.xterm-selection div');
  const missing = `CIRCLE_NO_SUCH_RENDERED_MATCH_${randomUUID()}`;
  await find.fill(missing);
  await find.press('Enter');
  await until(
    async () =>
      (await noMatches.isVisible()) && (await selection.count()) === 0,
    'the original xterm rejects a missing exact output match',
  );
  await find.fill(text);
  await find.press('Enter');
  let rectangles = [];
  await until(async () => {
    if (await noMatches.isVisible()) return false;
    rectangles = await selection.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    );
    const viewport = await surface.boundingBox();
    return (
      viewport &&
      rectangles.some(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.x < viewport.x + viewport.width &&
          rect.x + rect.width > viewport.x &&
          rect.y < viewport.y + viewport.height &&
          rect.y + rect.height > viewport.y,
      )
    );
  }, 'the original xterm selects and displays the exact process echo');
  assert(rectangles.length > 0);
  return {
    text,
    missingTextRejected: true,
    selectionRectangles: rectangles,
    accessibilityRows: await surface
      .locator('.xterm-accessibility-tree > div')
      .allTextContents(),
  };
}
