import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { readTerminalOutput } from '../../../workbench/src/model/terminal-stream.ts';

/** Match the real xterm buffer through its original UI, including soft-wrapped and canvas-only output. */
export async function assertRenderedTerminalMatch({
  panel,
  surface,
  text,
  until,
  terminalId,
  replay,
}) {
  // Input receipt precedes the process's echo. Search takes a fixed log
  // boundary, so first observe the echo in this original terminal's log.
  await until(
    async () =>
      stripVTControlCharacters(
        await readTerminalOutput(terminalId, replay),
      ).includes(text),
    'the original terminal log contains the exact process echo',
  );
  const find = panel.getByRole('textbox', {
    name: 'find in terminal',
    exact: true,
  });
  // Find opens on demand from the terminal's ⋮ menu, or from a find button where a
  // stand-in terminal bar still has one.
  if (!(await find.isVisible())) {
    const button = panel.getByRole('button', {
      name: 'find in terminal',
      exact: true,
    });
    if (await button.count()) await button.click();
    else {
      await panel
        .getByRole('button', { name: 'terminal menu', exact: true })
        .click();
      await panel
        .page()
        .getByRole('menuitem', { name: 'find in terminal', exact: true })
        .click();
    }
  }
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
