/**
 * Open a project file from the files mode's tree, filtered by its path. The tree lists
 * every file; offscreen rows are deliberately not mounted, so the filter brings the row in.
 */
export async function openNativeProjectFile(page, path) {
  const files = page.getByRole('button', { name: 'files panel', exact: true });
  const tree = page.getByRole('tree', { name: 'files', exact: true });
  // A drawer too narrow for a file and the tree shows the open file alone. Closing it
  // brings the tree back, and in a narrow window it closes the drawer as well.
  if (
    (await files.getAttribute('aria-pressed')) === 'true' &&
    !(await tree.isVisible())
  ) {
    const close = page
      .locator('.file-view')
      .getByRole('button', { name: 'close file', exact: true });
    if (await close.isVisible()) await close.click();
  }
  if ((await files.getAttribute('aria-pressed')) !== 'true')
    await files.click();
  await page
    .getByRole('textbox', { name: 'filter files', exact: true })
    .fill(path);
  await tree.getByRole('treeitem', { name: path, exact: true }).click();
}
