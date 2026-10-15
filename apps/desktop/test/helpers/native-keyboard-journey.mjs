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
  assert.equal(
    await message.evaluate((node) => document.activeElement === node),
    true,
  );
  assert.deepEqual(
    await message.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [3, 10],
  );
  const transcript = page.locator('.transcript');
  await transcript.evaluate(
    (node) =>
      (node.scrollTop = Math.min(120, node.scrollHeight - node.clientHeight)),
  );
  const scrollBefore = await transcript.evaluate((node) => node.scrollTop);
  await page
    .getByRole('button', { name: 'developer layout', exact: true })
    .click();
  await page.getByRole('button', { name: 'task layout', exact: true }).click();
  assert.equal(await message.inputValue(), 'NATIVE_KEYBOARD_UNSENT_DRAFT');
  assert.deepEqual(
    await message.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [3, 10],
  );
  assert.ok(
    Math.abs(
      (await transcript.evaluate((node) => node.scrollTop)) - scrollBefore,
    ) <= 2,
  );
  checks?.push(
    'native quick-open keyboard, palette Escape focus, and layout draft/selection/scroll retention',
  );
  await message.fill(previous);
}
