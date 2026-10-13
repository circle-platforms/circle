import assert from 'node:assert/strict';

export const readViewport = (page) =>
  page.evaluate(() => ({ width: innerWidth, height: innerHeight }));

// Native content bounds cross physical pixels before returning to CSS pixels.
// Use the smallest whole CSS-pixel rounding bound at the display's scale, while
// keeping the maximum strict so a narrow test cannot run above its breakpoint.
export function assertViewport(actual, target, scaleFactor) {
  assert.ok(Number.isFinite(scaleFactor) && scaleFactor > 0);
  const rounding = Math.ceil(1 / scaleFactor);
  for (const dimension of ['width', 'height']) {
    assert.ok(
      actual[dimension] <= target[dimension] &&
        actual[dimension] >= target[dimension] - rounding,
      `${dimension}: requested at most ${target[dimension]}, got ${actual[dimension]} (display scale ${scaleFactor})`,
    );
  }
}

export async function setViewport(app, page, target, { show = false } = {}) {
  for (const dimension of ['width', 'height'])
    assert.ok(Number.isSafeInteger(target[dimension]) && target[dimension] > 0);
  let requested = { ...target };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const scaleFactor = await app.evaluate(
      ({ BrowserWindow, screen }, { requested, show }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (show) window.show();
        window.setContentSize(requested.width, requested.height);
        return screen.getDisplayMatching(window.getBounds()).scaleFactor;
      },
      { requested, show },
    );
    assert.ok(Number.isFinite(scaleFactor) && scaleFactor > 0);
    const rounding = Math.ceil(1 / scaleFactor);
    const settled = await page.waitForFunction(
      ({ requested, rounding }) =>
        Math.abs(innerWidth - requested.width) <= rounding &&
        Math.abs(innerHeight - requested.height) <= rounding,
      { requested, rounding },
    );
    await settled.dispose();
    const actual = await readViewport(page);
    if (actual.width <= target.width && actual.height <= target.height) {
      assertViewport(actual, target, scaleFactor);
      return { target, actual, scaleFactor, attempts: attempt };
    }
    // Compensate only for the measured rounding overshoot, then verify again.
    requested = {
      width: requested.width - Math.max(0, actual.width - target.width),
      height: requested.height - Math.max(0, actual.height - target.height),
    };
  }
  throw Error(`native viewport did not fit ${target.width}×${target.height}`);
}
