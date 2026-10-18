/** Navigate the actual project index, including a bounded virtual row window. */
export async function openNativeProjectFile(page, path) {
  const files = page.getByRole('button', { name: 'files panel', exact: true });
  if ((await files.getAttribute('aria-pressed')) !== 'true')
    await files.click();
  const index = page.getByRole('button', { name: 'file index', exact: true });
  if (await index.isVisible()) {
    if ((await index.getAttribute('aria-pressed')) !== 'true')
      await index.click();
  }
  // Filtering is a user-visible index action. Offscreen rows are deliberately not mounted.
  await page
    .getByRole('textbox', { name: 'filter files', exact: true })
    .fill(path);
  await page
    .getByRole('tree', { name: 'files', exact: true })
    .getByRole('treeitem', { name: path, exact: true })
    .click();
}
