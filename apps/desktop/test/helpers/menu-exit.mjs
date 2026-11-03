/**
 * Arrange unmount during typing without sleeping or changing a product duration.
 * The real CSS exit is paused, then finished after the first input has arrived.
 */
export async function holdMenuExit(page, selector) {
  const key = await page.locator(selector).evaluate((menu) => {
    const key = crypto.randomUUID();
    menu.dataset.menuExitProbe = key;
    menu.style.animationPlayState = 'paused';
    window.menuExitProbes ??= {};
    menu.addEventListener('focusScope.autoFocusOnUnmount', () => {
      // Radix's default return focus runs after dispatch, in the same task.
      queueMicrotask(() => {
        window.menuExitProbes[key] = {
          closed: true,
          terminal: document.activeElement?.closest('.native-terminal-surface')
            ?.id,
          tag: document.activeElement?.tagName,
          label: document.activeElement?.getAttribute('aria-label'),
        };
      });
    });
    return key;
  });
  return async () => {
    await page
      .locator(`[data-menu-exit-probe="${key}"][data-state="closed"]`)
      .evaluate((menu) => {
        const animations = menu.getAnimations();
        if (!animations.length)
          throw Error('expected the actual menu exit animation');
        for (const animation of animations) animation.finish();
      });
    await page.waitForFunction(
      (key) => window.menuExitProbes?.[key]?.closed,
      key,
    );
    return page.evaluate((key) => {
      const observed = window.menuExitProbes[key];
      delete window.menuExitProbes[key];
      return observed;
    }, key);
  };
}
