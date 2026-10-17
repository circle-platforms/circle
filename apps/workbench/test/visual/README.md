# Desktop appearance regression

Run `npm --prefix apps/workbench run test:visual` after installing the browser pinned by Playwright:

```sh
node apps/workbench/node_modules/playwright/cli.js install chromium
```

The test reuses the existing main-window, panel, Git, GitHub, debugger, browser diagnostics and recovered-input scenarios. They load the application's styles. Both languages, both themes and narrow/wide viewports are captured. These renderer fixtures complement the real Electron interface and developer journeys; they do not replace them.

PNG differences fail the test and produce expected, actual and diff images in `apps/workbench/artifacts/visual/`. The HTML report includes every captured image. Apple silicon CI runs the comparison without updating snapshots.

Generate local review candidates with `npm --prefix apps/workbench run test:visual -- --update-snapshots=all`. Review the images before including baseline changes in a PR. A successful comparison against newly generated images is not visual approval. Do not merge changed baselines until the owner confirms their appearance. CI never updates them.

Baselines are platform-specific. The current 193-image review candidate set was captured on macOS 27.0.1 (arm64); system font changes on CI may produce differences that require review, not automatic acceptance. The current set targets macOS. Use the bundled Chromium for consistent rendering; an alternate browser channel requires its own baseline review.
