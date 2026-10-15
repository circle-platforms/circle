/** ClipboardItem payloads remain exclusively in Electron's main process. */
export async function preserveNativeClipboard(app) {
  const key = crypto.randomUUID();
  await app.evaluate(async ({ clipboard }, key) => {
    const snapshots = (globalThis.__circleJourneyClipboard ??= new Map());
    snapshots.set(key, await clipboard.read());
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
