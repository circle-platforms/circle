// Close settings through the same localized control the person uses, so the
// original conversation and its focus are restored before the next action.
export async function closeNativeSettings(page) {
  const settings = page.locator('.settings-dialog');
  if (!(await settings.isVisible())) return false;
  await settings
    .getByRole('button', { name: /^(close dialog|关闭对话框)$/, exact: true })
    .click();
  await settings.waitFor({ state: 'hidden' });
  return true;
}
