// Confirms the Linux setuid update from the warning shown by the application.
export async function confirmLinuxUpdate(page) {
  const dialog = page.getByRole('dialog', {
    name: 'quit and replace',
    exact: true,
  });
  await dialog.getByText('sudo chmod 4755').waitFor();
  await dialog
    .getByRole('button', { name: 'quit and replace', exact: true })
    .click();
}
