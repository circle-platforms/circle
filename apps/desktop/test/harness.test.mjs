import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertViewport, setViewport } from './helpers/viewport.mjs';

for (const { entryName, overridden } of [
  'browser-coordinate-live.mjs',
  'extensions-native.mjs',
].flatMap((entryName) =>
  [false, true].map((overridden) => ({ entryName, overridden })),
)) {
  test(`${entryName} normalizes the ${overridden ? 'overridden' : 'default'} application path before launching`, (t) => {
    const temp = mkdtempSync(join(tmpdir(), 'circle-coordinate-launch-'));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const capture = join(temp, 'launch.json');
    const hook = join(temp, 'launch-hook.mjs');
    const native = `
      import { writeFileSync } from 'node:fs';
      export const _electron = { async launch(options) {
        writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: options.args, cwd: options.cwd }));
        throw Error('native launch captured');
      } };
    `;
    writeFileSync(
      hook,
      `import { registerHooks } from 'node:module';
       registerHooks({ resolve(specifier, context, nextResolve) {
         if (specifier === 'playwright') return {
           url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(native)}), shortCircuit: true
         };
         return nextResolve(specifier, context);
       } });`,
    );
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const entry = fileURLToPath(new URL(entryName, import.meta.url));
    const env = {
      ...process.env,
      CIRCLE_DESKTOP_EXECUTABLE: 'fixture-electron-not-started',
      CIRCLE_HOME: join(temp, 'home'),
      CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
    };
    delete env.CIRCLE_DESKTOP_APP_PATH;
    const override = join(temp, 'package with spaces') + sep;
    if (overridden) env.CIRCLE_DESKTOP_APP_PATH = override;
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(hook).href, entry],
      { env, encoding: 'utf8', timeout: 10_000, windowsHide: true },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /native launch captured/);
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      args: [overridden ? resolve(override) : root],
      cwd: root,
    });
  });
}

test('native viewport checks preserve the requested maximum at each display scale', () => {
  const target = { width: 800, height: 650 };
  for (const scale of [1, 1.25, 1.5, 2]) {
    assertViewport(target, target, scale);
    assertViewport({ width: 799, height: 649 }, target, scale);
    assert.throws(() =>
      assertViewport({ width: 801, height: 650 }, target, scale),
    );
    assert.throws(() =>
      assertViewport({ width: 800, height: 651 }, target, scale),
    );
    assert.throws(() =>
      assertViewport({ width: 798, height: 650 }, target, scale),
    );
  }
});

test('native viewport sizing compensates for measured DPI rounding', async () => {
  const requested = [];
  let actual;
  const app = {
    evaluate: async (_callback, input) => {
      requested.push(input.requested);
      actual = {
        width: input.requested.width + 1,
        height: input.requested.height + 1,
      };
      return { scaleFactor: 1.25, room: { width: 4000, height: 4000 } };
    },
  };
  const page = {
    waitForFunction: async (_callback, input) => {
      assert.ok(
        Math.abs(actual.width - input.expected.width) <= input.rounding,
      );
      assert.ok(
        Math.abs(actual.height - input.expected.height) <= input.rounding,
      );
      return { dispose: async () => {} };
    },
    evaluate: async () => actual,
  };
  const viewport = await setViewport(app, page, { width: 800, height: 650 });
  assert.deepEqual(requested, [
    { width: 800, height: 650 },
    { width: 799, height: 649 },
  ]);
  assert.deepEqual(viewport.actual, { width: 800, height: 650 });
  assert.equal(viewport.scaleFactor, 1.25);
  assert.equal(viewport.attempts, 2);
});

test('native viewport sizing asks a short display for the height it has', async () => {
  const requested = [];
  let actual;
  const app = {
    evaluate: async (_callback, input) => {
      requested.push(input.requested);
      actual = { width: input.requested.width, height: 677 };
      return { scaleFactor: 1, room: { width: 1024, height: 677 } };
    },
  };
  const page = {
    waitForFunction: async (_callback, input) => {
      assert.deepEqual(input.expected, { width: 1024, height: 677 });
      return { dispose: async () => {} };
    },
    evaluate: async () => actual,
  };
  const viewport = await setViewport(app, page, { width: 1024, height: 768 });
  assert.deepEqual(requested, [{ width: 1024, height: 768 }]);
  assert.deepEqual(viewport.target, { width: 1024, height: 677 });
  assert.deepEqual(viewport.actual, { width: 1024, height: 677 });
  assert.equal(viewport.attempts, 1);
});

test('native viewport sizing rejects a window that is substantially too small', async () => {
  const app = {
    evaluate: async () => ({
      scaleFactor: 1.25,
      room: { width: 4000, height: 4000 },
    }),
  };
  const page = {
    waitForFunction: async () => ({ dispose: async () => {} }),
    evaluate: async () => ({ width: 780, height: 650 }),
  };
  await assert.rejects(
    setViewport(app, page, { width: 800, height: 650 }),
    /requested at most 800, got 780/,
  );
});
