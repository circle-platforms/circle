import {
  runtimeTestGroups,
  runRuntimeTestGroups,
} from './runtime-test-options.mjs';
import { readFile, readdir, stat, mkdir, mkdtemp } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEBUG_VERSION,
  GH_VERSION,
  NODE_VERSION,
  prepareDeveloperTools,
  verifyCommandSupervisor,
} from './developer-toolchain.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const target = `${process.platform}-${process.arch}`;
// Installation verifies archives and writes receipts. A routine test run checks the
// receipt and essential entries without rehashing hundreds of MB or downloading again.
async function prepared() {
  await verifyCommandSupervisor(dist);
  for (const [name, version, entry] of [
    [
      'node',
      NODE_VERSION,
      process.platform === 'win32' ? 'bin/node.exe' : 'bin/node',
    ],
    ['gh', GH_VERSION, process.platform === 'win32' ? 'bin/gh.exe' : 'bin/gh'],
    ['js-debug', DEBUG_VERSION, 'src/dapDebugServer.js'],
  ]) {
    const directory = join(dist, 'tools', name);
    const receipt = JSON.parse(
      await readFile(join(directory, 'circle-tool.json'), 'utf8'),
    );
    if (
      receipt.version !== version ||
      receipt.target !== target ||
      receipt.format !== 1 ||
      !/^[0-9a-f]{64}$/.test(receipt.sha256) ||
      !receipt.files?.[entry.split('/').join(sep)]
    )
      throw Error(`unprepared ${name} developer tool receipt`);
    if (name === 'node') {
      const npmEntry = join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (
        !receipt.files?.[npmEntry] ||
        !(await stat(join(directory, npmEntry))).isFile()
      )
        throw Error('missing bundled npm CLI');
    }
    if (!(await stat(join(directory, entry))).isFile())
      throw Error(`missing ${name} developer tool entry`);
  }
}
try {
  await prepared();
} catch {
  await prepareDeveloperTools(dist);
  await prepared();
}
if (process.argv.includes('--prepare-only')) {
  console.log(`Developer tool receipts ready for ${target}`);
} else {
  const tests = (await readdir(join(root, 'test')))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => join(root, 'test', name));
  const receipts = join(root, 'artifacts/runtime-progress/runner');
  await mkdir(receipts, { recursive: true });
  const result = runRuntimeTestGroups({
    executable: process.execPath,
    tsxPath: join(root, '../../node_modules/tsx/dist/cli.mjs'),
    groups: runtimeTestGroups(tests),
    ci: Boolean(process.env.CI && process.env.CI !== 'false'),
    receiptDirectory: await mkdtemp(join(receipts, 'attempt-')),
    env: {
      ...process.env,
      ...(process.env.CI && process.env.CI !== 'false'
        ? {
            CIRCLE_NATIVE_TEST_PROGRESS_DIR:
              process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR ??
              join(root, 'artifacts/runtime-progress'),
          }
        : {}),
      CIRCLE_JS_DEBUG_ADAPTER:
        process.env.CIRCLE_JS_DEBUG_ADAPTER ??
        join(dist, 'tools/js-debug/src/dapDebugServer.js'),
      CIRCLE_JS_DEBUG_RUNTIME:
        process.env.CIRCLE_JS_DEBUG_RUNTIME ??
        join(
          dist,
          'tools/node/bin',
          process.platform === 'win32' ? 'node.exe' : 'node',
        ),
    },
  });
  process.exitCode = result.exitCode;
}
