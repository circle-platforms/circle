/** Standalone trusted-main callback. Never opens a second debugger client. */
export function installOwnedBrowserWitness(
  { webContents, session },
  { id, pageURL, sessionId },
) {
  const expected = new URL(pageURL).href;
  const partition = session.fromPartition('circle-browser-' + sessionId);
  const candidates = webContents
    .getAllWebContents()
    .filter(
      (contents) =>
        contents.getType() === 'window' &&
        contents.session === partition &&
        contents.getURL() === expected,
    );
  if (candidates.length !== 1)
    throw Error('exact owned fixture browser target is not unique');
  const guest = candidates[0];
  const witness = { guest, opened: false, result: undefined, messages: [] };
  witness.consoleListener = (details) => {
    if (details.message === 'JOURNEY_BROWSER_DEBUG_RESULT 4') {
      witness.result = 4;
      witness.messages.push({ at: Date.now(), message: details.message });
    }
  };
  witness.openListener = () => {
    witness.opened = true;
  };
  guest.on('console-message', witness.consoleListener);
  guest.on('devtools-opened', witness.openListener);
  (globalThis.__circleOwnedBrowserWitnesses ??= new Map()).set(id, witness);
  return { guestId: guest.id, sessionId, pageURL: expected };
}

export function removeOwnedBrowserWitness(_, id) {
  const map = globalThis.__circleOwnedBrowserWitnesses;
  const witness = map?.get(id);
  if (witness) {
    if (!witness.guest.isDestroyed()) {
      witness.guest.off('console-message', witness.consoleListener);
      witness.guest.off('devtools-opened', witness.openListener);
      if (witness.guest.isDevToolsOpened()) witness.guest.closeDevTools();
    }
    map.delete(id);
  }
  if (!map?.size) delete globalThis.__circleOwnedBrowserWitnesses;
}
