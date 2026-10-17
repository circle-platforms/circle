import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'appearance.spec.mjs',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  updateSnapshots: 'none',
  snapshotPathTemplate: '{testDir}/baselines/{platform}/{testName}/{arg}{ext}',
  outputDir: '../../artifacts/visual/results',
  reporter: [
    ['list'],
    ['html', { outputFolder: '../../artifacts/visual/report', open: 'never' }],
  ],
  expect: { toMatchSnapshot: { threshold: 0.1, maxDiffPixels: 0 } },
});
