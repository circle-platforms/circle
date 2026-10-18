// Stimuli come from a local fixture server. Bridge/DOM hooks only observe real events.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { patience } from './patience.mjs';
export async function runNativeBrowserStream({
  page,
  sessionId,
  emit,
  output,
}) {
  const panel = page.locator('.browser-diagnostics');
  await panel.getByRole('tab', { name: 'console', exact: true }).click();
  // Events are measured on the live end of the console. Clicking an older entry
  // earlier scrolls a short console up and stops it following new output, so
  // scroll back to the latest entry with the wheel, as a person would.
  const results = panel.locator('.browser-diagnostic-results');
  await results.hover();
  await page.mouse.wheel(0, 100_000);
  await results.evaluate(
    (node, budget) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + budget;
        const settled = () =>
          node.scrollHeight - node.scrollTop - node.clientHeight < 2
            ? resolve()
            : Date.now() > deadline
              ? reject(Error('the console did not scroll to its latest entry'))
              : requestAnimationFrame(settled);
        settled();
      }),
    patience(3000),
  );
  await page.evaluate((sessionId) => {
    const events = new Map(),
      samples = [],
      pending = new Set();
    const stop = window.circleDesktop.onBrowserDiagnosticEvent((event) => {
      if (event.sessionId === sessionId && event.consoleId) {
        events.set(event.consoleId, event);
        // An initial visible-domain read can paint before the batched dirty
        // event arrives. Observe both arrival orders without polling.
        queueMicrotask(observe);
      }
    });
    const observe = () => {
      for (const row of document.querySelectorAll(
        '.browser-diagnostics [data-console-id]',
      )) {
        if (!row.textContent.includes('JOURNEY_PUSH_')) continue;
        const id = Number(row.dataset.consoleId),
          event = events.get(id);
        if (!event || pending.has(id)) continue;
        pending.add(id);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const bounds = row.getBoundingClientRect(),
              container = row
                .closest('.browser-diagnostic-results')
                ?.getBoundingClientRect();
            samples.push({
              id,
              text: row.textContent,
              eventAt: event.at,
              emittedAt: event.emittedAt,
              paintAt: Date.now(),
              latencyMs: Date.now() - event.at,
              visible:
                bounds.width > 0 &&
                bounds.height > 0 &&
                bounds.top <
                  Math.min(innerHeight, container?.bottom ?? innerHeight) &&
                bounds.bottom > Math.max(0, container?.top ?? 0),
              container,
            });
          }),
        );
      }
    };
    const observer = new MutationObserver(observe);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    window.__journeyBrowserStream = {
      samples,
      events,
      cleanup() {
        stop();
        observer.disconnect();
      },
    };
  }, sessionId);
  try {
    for (let i = 0; i < 30; i++) {
      const marker = 'JOURNEY_PUSH_' + i;
      emit(marker);
      await page.waitForFunction(
        (marker) =>
          window.__journeyBrowserStream.samples.some(
            (sample) => sample.text.includes(marker) && sample.visible,
          ),
        marker,
        { timeout: 3000 },
      );
    }
    const samples = await page.evaluate(
      () => window.__journeyBrowserStream.samples,
    );
    const sorted = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const receipt = {
      kind: 'real CDP console event to renderer DOM and two animation frames',
      conditions:
        'synthetic local page; currently visible console; thirty sequential real events',
      samples,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maxMs: sorted.at(-1),
    };
    await writeFile(
      join(output, 'browser-event-to-paint.json'),
      JSON.stringify(receipt, null, 2),
    );
    assert.equal(samples.length, 30);
    assert(
      receipt.p95Ms <= 200,
      `browser event→paint p95 ${receipt.p95Ms}ms exceeds200ms`,
    );
    return receipt;
  } finally {
    const observations = await page.evaluate(() => ({
      samples: window.__journeyBrowserStream.samples,
      events: [...window.__journeyBrowserStream.events.values()],
      window: { width: innerWidth, height: innerHeight },
      rows: [
        ...document.querySelectorAll('.browser-diagnostics [data-console-id]'),
      ]
        .filter((row) => row.textContent.includes('JOURNEY_PUSH_'))
        .map((row) => ({
          text: row.textContent,
          bounds: row.getBoundingClientRect().toJSON(),
          container: row
            .closest('.browser-diagnostic-results')
            ?.getBoundingClientRect()
            .toJSON(),
        })),
    }));
    await writeFile(
      join(output, 'browser-event-to-paint-observations.json'),
      JSON.stringify(observations, null, 2),
    );
    await page.evaluate(() => {
      window.__journeyBrowserStream.cleanup();
      delete window.__journeyBrowserStream;
    });
  }
}
