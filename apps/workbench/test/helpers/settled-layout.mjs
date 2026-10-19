/** The boxes the workspace lays out around the browser's page. */
export const BROWSER_LAYOUT = [
  '#main',
  '.inspector-column',
  '.overview-column',
  '.work-drawer',
  '.inspector-full',
  '.browser-tabs',
  '.browser-address',
  '.native-browser-frame',
  '.native-browser-viewport',
  '.composer-area',
];

/**
 * Waits until two animation frames in a row lay out the same boxes. Opening a mode steps
 * the overview aside and sizes the drawer's column over a frame or two: a picture or a
 * measurement taken before that shows neither layout.
 */
export async function settledLayout(page, selectors = BROWSER_LAYOUT) {
  let previous = '';
  for (let attempt = 0; attempt < 50; attempt++) {
    const boxes = await page.evaluate(
      (selectors) =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve(
                JSON.stringify(
                  selectors.map((selector) => {
                    const node = document.querySelector(selector);
                    if (!node) return null;
                    const box = node.getBoundingClientRect();
                    return [box.x, box.y, box.width, box.height];
                  }),
                ),
              ),
            ),
          ),
        ),
      selectors,
    );
    if (boxes === previous) return;
    previous = boxes;
  }
  throw Error('the layout did not settle: ' + previous);
}
