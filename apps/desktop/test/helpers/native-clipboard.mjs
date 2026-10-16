import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { open, mkdtemp, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import {
  writeClipboardCheckpoint,
  readClipboardCheckpoint,
  removeClipboardCheckpoint,
} from './native-clipboard-checkpoint.mjs';
const durable = new Map();
import { access, unlink } from 'node:fs/promises';
/** Original payloads are checkpointed privately before callers may change the clipboard. */
export async function preserveNativeClipboard(app, options) {
  const key = crypto.randomUUID();
  const captured = await app.evaluate(
    async ({ clipboard, ClipboardItem }, key) => {
      const snapshots = (globalThis.__circleJourneyClipboard ??= new Map());
      // Electron 44 read() items are not writable instances. Materialize all
      // formats before changing the system clipboard, then construct fresh items.
      const originals = (await clipboard.read()).filter(
        (item) => item.types.length > 0,
      );
      if (
        originals.length > 64 ||
        originals.reduce((n, item) => n + item.types.length, 0) > 256
      )
        throw Error('clipboard checkpoint exceeds format limit');
      let size = 0;
      const entries = await Promise.all(
        originals.map(async (item) =>
          Promise.all(
            item.types.map(async (readType) => {
              const value = await item.getType(readType);
              const type =
                process.platform === 'darwin' && readType === 'text/html'
                  ? 'electron application/osclipboard;format="public.html"'
                  : readType;
              if (value && typeof value.arrayBuffer === 'function') {
                size += value.size;
                if (size > 16 * 1024 * 1024)
                  throw Error('clipboard checkpoint exceeds byte limit');
                return {
                  value,
                  entry: {
                    type,
                    readType,
                    kind: 'bytes',
                    mime: value.type ?? '',
                    bytes: Array.from(
                      new Uint8Array(await value.arrayBuffer()),
                    ),
                  },
                };
              }
              if (
                readType === 'electron application/bookmark' &&
                typeof value?.title === 'string' &&
                typeof value?.url === 'string'
              ) {
                size += value.title.length * 2 + value.url.length * 2;
                if (size > 16 * 1024 * 1024)
                  throw Error('clipboard checkpoint exceeds byte limit');
                return {
                  value,
                  entry: {
                    type,
                    readType,
                    kind: 'bookmark',
                    value: { title: value.title, url: value.url },
                  },
                };
              }
              throw Error(
                'unsupported native clipboard value; clipboard was not changed',
              );
            }),
          ),
        ),
      );
      const items = entries.map(
        (item) =>
          new ClipboardItem(
            Object.fromEntries(
              item.map(({ value, entry }) => [entry.type, value]),
            ),
          ),
      );
      const payload = entries.map((item) => item.map(({ entry }) => entry));
      snapshots.set(key, items);
      return { payload, executable: process.execPath };
    },
    key,
  );
  try {
    const { checkpointWriter = writeClipboardCheckpoint, ...settings } =
      options ?? {};
    // A packaged Circle executable ignores arbitrary main scripts. Recovery
    // uses the pinned stock Electron test dependency, never PATH or the app binary.
    const executable = createRequire(import.meta.url)('electron');
    if (
      typeof executable !== 'string' ||
      !isAbsolute(executable) ||
      !(await stat(executable)).isFile()
    )
      throw Error('pinned clipboard recovery Electron is unavailable');
    const checkpoint = await checkpointWriter(captured.payload, settings);
    durable.set(key, {
      ...checkpoint,
      executable: await realpath(executable),
      sourceExecutable: captured.executable,
    });
  } catch (error) {
    await app
      .evaluate(
        (_electron, key) => globalThis.__circleJourneyClipboard?.delete(key),
        key,
      )
      .catch(() => {});
    throw error;
  }
  return key;
}
async function restoreInOwner(app, key) {
  await app.evaluate(async ({ clipboard }, key) => {
    const snapshots = globalThis.__circleJourneyClipboard;
    if (!snapshots?.has(key))
      throw Error('native clipboard checkpoint is unavailable');
    const items = snapshots.get(key);
    if (items.length) await clipboard.write(items);
    else await clipboard.clear();
  }, key);
}

export async function restoreNativeClipboard(
  app,
  key,
  { recover = restoreClipboardInIsolatedElectron } = {},
) {
  const checkpoint = durable.get(key);
  if (!checkpoint) throw Error('native clipboard checkpoint is unavailable');
  const payload = await readClipboardCheckpoint(checkpoint);
  let recovery;
  try {
    await restoreInOwner(app, key);
    await app.evaluate(verifyNativeClipboardPayload, payload);
    await app.evaluate((_electron, key) => {
      const map = globalThis.__circleJourneyClipboard;
      map?.delete(key);
      if (!map?.size) delete globalThis.__circleJourneyClipboard;
    }, key);
  } catch (error) {
    if (
      !/closed|destroyed|disconnected/i.test(String(error)) &&
      !String(error).includes('native clipboard checkpoint is unavailable')
    )
      throw error;
    try {
      recovery = await recover(checkpoint);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'native clipboard owner is gone and durable recovery failed; checkpoint retained',
        { cause: error },
      );
    }
  }
  await removeClipboardCheckpoint(checkpoint);
  durable.delete(key);
  return {
    method: recovery ? 'isolated stock Electron' : 'original owner',
    recovery,
  };
}

/** Standalone Electron main callback; compares canonical read formats and complete bytes. */
export async function verifyNativeClipboardPayload({ clipboard }, payload) {
  const actual = (await clipboard.read()).filter(
    (item) => item.types.length > 0,
  );
  if (actual.length !== payload.length)
    throw Error('clipboard restored item count does not match');
  for (let i = 0; i < payload.length; i++) {
    const types = [...new Set(payload[i].map((e) => e.readType))].sort();
    if (JSON.stringify([...actual[i].types].sort()) !== JSON.stringify(types))
      throw Error('clipboard restored formats do not match');
    for (const entry of payload[i]) {
      const value = await actual[i].getType(entry.readType);
      if (entry.kind === 'bytes') {
        if (
          !value ||
          JSON.stringify(
            Array.from(new Uint8Array(await value.arrayBuffer())),
          ) !== JSON.stringify(entry.bytes)
        )
          throw Error('clipboard restoration byte verification failed');
      } else if (
        value?.title !== entry.value.title ||
        value?.url !== entry.value.url
      )
        throw Error('clipboard bookmark restoration did not verify');
    }
  }
}

export async function restoreClipboardInIsolatedElectron(checkpoint) {
  const payload = await readClipboardCheckpoint(checkpoint);
  if (!checkpoint.executable)
    throw Error(
      'clipboard recovery executable is unavailable; checkpoint retained',
    );
  const recoveryDirectory = await realpath(
    await mkdtemp(join(checkpoint.directory, 'recovery-')),
  );
  await chmod(recoveryDirectory, 0o700);
  const main = join(recoveryDirectory, 'main.cjs');
  const script = await open(main, 'wx', 0o600);
  try {
    await script.writeFile(
      "const {app}=require('electron');app.setPath('userData',process.env.CIRCLE_CLIPBOARD_RECOVERY_DATA);app.whenReady().then(()=>{globalThis.__circleClipboardRecoveryMarker=true;});",
    );
    await script.sync();
  } finally {
    await script.close();
  }
  const { _electron } = await import('playwright');
  const env = {
    PATH: process.env.PATH,
    HOME: checkpoint.directory,
    USERPROFILE: checkpoint.directory,
    CIRCLE_CLIPBOARD_RECOVERY_DATA: join(recoveryDirectory, 'data'),
  };
  for (const name of [
    'SystemRoot',
    'WINDIR',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
  ])
    if (process.env[name]) env[name] = process.env[name];
  const recovery = await _electron.launch({
    executablePath: checkpoint.executable,
    args: [main],
    env,
  });
  let primary;
  try {
    await recovery.evaluate(
      ({ app, BrowserWindow }, expected) => {
        if (
          globalThis.__circleClipboardRecoveryMarker !== true ||
          BrowserWindow.getAllWindows().length !== 0 ||
          app.getAppPath() !== expected.mainDirectory ||
          app.getPath('userData') !== expected.userData
        )
          throw Error(
            'isolated clipboard recovery identity did not verify: ' +
              JSON.stringify({
                marker: globalThis.__circleClipboardRecoveryMarker === true,
                windows: BrowserWindow.getAllWindows().length,
                appPath: app.getAppPath(),
                userData: app.getPath('userData'),
                expected,
              }),
          );
      },
      {
        mainDirectory: recoveryDirectory,
        userData: join(recoveryDirectory, 'data'),
      },
    );
    await recovery.evaluate(async ({ clipboard, ClipboardItem }, payload) => {
      const items = payload.map(
        (item) =>
          new ClipboardItem(
            Object.fromEntries(
              item.map((e) => [
                e.type,
                e.kind === 'bytes'
                  ? new Blob([new Uint8Array(e.bytes)], { type: e.mime })
                  : e.value,
              ]),
            ),
          ),
      );
      if (items.length) await clipboard.write(items);
      else await clipboard.clear();
    }, payload);
    await recovery.evaluate(verifyNativeClipboardPayload, payload);
    return {
      identityVerified: true,
      windows: 0,
      formatsAndBytesVerified: true,
      executable: checkpoint.executable,
      sourceExecutable: checkpoint.sourceExecutable,
    };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await recovery.close();
    } catch (closeError) {
      throw new AggregateError(
        primary ? [primary, closeError] : [closeError],
        'native clipboard recovery process cleanup failed; checkpoint retained',
        primary ? { cause: primary } : undefined,
      );
    }
  }
}

/** Never close the owner application while its only original backup is in main. */
export async function restoreNativeClipboardWithRecovery(
  app,
  key,
  { retryPath, onFailure },
) {
  for (;;) {
    try {
      await restoreNativeClipboard(app, key);
      return;
    } catch (error) {
      await onFailure(error);
      for (;;) {
        try {
          await access(retryPath);
          await unlink(retryPath);
          break;
        } catch (markerError) {
          if (markerError.code !== 'ENOENT') throw markerError;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
}

export function nativeClipboardCheckpointMetadata(key) {
  const value = durable.get(key);
  return value ? { ...value } : undefined;
}

/** Safe host-side keys remain available even when the original main process exits. */
export function pendingNativeClipboardCheckpoints() {
  return [...durable.keys()];
}
