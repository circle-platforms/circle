import { test, expect } from 'playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const exec = promisify(execFile);
const workbench = fileURLToPath(new URL('../..', import.meta.url));
const suites = [
  ['main and original panels', 'original-shell-ui.mjs', 64],
  ['git', 'git-conflict-selector-ui.mjs', 8],
  ['debug', 'debug-panel-embedded.mjs', 8],
  ['github', 'github-plugin-ui.mjs', 16],
  ['recovered inputs', 'recovered-input-ui.mjs', 16],
  ['native browser panel', 'original-browser-shell-ui.mjs', 28],
  ['file headers', 'file-source-heading-ui.mjs', 16],
];

for (const [name, script, minimum] of suites) {
  test(name, async ({}, info) => {
    const output = info.outputPath('screenshots');
    await mkdir(output, { recursive: true });
    // Reuse the existing scenarios and their real behavior assertions.
    await exec(
      process.execPath,
      ['--import', 'tsx', join(workbench, 'test', script)],
      {
        cwd: resolve(workbench, '../..'),
        maxBuffer: 8 * 1024 * 1024,
        timeout: 150_000,
        env: {
          ...process.env,
          CIRCLE_HOME: join(output, 'home'),
          CIRCLE_COMPONENT_UI_EVIDENCE: output,
          CIRCLE_UI_EVIDENCE: output,
          CIRCLE_DEBUG_EMBEDDED_EVIDENCE: output,
          CIRCLE_BROWSER_UI_EVIDENCE: output,
          CIRCLE_RECOVERY_UI_EVIDENCE_DIR: output,
          CIRCLE_BROWSER_SHELL_EVIDENCE: output,
          CIRCLE_SOURCE_HEADER_EVIDENCE: output,
        },
      },
    );
    const files = (await readdir(output))
      .filter((file) => file.endsWith('.png'))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(minimum);
    for (const file of files) {
      const bytes = await readFile(join(output, file));
      await info.attach(file, { body: bytes, contentType: 'image/png' });
      expect.soft(bytes).toMatchSnapshot(file);
    }
  });
}
