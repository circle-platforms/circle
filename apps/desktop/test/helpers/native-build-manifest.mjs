import path from 'node:path';

export function verifyNativeBuildManifest(manifest, executed) {
  if (!manifest || !/^[a-f0-9]{40}$/.test(manifest.sourceBuildHead ?? ''))
    throw Error('build manifest requires a full sourceBuildHead');
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length)
    throw Error('build manifest requires artifact hashes');
  const paths = executed.platform === 'win32' ? path.win32 : path.posix;
  const actual = new Map(
    executed.artifacts.map((entry) => [entry.path, entry.sha256]),
  );
  const seen = new Set();
  for (const entry of manifest.artifacts) {
    if (
      !paths.isAbsolute(entry.path ?? '') ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') ||
      seen.has(entry.path)
    )
      throw Error(
        'build manifest contains invalid or duplicate artifact identity',
      );
    seen.add(entry.path);
    if (!actual.has(entry.path))
      throw Error('manifest artifact is outside the executed application');
    if (actual.get(entry.path) !== entry.sha256)
      throw Error(
        'executed artifact hash does not match build manifest: ' + entry.path,
      );
  }
  for (const required of [
    executed.mainPath,
    executed.preloadPath,
    executed.rendererPath,
  ])
    if (!seen.has(required))
      throw Error(
        'build manifest is missing an executed main, preload or renderer artifact',
      );
  return { sourceBuildHead: manifest.sourceBuildHead, ...executed };
}

/** Hash only paths belonging to the actual running main window, including asar files. */
export async function executedNativeBuildEvidence(app, manifest) {
  return app.evaluate(async ({ app, BrowserWindow }, requested) => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const path = process.getBuiltinModule('node:path');
    const crypto = process.getBuiltinModule('node:crypto');
    const appPath = app.getAppPath();
    const pkg = JSON.parse(
      await fs.readFile(path.join(appPath, 'package.json'), 'utf8'),
    );
    const mainPath = path.resolve(appPath, pkg.main);
    const window = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith('circle://workbench/'),
    );
    if (!window) throw Error('executed workbench window is unavailable');
    const preloadPath = window.webContents.getLastWebPreferences().preload;
    const rendererPath = path.join(
      path.dirname(mainPath),
      'renderer',
      'index.html',
    );
    const rendererRoot = path.dirname(rendererPath);
    const workerPath = path.join(path.dirname(mainPath), 'runtime-worker.mjs');
    const artifacts = [];
    for (const entry of requested.artifacts ?? []) {
      if (
        !path.isAbsolute(entry.path ?? '') ||
        path.normalize(entry.path) !== entry.path
      )
        throw Error('manifest artifact requires an absolute normalized path');
      const relative = path.relative(rendererRoot, entry.path);
      const rendererAsset =
        relative !== '' &&
        relative !== '..' &&
        !relative.startsWith('..' + path.sep) &&
        !path.isAbsolute(relative);
      if (
        ![mainPath, preloadPath, workerPath].includes(entry.path) &&
        !rendererAsset
      )
        throw Error('manifest artifact is outside the executed application');
      artifacts.push({
        path: entry.path,
        sha256: crypto
          .createHash('sha256')
          .update(await fs.readFile(entry.path))
          .digest('hex'),
      });
    }
    return {
      platform: process.platform,
      isPackaged: app.isPackaged,
      appPath,
      mainPath,
      preloadPath,
      rendererPath,
      rendererURL: window.webContents.getURL(),
      artifacts,
    };
  }, manifest);
}
