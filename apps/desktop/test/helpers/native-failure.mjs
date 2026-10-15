import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const limited = (value, limit) => {
  const text = String(value);
  return {
    text: text.slice(0, limit),
    characters: text.length,
    truncated: text.length > limit,
  };
};
const describe = (error) => {
  const name = error?.name === undefined ? undefined : limited(error.name, 100);
  const message = limited(error?.message ?? error, 2000);
  const stack =
    error?.stack === undefined ? undefined : limited(error.stack, 4000);
  const summary = (field) =>
    field && { characters: field.characters, truncated: field.truncated };
  return {
    name: name?.text,
    message: message.text,
    stack: stack?.text,
    limits: {
      name: summary(name),
      message: summary(message),
      stack: summary(stack),
    },
  };
};

export async function writeNativeFailure(output, details) {
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify(details, null, 2) + '\n',
  );
}

// This is evidence collection after a failed assertion, never another attempt at it.
export async function captureNativeFailure({
  app,
  page,
  error,
  events,
  output,
  attempt,
  stage,
  observerStartedAt,
  expectedDataPath,
}) {
  const observed = events.slice(0, 20).map((event) => limited(event, 1000));
  const primaryFile = `primary-${attempt.id}.json`;
  const details = {
    attempt,
    at: new Date().toISOString(),
    stage,
    error: describe(error),
    primaryFile,
    events: observed.map((event) => event.text),
    eventsSummary: {
      count: events.length,
      retained: observed.length,
      truncated: events.length > observed.length,
      textTruncated: observed.some((event) => event.truncated),
    },
    observer: {
      pageErrorListenerStartedAt: observerStartedAt,
      coverage:
        'Events observed after registration; retained Playwright page history is sampled separately and may not cover earlier bootstrap errors',
    },
    probes: {},
  };
  // Even an unwritable output folder must not hide an already observed error.
  console.error(JSON.stringify(details));
  // Detailed updates may fail: this attempt's primary record is written only once.
  await writeFile(
    join(output, primaryFile),
    JSON.stringify(details, null, 2) + '\n',
    {
      flag: 'wx',
    },
  );
  await writeNativeFailure(output, details);
  const deadline = Date.now() + 2000;
  const probe = async (name, read) => {
    let timer;
    try {
      details.probes[name] = {
        status: 'captured',
        value: await Promise.race([
          Promise.resolve().then(read),
          new Promise((_resolve, reject) => {
            timer = setTimeout(
              () => reject(Error('diagnostic deadline exceeded')),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]),
      };
    } catch (secondary) {
      details.probes[name] = {
        status: 'unavailable',
        error: describe(secondary),
      };
    } finally {
      clearTimeout(timer);
    }
  };
  await Promise.all([
    probe('page', async () => {
      const errors = await page.pageErrors();
      const messages = await page.consoleMessages();
      const matching = messages
        .slice(0, 200)
        .filter((message) => message.type() === 'error');
      const consoleErrors = matching
        .slice(0, 20)
        .map((message) => limited(message.text(), 2000));
      const url = limited(page.url(), 2048);
      return {
        url: url.text,
        urlTruncated: url.truncated,
        errors: errors.slice(0, 20).map(describe),
        errorsSummary: {
          count: errors.length,
          retained: Math.min(20, errors.length),
          truncated: errors.length > 20,
        },
        consoleErrors: consoleErrors.map((message) => message.text),
        consoleSummary: {
          count: messages.length,
          inspected: Math.min(200, messages.length),
          matching: matching.length,
          retained: consoleErrors.length,
          truncated: messages.length > 200 || matching.length > 20,
          textTruncated: consoleErrors.some((message) => message.truncated),
        },
      };
    }),
    probe('dom', () =>
      page.evaluate(() => {
        const elements = (selector, limit, project) => {
          const nodes = document.querySelectorAll(selector);
          return {
            count: nodes.length,
            truncated: nodes.length > limit,
            items: Array.from(
              { length: Math.min(limit, nodes.length) },
              (_, i) => project(nodes[i]),
            ),
          };
        };
        const label = (element) => {
          const value = element.getAttribute('aria-label');
          return {
            label: value?.slice(0, 200),
            labelTruncated: !!value && value.length > 200,
          };
        };
        return {
          url: location.href.slice(0, 2048),
          urlTruncated: location.href.length > 2048,
          readyState: document.readyState,
          title: document.title.slice(0, 200),
          titleTruncated: document.title.length > 200,
          rootChildren: document.getElementById('root')?.childElementCount,
          bridgeAvailable: !!window.circleDesktop,
          dialogs: elements('[role="dialog"]', 20, label),
          inputs: elements('input,textarea', 50, (element) => ({
            tag: element.tagName,
            type: element.type,
            ...label(element),
            disabled: element.disabled,
          })),
        };
      }),
    ),
    probe('bridge', () =>
      page.evaluate(async (expectedDataPath) => {
        const bridge = window.circleDesktop;
        if (!bridge) return { available: false };
        const info = await bridge.info();
        const dataFolderMatches = info.dataPath === expectedDataPath;
        const status = {
          available: true,
          apiVersion: bridge.apiVersion,
          dataFolderMatches,
          packaged: info.packaged,
          runtimeConnected: info.runtimeConnected,
          frontendOnly: info.frontendOnly,
        };
        if (!dataFolderMatches) return status;
        const update = await bridge.runtimeState();
        const snapshot = update.snapshot;
        const sessions = snapshot.sessions.slice(0, 100);
        return {
          ...status,
          seq: update.seq,
          connected: update.connected,
          event: update.event
            ? {
                kind: update.event.kind?.slice(0, 100),
                kindTruncated: (update.event.kind?.length ?? 0) > 100,
                at: update.event.at?.slice(0, 100),
                atTruncated: (update.event.at?.length ?? 0) > 100,
                eventSeq: update.event.eventSeq,
              }
            : undefined,
          runtime: {
            configured: snapshot.runtime?.configured,
            connected: snapshot.runtime?.connected,
            hasKey: snapshot.runtime?.hasKey,
            observedAt: snapshot.runtime?.observedAt?.slice(0, 100),
            observedAtTruncated:
              (snapshot.runtime?.observedAt?.length ?? 0) > 100,
            coreVersion: snapshot.runtime?.coreVersion?.slice(0, 100),
            coreVersionTruncated:
              (snapshot.runtime?.coreVersion?.length ?? 0) > 100,
            errorPresent: !!snapshot.runtime?.error,
          },
          activeSessionState: sessions.find(
            (session) => session.id === snapshot.activeSessionId,
          )?.state,
          sessionCount: snapshot.sessions.length,
          sessionsInspected: sessions.length,
          sessionScanTruncated: snapshot.sessions.length > sessions.length,
        };
      }, expectedDataPath),
    ),
    probe('windows', () =>
      app.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        return {
          count: windows.length,
          truncated: windows.length > 10,
          items: windows.slice(0, 10).map((window) => ({
            id: window.id,
            visible: window.isVisible(),
            focused: window.isFocused(),
            minimized: window.isMinimized(),
            bounds: window.getBounds(),
            contentBounds: window.getContentBounds(),
            url: window.webContents.getURL().slice(0, 2048),
            urlTruncated: window.webContents.getURL().length > 2048,
            loading: window.webContents.isLoading(),
            destroyed: window.webContents.isDestroyed(),
          })),
        };
      }),
    ),
    probe('screenshot', async () => {
      const file = `failure-${attempt.id}.png`;
      await page.screenshot({
        path: join(output, file),
        mask: [page.locator('input,textarea')],
        timeout: Math.max(1, deadline - Date.now()),
      });
      return { file, inputsMasked: true };
    }),
  ]);
  await writeNativeFailure(output, details);
  console.error(JSON.stringify(details));
  return details;
}

export async function cleanupNativeFixture({
  primaryFailed,
  operations,
  onErrors,
}) {
  const failures = [];
  for (const [name, operation] of operations)
    try {
      await operation();
    } catch (error) {
      failures.push({ name, error });
      console.error(
        `native fixture cleanup failed (${name}):`,
        describe(error),
      );
    }
  if (!failures.length) return;
  try {
    await onErrors(
      failures.map(({ name, error }) => ({
        operation: name,
        ...describe(error),
      })),
    );
  } catch (error) {
    console.error('native fixture cleanup diagnostic failed:', describe(error));
  }
  if (!primaryFailed)
    throw failures.length === 1
      ? failures[0].error
      : new AggregateError(
          failures.map(({ error }) => error),
          'native fixture cleanup failed',
        );
}
