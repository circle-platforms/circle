/**
 * Arrange unmount during typing without sleeping or changing a product duration.
 * A real CSS exit, when the menu has one, is paused, then finished after the first
 * input has arrived.
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
        window.menuExitProbes[key] = { closed: true };
      });
    });
    return key;
  });
  return async () => {
    // Without an exit animation the menu unmounted on select, before the input began,
    // and nothing is left to return the focus later: where it is now is what counts.
    const early = await page.evaluate(
      (key) => !!window.menuExitProbes?.[key]?.closed,
      key,
    );
    if (early)
      return page.evaluate((key) => {
        delete window.menuExitProbes[key];
        return {
          closed: true,
          animated: false,
          terminal: document.activeElement?.closest('.native-terminal-surface')
            ?.id,
          tag: document.activeElement?.tagName,
          label: document.activeElement?.getAttribute('aria-label'),
        };
      }, key);
    // With an exit animation the menu stays while it plays: finish it.
    await page.waitForFunction(
      (key) =>
        window.menuExitProbes?.[key]?.closed ||
        !!document.querySelector(
          `[data-menu-exit-probe="${key}"][data-state="closed"]`,
        ),
      key,
    );
    await page.evaluate((key) => {
      const menu = document.querySelector(
        `[data-menu-exit-probe="${key}"][data-state="closed"]`,
      );
      for (const animation of menu?.getAnimations() ?? []) animation.finish();
    }, key);
    await page.waitForFunction(
      (key) => window.menuExitProbes?.[key]?.closed,
      key,
    );
    // Where the focus is now, not at the unmount: a menu with no exit has gone before
    // the input starts, and a focus taken back at the unmount is still gone from here.
    return page.evaluate((key) => {
      delete window.menuExitProbes[key];
      const active = document.activeElement;
      return {
        closed: true,
        terminal: active?.closest('.native-terminal-surface')?.id,
        tag: active?.tagName,
        label: active?.getAttribute('aria-label'),
      };
    }, key);
  };
}
