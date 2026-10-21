import { patience } from './patience.mjs';

// Saves the open Monaco editor with the platform shortcut and waits until
// `written()` sees the result on disk. A shortcut reaches Monaco only through
// its focused textarea, and a loaded Windows runner can drop a key press, so
// focus comes first, and the key is pressed again only while nothing is
// saving (the save button is enabled) and the edit is still unsaved: a second
// press can never race a save in flight.
// `scope` is the part of the page holding the editor, its save button and
// its state, when more than one file view may be on the page.
export async function saveWithShortcut(
  page,
  modifier,
  written,
  label,
  scope = page,
) {
  const editor = scope.locator('.native-code-editor').first();
  const saveButton = scope.getByRole('button', { name: 'save', exact: true });
  const unsaved = scope.getByText('unsaved changes', { exact: true });
  const deadline = Date.now() + patience(15000);
  let pending = false;
  let presses = 0;
  while (Date.now() < deadline) {
    if (!pending) {
      if (
        !(await editor.evaluate((node) =>
          node.contains(document.activeElement),
        ))
      )
        await editor.locator('.view-lines').first().click();
      await page.keyboard.press(`${modifier}+s`);
      presses++;
    }
    const pressed = Date.now() + patience(3000);
    while (Date.now() < pressed) {
      if (await written()) return;
      await page.waitForTimeout(50);
    }
    // Still saving, or saved with other bytes: wait; never press again.
    pending = !((await saveButton.isEnabled()) && (await unsaved.isVisible()));
  }
  // Whether the key presses were lost (the edit still unsaved, nothing saving) or a
  // save started and did not finish (#229)
  const state = {
    presses,
    focused: await editor
      .evaluate((node) => node.contains(document.activeElement))
      .catch(() => null),
    saveEnabled: await saveButton.isEnabled().catch(() => null),
    unsaved: await unsaved.isVisible().catch(() => null),
  };
  throw Error(
    'native editor timed out: ' + label + ' ' + JSON.stringify(state),
  );
}
