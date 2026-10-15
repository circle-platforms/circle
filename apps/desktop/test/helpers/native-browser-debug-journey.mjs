// Appends controlled page code; all debugger mutations in the journey use visible controls.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export function browserDebugFixtureSource(source) {
  const observed = source.replace(
    'event => console.log(event.data)',
    "event => { if(event.data==='JOURNEY_BROWSER_DEBUG_TRIGGER') console.log('JOURNEY_BROWSER_DEBUG_RESULT',window.__journeyBrowserDebug()); else console.log(event.data); }",
  );
  assert.notEqual(
    observed,
    source,
    'fixture must retain the actual EventSource receiver',
  );
  const start = observed.split('\n').length;
  return {
    source:
      observed +
      'window.__journeyBrowserDebug = function nativeBrowserDebugFixture(){\n  const count = 3;\n  const next = count + 1;\n  return next;\n};\n',
    breakpointLine: start + 2,
    afterStepLine: start + 3,
  };
}
export async function runNativeBrowserDebugJourney({
  page,
  sessionId,
  sourceURL,
  fixture,
  emit,
  until,
  output,
}) {
  const panel = page.locator('.browser-diagnostics');
  const read = async () =>
    page.evaluate(
      ({ sessionId }) =>
        window.circleDesktop.browserDiagnostics(sessionId, { action: 'read' }),
      { sessionId },
    );
  const observed = { checks: [] };
  try {
    await panel
      .getByRole('tab', { name: 'page debugger', exact: true })
      .click();
    await panel.getByLabel('source URL', { exact: true }).fill(sourceURL);
    await panel
      .getByLabel('breakpoint line', { exact: true })
      .fill(String(fixture.breakpointLine));
    await panel
      .getByRole('button', { name: 'add breakpoint', exact: true })
      .click();
    await until(
      async () =>
        (await read()).state.debugger.breakpoints.some(
          (b) => b.verified && b.line === fixture.breakpointLine,
        ),
      'actual web breakpoint verified',
    );
    emit('JOURNEY_BROWSER_DEBUG_TRIGGER');
    await until(async () => {
      const state = (await read()).state.debugger;
      return (
        state.paused && state.stackFrames[0]?.line === fixture.breakpointLine
      );
    }, 'actual webpage paused at source breakpoint');
    let frame = panel
      .locator('.browser-diagnostic-results details')
      .filter({ hasText: 'nativeBrowserDebugFixture' })
      .first();
    await frame.locator('summary').click();
    await frame.getByRole('button', { name: 'local', exact: true }).click();
    await panel.getByText('count: 3', { exact: true }).waitFor();
    observed.checks.push('GUI breakpoint and real local variable');
    await panel.getByRole('button', { name: 'step over', exact: true }).click();
    await until(
      async () =>
        (await read()).state.debugger.stackFrames[0]?.line ===
        fixture.afterStepLine,
      'actual web step reaches next line',
    );
    // Selected scope must refresh automatically; a second scope click would hide stale locals.
    await panel.getByText('next: 4', { exact: true }).waitFor();
    observed.checks.push(
      'step refreshes selected local scope without another click',
    );
    frame = panel
      .locator('.browser-diagnostic-results details')
      .filter({ hasText: 'nativeBrowserDebugFixture' })
      .first();
    if (!(await frame.evaluate((node) => node.open)))
      await frame.locator('summary').click();
    await frame
      .getByRole('button', { name: 'open source location', exact: true })
      .click();
    await until(
      async () =>
        (
          await page
            .locator(
              '.file-view .monaco-editor .line-numbers.active-line-number',
            )
            .first()
            .textContent()
        )?.trim() === String(fixture.afterStepLine),
      'web call stack opens exact real source line',
    );
    observed.checks.push('web call stack navigates to exact local source line');
    await page.screenshot({
      path: join(output, 'browser-gui-breakpoint-locals-source.png'),
    });
    // Source navigation replaces the inspector; reopen the existing browser target.
    const browserToggle = page.getByRole('button', {
      name: 'browser panel',
      exact: true,
    });
    if ((await browserToggle.getAttribute('aria-pressed')) !== 'true')
      await browserToggle.click();
    const diagnosticsToggle = page.getByRole('button', {
      name: 'page diagnostics',
      exact: true,
    });
    if ((await diagnosticsToggle.getAttribute('aria-expanded')) !== 'true')
      await diagnosticsToggle.click();
    await panel
      .getByRole('tab', { name: 'page debugger', exact: true })
      .click();
    await panel.getByRole('button', { name: 'resume', exact: true }).click();
    await until(
      async () =>
        (await read()).state.console.some(
          (row) => row.text === 'JOURNEY_BROWSER_DEBUG_RESULT 4',
        ),
      'resumed real page function returns4',
    );
    await panel
      .getByRole('button', { name: 'remove breakpoint', exact: true })
      .first()
      .click();
    await until(
      async () => (await read()).state.debugger.breakpoints.length === 0,
      'GUI removes actual breakpoint',
    );
    observed.checks.push('resume effect and breakpoint removal');
    observed.status = 'passed';
    observed.final = await read();
    return observed;
  } catch (error) {
    observed.status = 'failed';
    observed.error = String(error);
    observed.actual = await read().catch((error) => ({
      unavailable: String(error),
    }));
    await page
      .screenshot({ path: join(output, 'browser-gui-debug-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    await writeFile(
      join(output, 'browser-gui-debug-receipt.json'),
      JSON.stringify(observed, null, 2),
    );
  }
}
