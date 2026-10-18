import assert from 'node:assert/strict';
/** Uses the current isolated app; file and inspector navigation use the original shell. */
export async function runNativeKeyboardJourney({
  page,
  fileName = 'README.md',
  checks,
}) {
  const closeFile = async () => {
    const close = page
      .locator('.file-view')
      .getByRole('button', { name: 'close file', exact: true });
    if (await close.isVisible()) await close.click();
  };
  await closeFile();
  const message = page.getByRole('textbox', { name: 'message', exact: true });
  const previous = await message.inputValue();
  await message.fill('NATIVE_KEYBOARD_UNSENT_DRAFT');
  await message.focus();
  await message.evaluate((node) => node.setSelectionRange(3, 10));
  const search = page.getByRole('textbox', {
    name: 'global search',
    exact: true,
  });
  const openFile = async () => {
    await page.keyboard.press('ControlOrMeta+p');
    await search.waitFor();
    const first = await page
      .locator('.search-results button.selected strong')
      .textContent();
    await search.press('ArrowDown');
    await search.press('ArrowUp');
    assert.equal(
      await page
        .locator('.search-results button.selected strong')
        .textContent(),
      first,
    );
    await search.fill(fileName);
    await search.press('Enter');
    await search.waitFor({ state: 'hidden' });
    await page
      .locator('.file-view-heading strong')
      .getByText(fileName, { exact: true })
      .waitFor();
    await page.locator('.native-code-editor .view-lines').first().waitFor();
  };
  await openFile();
  await page
    .getByRole('button', {
      name: /\.(md|markdown|mdown)$/i.test(fileName) ? 'source code' : 'edit',
      exact: true,
    })
    .click();
  const editor = page.locator('.native-code-editor');
  const input = editor
    .locator('.native-edit-context, textarea.inputarea')
    .first();
  await input.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.insertText('ξ');
  await page.waitForFunction(() =>
    document
      .querySelector('.native-code-editor .view-lines')
      ?.textContent.includes('ξ'),
  );
  await page.getByText('unsaved changes', { exact: true }).waitFor();
  await page.keyboard.press('Shift+ArrowLeft');
  const selection = () =>
    input.evaluate((node) => {
      const context = node.editContext;
      return context
        ? [context.selectionStart, context.selectionEnd]
        : [node.selectionStart, node.selectionEnd];
    });
  await page.waitForFunction(() => {
    const node = document.querySelector(
      '.native-code-editor .native-edit-context, .native-code-editor textarea.inputarea',
    );
    const state = node?.editContext ?? node;
    return state && state.selectionStart !== state.selectionEnd;
  });
  const selected = await selection();
  assert.notEqual(selected[0], selected[1], 'a real editor range is selected');
  await editor.evaluate((node) => {
    window.__originalKeyboardEditor = node;
  });
  const text = await editor.locator('.view-lines').first().textContent();
  const files = page.getByRole('button', { name: 'files panel', exact: true });
  const initiallyOpen = (await files.getAttribute('aria-pressed')) === 'true';
  await files.click();
  await files.click();
  assert.equal(
    (await files.getAttribute('aria-pressed')) === 'true',
    initiallyOpen,
  );
  assert.equal(
    await editor.evaluate((node) => node === window.__originalKeyboardEditor),
    true,
    'original Inspector toggles retain the same editor instance',
  );
  assert.equal(
    await editor.locator('.view-lines').first().textContent(),
    text,
    'Inspector cannot replace source contents',
  );
  assert.deepEqual(
    await selection(),
    selected,
    'Inspector preserves the actual editor range',
  );
  await input.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForFunction(
    () =>
      !document
        .querySelector('.native-code-editor .view-lines')
        ?.textContent.includes('ξ'),
  );
  await closeFile();
  await message.waitFor({ state: 'visible' });
  assert.equal(await message.inputValue(), 'NATIVE_KEYBOARD_UNSENT_DRAFT');
  assert.deepEqual(
    await message.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [3, 10],
  );
  await message.focus();
  await message.evaluate((node) => node.setSelectionRange(3, 10));
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  );
  await search.waitFor();
  await search.press('Escape');
  await search.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    () =>
      document.activeElement ===
      document.querySelector('textarea[aria-label="message"]'),
  );
  assert.deepEqual(
    await message.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [3, 10],
  );
  const transcript = page.locator('.transcript');
  const geometry = () =>
    transcript.evaluate(async (node) => {
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
      return {
        top: node.scrollTop,
        max: Math.max(0, node.scrollHeight - node.clientHeight),
      };
    });
  await transcript.evaluate((node) =>
    node.scrollTo({
      top: Math.min(120, Math.max(0, node.scrollHeight - node.clientHeight)),
      behavior: 'instant',
    }),
  );
  const before = await geometry();
  await openFile();
  await closeFile();
  const after = await geometry();
  assert.equal(await message.inputValue(), 'NATIVE_KEYBOARD_UNSENT_DRAFT');
  assert.deepEqual(
    await message.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [3, 10],
  );
  assert.ok(
    Math.abs(after.top - before.top) <= 2,
    'original file roundtrip preserves reading position ' +
      JSON.stringify({ before, after }),
  );
  checks?.push(
    'native quick-open, original file/Inspector continuity, palette focus and composer draft/selection/scroll retention',
  );
  await message.fill(previous);
}
