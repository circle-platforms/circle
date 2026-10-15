import { access, unlink } from 'node:fs/promises';
/** ClipboardItem payloads remain exclusively in Electron's main process. */
export async function preserveNativeClipboard(app) {
  const key = crypto.randomUUID();
  await app.evaluate(async ({ clipboard, ClipboardItem }, key) => {
    const snapshots = (globalThis.__circleJourneyClipboard ??= new Map());
    // Electron 44 read() items are not writable instances. Materialize all
    // formats before changing the system clipboard, then construct fresh items.
    const items = await Promise.all(
      // An empty native pasteboard may read as one item with no MIME types.
      // It has no payload to restore; ClipboardItem({}) is invalid in Electron.
      (await clipboard.read())
        .filter((item) => item.types.length > 0)
        .map(
          async (item) =>
            new ClipboardItem(
              Object.fromEntries(
                await Promise.all(
                  item.types.map(async (type) => [
                    // macOS standard HTML writes prepend a new meta tag. The
                    // raw native format restores the original blob unchanged.
                    process.platform === 'darwin' && type === 'text/html'
                      ? 'electron application/osclipboard;format="public.html"'
                      : type,
                    await item.getType(type),
                  ]),
                ),
              ),
            ),
        ),
    );
    snapshots.set(key, items);
  }, key);
  return key;
}
export async function restoreNativeClipboard(app, key) {
  await app.evaluate(async ({ clipboard }, key) => {
    const snapshots = globalThis.__circleJourneyClipboard;
    if (!snapshots?.has(key))
      throw Error('native clipboard checkpoint is unavailable');
    const items = snapshots.get(key);
    if (items.length) await clipboard.write(items);
    else await clipboard.clear();
    snapshots.delete(key);
    if (!snapshots.size) delete globalThis.__circleJourneyClipboard;
  }, key);
}

/** Never close the owner application while its only original backup is in main. */
export async function restoreNativeClipboardWithRecovery(
  app,
  key,
  { retryPath, onFailure },
) {
  for (;;) {
    try {
      await restoreNativeClipboard(app, key);
      return;
    } catch (error) {
      await onFailure(error);
      for (;;) {
        try {
          await access(retryPath);
          await unlink(retryPath);
          break;
        } catch (markerError) {
          if (markerError.code !== 'ENOENT') throw markerError;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
}
