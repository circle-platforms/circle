// Chromium's own developer tools, not a panel Circle draws. The page stays usable
// after they close, which is when Circle attaches its debugger again.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export function browserDebugFixtureSource(source) {
  const needle = '(window.__journeyEvents ||= []).push(event.data)';
  const observed = source.includes(needle)
    ? source.replace(
        needle,
        "(window.__journeyEvents ||= []).push(event.data); if(event.data==='JOURNEY_BROWSER_DEBUG_TRIGGER') console.log('JOURNEY_BROWSER_DEBUG_RESULT',window.__journeyBrowserDebug())",
      )
    : source.replace(
        'event => console.log(event.data)',
        "event => { (window.__journeyEvents ||= []).push(event.data); if(event.data==='JOURNEY_BROWSER_DEBUG_TRIGGER') console.log('JOURNEY_BROWSER_DEBUG_RESULT',window.__journeyBrowserDebug()); else console.log(event.data); }",
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
      'window.__journeyBrowserDebug = function nativeBrowserDebugFixture(){\n  let count = 3;\n  debugger;\n  const next = count + 1;\n  return next;\n};\n',
    breakpointLine: start + 2,
    computationLine: start + 3,
    afterStepLine: start + 4,
  };
}
export async function runNativeBrowserDebugJourney({
  page,
  getApp,
  pageURL,
  until,
  output,
}) {
  const observed = { checks: [] };
  const devToolsOpen = () =>
    getApp().evaluate(
      ({ webContents }, pageURL) =>
        webContents
          .getAllWebContents()
          .some(
            (contents) =>
              contents.getURL().startsWith(pageURL) &&
              contents.isDevToolsOpened(),
          ),
      pageURL,
    );
  try {
    assert.equal(await page.locator('.browser-diagnostics').count(), 0);
    if (!(await devToolsOpen())) {
      await page
        .getByRole('button', { name: 'browser menu', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'developer tools' }).click();
    }
    await until(devToolsOpen, 'Chromium developer tools are open');
    observed.checks.push('menu opens Chromium developer tools');
    await getApp().evaluate(({ webContents }, pageURL) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL().startsWith(pageURL));
      for (const type of ['keyDown', 'keyUp'])
        contents.sendInputEvent({ type, keyCode: 'F12' });
    }, pageURL);
    await until(
      async () => !(await devToolsOpen()),
      'F12 closes Chromium developer tools',
    );
    const title = await getApp().evaluate(({ webContents }, pageURL) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL().startsWith(pageURL));
      return contents.executeJavaScript('document.title');
    }, pageURL);
    assert.equal(title, 'native journey fixture');
    observed.checks.push(
      'the page still runs after developer tools close and the debugger is attached again',
    );
    await page.screenshot({
      path: join(output, 'browser-gui-devtools-reconnected.png'),
    });
    observed.status = 'passed';
    return observed;
  } catch (error) {
    observed.status = 'failed';
    observed.error = String(error);
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
