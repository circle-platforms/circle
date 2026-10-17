import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const output = process.env.CIRCLE_COMPONENT_UI_EVIDENCE;
if (output) {
  const originalLaunch = chromium.launch.bind(chromium);
  chromium.launch = async (...args) => {
    const browser = await originalLaunch(...args);
    const traces = new Set();
    const events = [];
    const originalPage = browser.newPage.bind(browser);
    browser.newPage = async (...options) => {
      const page = await originalPage(...options);
      page.on('pageerror', (error) =>
        events.push({ kind: 'pageerror', message: error.message }),
      );
      const context = page.context();
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });
      traces.add(context);
      return page;
    };
    const originalClose = browser.close.bind(browser);
    browser.close = async (...options) => {
      // Each suite closes its browser in finally, so capture precedes disposal
      // for assertions as well as successes. Evidence errors cannot hide the test.
      await mkdir(output, { recursive: true });
      let index = 0;
      const errors = [];
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          const id = ++index;
          try {
            await page.screenshot({
              path: join(output, `page-${id}.png`),
              fullPage: true,
              timeout: 5000,
            });
            await writeFile(
              join(output, `page-${id}.html`),
              await page.content(),
            );
          } catch (error) {
            errors.push({ phase: 'page', id, message: error.message });
          }
        }
        if (traces.has(context)) {
          try {
            await context.tracing.stop({
              path: join(output, `trace-${index}.zip`),
            });
          } catch (error) {
            errors.push({ phase: 'trace', message: error.message });
          }
        }
      }
      await writeFile(
        join(output, 'browser-evidence.json'),
        JSON.stringify({ pages: index, events, errors }, null, 2) + '\n',
      );
      return originalClose(...options);
    };
    return browser;
  };
}
