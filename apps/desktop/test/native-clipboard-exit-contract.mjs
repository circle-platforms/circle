import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  preserveNativeClipboard,
  restoreNativeClipboard,
  nativeClipboardCheckpointMetadata,
} from './helpers/native-clipboard.mjs';
const output = resolve(
  process.env.CIRCLE_CLIPBOARD_EXIT_EVIDENCE ??
    'artifacts/clipboard-exit-contract',
);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'circle-clipboard-exit-'));
const home = join(scratch, 'home');
await mkdir(home);
const fixture = join(scratch, 'model.json');
await writeFile(fixture, JSON.stringify({ replies: [] }));
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ZDOTDIR: home,
  HISTFILE: '/dev/null',
  ENV: '/dev/null',
  CIRCLE_HOME: home,
  CIRCLE_WORKBENCH_DATA_DIR: join(scratch, 'data'),
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_LANGUAGE: 'en',
  CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixture,
};
for (const key of [
  'ELECTRON_RUN_AS_NODE',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
])
  delete env[key];
let owner, outer, inner, primary;
const receipt = { status: 'failed', cleanup: {} };
try {
  owner = await _electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ??
      createRequire(import.meta.url)('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? 'apps/desktop')],
    env,
  });
  await owner.firstWindow();
  receipt.source = await owner.evaluate(({ app, BrowserWindow }) => ({
    executable: process.execPath,
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    pid: process.pid,
    windows: BrowserWindow.getAllWindows().length,
  }));
  outer = await preserveNativeClipboard(owner); // MUST finish durable commit before any system mutation.
  receipt.originalCheckpointCommitted = true;
  await owner.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const png = nativeImage
      .createFromBitmap(Buffer.from([10, 20, 30, 255]), { width: 1, height: 1 })
      .toPNG();
    await clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob(['synthetic clipboard exit plain']),
        'text/html': new Blob(['<b>synthetic clipboard exit HTML</b>'], {
          type: 'text/html',
        }),
        'image/png': new Blob([png], { type: 'image/png' }),
      }),
    ]);
  });
  inner = await preserveNativeClipboard(owner);
  const metadata = nativeClipboardCheckpointMetadata(inner);
  receipt.syntheticCheckpointMetadata = metadata;
  receipt.syntheticCheckpointCommitted = true;
  await owner.evaluate(async ({ clipboard }) =>
    clipboard.writeText('synthetic replacement'),
  );
  await owner.close();
  receipt.originalOwnerActuallyClosed = true;
  const recovered = await restoreNativeClipboard(owner, inner);
  inner = undefined;
  assert.equal(recovered.method, 'isolated stock Electron');
  assert.equal(recovered.recovery.identityVerified, true);
  assert.equal(recovered.recovery.windows, 0);
  assert.equal(recovered.recovery.formatsAndBytesVerified, true);
  assert.notEqual(
    recovered.recovery.executable,
    receipt.source.packaged
      ? receipt.source.executable
      : 'not a packaged executable',
  );
  await assert.rejects(stat(metadata.file), (e) => e.code === 'ENOENT');
  receipt.recovery = recovered;
  receipt.syntheticCheckpointRemovedOnlyAfterExactReadback = true;
  receipt.status = 'passed';
} catch (error) {
  primary = error;
  receipt.error = String(error);
} finally {
  const failures = [];
  if (inner)
    try {
      await restoreNativeClipboard(owner, inner);
    } catch (error) {
      failures.push(error);
      receipt.cleanup.syntheticRecoveryError = String(error);
    }
  if (outer)
    try {
      receipt.cleanup.original = await restoreNativeClipboard(owner, outer);
      receipt.cleanup.originalClipboardRestored = true;
    } catch (error) {
      failures.push(error);
      receipt.cleanup.originalRestoreError = String(error);
      receipt.cleanup.retainedCheckpoint =
        nativeClipboardCheckpointMetadata(outer);
    }
  if (owner && !receipt.originalOwnerActuallyClosed) {
    try {
      await owner.close();
      receipt.cleanup.ownerClosed = true;
    } catch (error) {
      failures.push(error);
      receipt.cleanup.ownerCloseError = String(error);
    }
  }
  if (!failures.length && !primary) {
    try {
      await rm(scratch, { recursive: true });
      receipt.cleanup.profileRemoved = true;
    } catch (error) {
      failures.push(error);
      receipt.cleanup.profileRemovalError = String(error);
    }
  } else receipt.cleanup.retainedProfile = scratch;
  if (failures.length) receipt.status = 'failed';
  try {
    await writeFile(
      join(output, 'receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(
      primary ? [primary, ...failures] : failures,
      'clipboard exit contract failed; durable backups retained',
      primary ? { cause: primary } : undefined,
    );
}
if (primary) throw primary;
console.log(
  'Clipboard owner-exit contract passed; all formats restored and checkpoints removed',
);
