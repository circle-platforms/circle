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

// A display shorter than the request (a CI runner's 1024×768 screen holds 677 CSS pixels
// of content under the menu bar, the Dock and the title bar) keeps the window within its
// work area: the height asked for is what fits, and the width is what the checks are about.
export async function setViewport(app, page, target, { show = false } = {}) {
  for (const dimension of ['width', 'height'])
    assert.ok(Number.isSafeInteger(target[dimension]) && target[dimension] > 0);
  let fitted;
  let requested = { ...target };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { scaleFactor, room } = await app.evaluate(
      ({ BrowserWindow, screen }, { requested, show }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (show) window.show();
        const display = screen.getDisplayMatching(window.getBounds());
        const [outerWidth, outerHeight] = window.getSize();
        const [contentWidth, contentHeight] = window.getContentSize();
        // What the display's work area leaves for content beside the window's frame
        const room = {
          width: display.workAreaSize.width - (outerWidth - contentWidth),
          height: display.workAreaSize.height - (outerHeight - contentHeight),
        };
        window.setContentSize(
          requested.width,
          Math.min(requested.height, room.height),
        );
        return { scaleFactor: display.scaleFactor, room };
      },
      { requested, show },
    );
    assert.ok(Number.isFinite(scaleFactor) && scaleFactor > 0);
    fitted ??= {
      width: target.width,
      height: Math.min(target.height, room.height),
    };
    const expected = {
      width: requested.width,
      height: Math.min(requested.height, room.height),
    };
    const rounding = Math.ceil(1 / scaleFactor);
    const settled = await page.waitForFunction(
      ({ expected, rounding }) =>
        Math.abs(innerWidth - expected.width) <= rounding &&
        Math.abs(innerHeight - expected.height) <= rounding,
      { expected, rounding },
    );
    await settled.dispose();
    const actual = await readViewport(page);
    if (actual.width <= fitted.width && actual.height <= fitted.height) {
      assertViewport(actual, fitted, scaleFactor);
      return {
        requested: target,
        target: fitted,
        actual,
        scaleFactor,
        room,
        attempts: attempt,
      };
    }
    // Compensate only for the measured rounding overshoot, then verify again.
    // Height may already have been fitted to the work area. Adjust what was sent to
    // Electron, otherwise reducing a taller original request just fits it to the same
    // height again on the next attempt.
    requested = {
      width: expected.width - Math.max(0, actual.width - fitted.width),
      height: expected.height - Math.max(0, actual.height - fitted.height),
    };
  }
  throw Error(`native viewport did not fit ${target.width}×${target.height}`);
}
