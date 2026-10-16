/** The folder a native chooser returned. Cancel is null. Confirming with no path is an error. */
export function selectedFolder(result: {
  canceled: boolean;
  filePaths: readonly string[];
}): string | null {
  if (result.canceled) return null;
  const path = result.filePaths.map((item) => item.trim()).find(Boolean);
  if (!path) throw Error('folder could not be opened');
  return path;
}
