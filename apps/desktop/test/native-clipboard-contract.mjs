// Actual Electron ClipboardItem contract. User data stays exclusively in main memory.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  preserveNativeClipboard,
  restoreNativeClipboard,
} from './helpers/native-clipboard.mjs';
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-clipboard-contract-'));
const output =
  process.env.CIRCLE_NATIVE_CLIPBOARD_EVIDENCE ??
  join(tmpdir(), 'circle-clipboard-evidence-' + crypto.randomUUID());
await mkdir(output, { recursive: true });
const entry = join(temp, 'main.cjs');
await writeFile(
  entry,
  "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{globalThis.contractWindow=new BrowserWindow({show:false});});",
);
let app,
  key,
  restored = false,
  error;
const report = { kind: 'actual Electron44 ClipboardItem contract', checks: [] };
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [entry],
    env: {
      ...process.env,
      HOME: temp,
      CIRCLE_HOME: join(temp, 'circle'),
      CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
    },
  });
  report.runtime = await app.evaluate(() => ({
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
  }));
  key = await preserveNativeClipboard(app); // Complete every getType/clone before any write.
  const fingerprint = () =>
    app.evaluate(async ({ clipboard }) => {
      const result = {};
      for (const item of await clipboard.read())
        for (const type of ['text/plain', 'text/html', 'image/png'])
          if (item.types.includes(type)) {
            const value = await item.getType(type);
            const data = await value.arrayBuffer();
            result[type] = {
              bytes: data.byteLength,
              sha256: Buffer.from(
                await crypto.subtle.digest('SHA-256', data),
              ).toString('hex'),
            };
          }
      return result;
    });
  await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    await clipboard.write([
      new ClipboardItem({
        'text/plain': 'CIRCLE_SYNTHETIC_CLIPBOARD_ALPHA',
        'text/html': '<b>CIRCLE_SYNTHETIC_CLIPBOARD_ALPHA</b>',
        'image/png': new Blob(
          [
            nativeImage
              .createFromBitmap(Buffer.from([10, 20, 30, 255]), {
                width: 1,
                height: 1,
              })
              .toPNG(),
          ],
          {
            type: 'image/png',
          },
        ),
      }),
    ]);
  }, png);
  const expected = await fingerprint();
  assert.deepEqual(Object.keys(expected).sort(), [
    'image/png',
    'text/html',
    'text/plain',
  ]);
  const fixtureKey = await preserveNativeClipboard(app);
  await app.evaluate(async ({ clipboard }) => {
    await clipboard.writeText('CIRCLE_SYNTHETIC_CLIPBOARD_BETA');
  });
  await restoreNativeClipboard(app, fixtureKey);
  assert.deepEqual(await fingerprint(), expected);
  report.checks.push('actual native PNG HTML and text restored byte-for-byte');
  const failureKey = await preserveNativeClipboard(app);
  await app.evaluate(async ({ clipboard }) => {
    await clipboard.writeText('CIRCLE_SYNTHETIC_FAILURE');
  });
  try {
    throw Error('synthetic journey phase failure');
  } catch {
    assert.equal(app.process().exitCode, null);
    assert.equal(
      await app.evaluate(
        (_, key) => globalThis.__circleJourneyClipboard.has(key),
        failureKey,
      ),
      true,
    );
    await restoreNativeClipboard(app, failureKey);
  }
  assert.deepEqual(await fingerprint(), expected);
  report.checks.push(
    'phase failure leaves actual app and checkpoint alive until explicit successful recovery',
  );
  await restoreNativeClipboard(app, key);
  restored = true;
  report.checks.push(
    'previous clipboard restored entirely in main process before closing',
  );
  report.fixtureFingerprints = expected;
  report.status = 'passed';
} catch (caught) {
  error = caught;
  report.status = 'failed';
  report.error = String(caught);
  report.stack = caught.stack;
  if (app && key && !restored) {
    try {
      await restoreNativeClipboard(app, key);
      restored = true;
      report.recovery = 'previous clipboard restored after failure';
    } catch (restoreError) {
      report.restoreError = String(restoreError);
    }
  }
} finally {
  report.previousClipboardRestored = restored;
  if (app && restored) {
    await app.close();
    report.applicationClosed = true;
    await rm(temp, { recursive: true, force: true });
  } else if (app) {
    report.applicationClosed = false;
    report.backupRetainedInLiveMain = true;
  }
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(report, null, 2),
  );
}
if (app && !restored) {
  console.error(
    'Clipboard recovery failed: app and main-process checkpoint retained; no automatic close',
  );
  setInterval(() => {}, 1000);
} else if (error) throw error;
else
  console.log(
    'PASS actual Electron clipboard contract; previous clipboard restored before application close',
  );
