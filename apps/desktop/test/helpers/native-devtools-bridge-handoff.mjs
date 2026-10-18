import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { clickReadyDevToolsResume } from './devtools-resume-control.mjs';
import { patience } from './patience.mjs';

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

export async function runActualBridgeDevToolsHandoff({
  app,
  page,
  panel,
  read,
  sessionId,
  pageURL,
  emit,
  until,
}) {
  const id = randomUUID();
  const evidence = {
    identity: await app.evaluate(({ app }) => ({
      appPath: app.getAppPath(),
      packaged: app.isPackaged,
      executable: process.execPath,
    })),
  };
  let primary;
  try {
    evidence.target = await app.evaluate(installOwnedBrowserWitness, {
      id,
      pageURL,
      sessionId,
    });
    emit('JOURNEY_BROWSER_DEBUG_TRIGGER');
    await until(
      async () => (await read()).state.debugger.paused,
      'actual Circle guest pauses again before explicit DevTools handoff',
    );
    const paused = (await read()).state.debugger;
    const reference = paused.stackFrames[0]?.scopes.find(
      (scope) => scope.name === 'local',
    )?.variablesReference;
    assert(reference, 'the real old paused local scope must exist');
    evidence.previousPauseEpoch = paused.pauseEpoch;
    await panel
      .getByRole('button', { name: 'open developer tools', exact: true })
      .click();
    await until(
      async () => (await read()).state.owner === 'devtools',
      'actual Circle bridge hands the existing target to DevTools',
    );
    // DevTools builds its debugger controls after its page has loaded; on a
    // slow runner that takes several seconds. The loop ends once the guest
    // prints its result after the resume.
    const deadline = Date.now() + patience(10000);
    let clicked = false;
    while (Date.now() < deadline) {
      const observation = await app.evaluate(
        async (_, { id, expression, clicked }) => {
          const witness = globalThis.__circleOwnedBrowserWitnesses.get(id);
          if (witness.result === 4)
            return { result: 4, messages: witness.messages };
          const frontend = witness.guest.devToolsWebContents;
          if (
            clicked ||
            !witness.opened ||
            !frontend ||
            frontend.isDestroyed() ||
            frontend.isLoadingMainFrame()
          )
            return {
              result: witness.result,
              opened: witness.opened,
              loading: frontend?.isLoadingMainFrame(),
            };
          return {
            ...(await frontend.executeJavaScript(expression)),
            opened: witness.opened,
            loading: frontend.isLoadingMainFrame(),
            focused: frontend.isFocused(),
          };
        },
        {
          id,
          expression: `(${clickReadyDevToolsResume.toString()})()`,
          clicked,
        },
      );
      evidence.frontend = observation;
      clicked ||= observation.clicked === true;
      if (observation.result === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    evidence.clickedResume = clicked;
    assert.equal(
      clicked,
      true,
      'the actual ready DevTools resume control must be clicked',
    );
    evidence.result = await app.evaluate(
      (_, id) => globalThis.__circleOwnedBrowserWitnesses.get(id).result,
      id,
    );
    assert.equal(
      evidence.result,
      4,
      'actual packaged/development guest completes during DevTools ownership gap',
    );
    await app.evaluate(
      (_, id) =>
        globalThis.__circleOwnedBrowserWitnesses.get(id).guest.closeDevTools(),
      id,
    );
    await until(async () => {
      const state = (await read()).state;
      return (
        state.owner === 'circle' &&
        !state.reconnectError &&
        !state.debugger.paused &&
        state.debugger.stackFrames.length === 0 &&
        state.debugger.pauseEpoch > paused.pauseEpoch
      );
    }, 'actual bridge reconnects Circle and invalidates the old paused stack');
    evidence.staleReferenceError = await page.evaluate(
      async ({ sessionId, reference }) => {
        try {
          await window.circleDesktop.browserDiagnostics(sessionId, {
            action: 'debug',
            command: 'variables',
            reference,
          });
          return null;
        } catch (error) {
          return String(error);
        }
      },
      { sessionId, reference },
    );
    assert.match(evidence.staleReferenceError, /stale variable reference/);
    const marker = `JOURNEY_BROWSER_RECONNECTED_${id}`;
    emit(marker);
    await until(
      async () =>
        (await read()).state.console.some((row) => row.text === marker),
      'actual Circle Runtime subscription observes new console data after reconnect',
    );
    evidence.finalOwner = (await read()).state.owner;
    return evidence;
  } catch (error) {
    primary = error;
    error.actualHandoff = evidence;
    throw error;
  } finally {
    try {
      await app.evaluate(removeOwnedBrowserWitness, id);
    } catch (cleanupError) {
      const error = primary
        ? new AggregateError(
            [primary, cleanupError],
            'DevTools handoff and owned cleanup failed',
          )
        : cleanupError;
      error.actualHandoff = evidence;
      throw error;
    }
  }
}
