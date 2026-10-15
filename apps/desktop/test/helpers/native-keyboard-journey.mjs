import assert from 'node:assert/strict';
/** Called only by the native journey's current desktop lease owner. */
export async function runNativeKeyboardJourney({
  page,
  fileName = 'README.md',
  checks,
}) {
  const message = page.getByRole('textbox', { name: 'message', exact: true });
  const previous = await message.inputValue();
  await message.fill('NATIVE_KEYBOARD_UNSENT_DRAFT');
  await message.focus();
  await message.evaluate((node) => node.setSelectionRange(3, 10));
  await page.keyboard.press('ControlOrMeta+p');
  const search = page.getByRole('textbox', {
    name: 'global search',
    exact: true,
  });
  await search.waitFor();
  const first = await page
    .locator('.search-results button.selected strong')
    .textContent();
  await search.press('ArrowDown');
  await search.press('ArrowUp');
  assert.equal(
    await page.locator('.search-results button.selected strong').textContent(),
    first,
  );
  await search.fill(fileName);
  await search.press('Enter');
  await page
    .locator('.file-view')
    .getByText(fileName, { exact: false })
    .first()
    .waitFor();
  await message.focus();
  await message.evaluate((node) => node.setSelectionRange(3, 10));
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+k' : 'Control+Shift+p',
  );
  await search.waitFor();
  await search.press('Escape');
  await search.waitFor({ state: 'hidden' });
  // Radix restores focus when the exit transition unmounts the dialog.
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea[aria-label="message"]');
    return input && document.activeElement === input;
  });
  assert.equal(
    await message.evaluate((node) => document.activeElement === node),
    true,
  );
  assert.deepEqual(
    await message.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [3, 10],
  );
  // The parent journey can arrive in either layout. Compare a roundtrip
  // between identical task-layout geometries, not two differently wrapped panes.
  await page.getByRole('button', { name: 'task layout', exact: true }).click();
  const transcript = page.locator('.transcript');
  const geometry = () =>
    transcript.evaluate(async (node) => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return {
        top: node.scrollTop,
        max: Math.max(0, node.scrollHeight - node.clientHeight),
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        layout: document
          .querySelector('.developer-workbench')
          ?.getAttribute('data-layout'),
      };
    });
  await geometry();
  await transcript.evaluate((node) =>
    node.scrollTo({
      top: Math.min(120, Math.max(0, node.scrollHeight - node.clientHeight)),
      behavior: 'instant',
    }),
  );
  const before = await geometry();
  await page
    .getByRole('button', { name: 'developer layout', exact: true })
    .click();
  await page.getByRole('button', { name: 'task layout', exact: true }).click();
  assert.equal(await message.inputValue(), 'NATIVE_KEYBOARD_UNSENT_DRAFT');
  assert.deepEqual(
    await message.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [3, 10],
  );
  const after = await geometry();
  assert.equal(before.layout, 'task');
  assert.equal(after.layout, 'task');
  assert.ok(
    Math.abs(after.top - before.top) <= 2,
    'same-layout transcript position changed: ' +
      JSON.stringify({ before, after }),
  );
  checks?.push(
    'native quick-open keyboard, palette Escape focus, and layout draft/selection/scroll retention',
  );
  await message.fill(previous);
}
