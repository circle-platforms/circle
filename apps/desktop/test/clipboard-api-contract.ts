import type * as Electron from 'electron';
/** Compile against the installed Electron types; no deprecated sync formats API. */
export async function clipboardApiContract(electron: typeof Electron) {
  const items: Electron.ClipboardItem[] = await electron.clipboard.read();
  const text: string = await electron.clipboard.readText();
  await electron.clipboard.write(items);
  await electron.clipboard.writeText(text);
  await electron.clipboard.clear();
  return new electron.ClipboardItem({
    'image/png': new Blob([new Uint8Array([0, 1])], { type: 'image/png' }),
  });
}
