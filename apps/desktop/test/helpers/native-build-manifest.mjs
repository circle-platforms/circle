import path from 'node:path';

export function verifyNativeBuildManifest(manifest, executed) {
  if (!manifest || !/^[a-f0-9]{40}$/.test(manifest.sourceBuildHead ?? ''))
    throw Error('build manifest requires a full sourceBuildHead');
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length)
    throw Error('build manifest requires artifact hashes');
  const sourceKind = manifest.sourceKind ?? 'commit';
  if (sourceKind !== 'commit' && sourceKind !== 'working-tree')
    throw Error('unknown build source kind');
  if (
    sourceKind === 'working-tree' &&
    (manifest.sourceBaseHead !== manifest.sourceBuildHead ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceTreeSha256 ?? ''))
  )
    throw Error(
      'working-tree build requires its base HEAD and exact tree hash',
    );
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
    ...(executed.commandSupervisorManifestPath
      ? [executed.commandSupervisorManifestPath]
      : []),
  ])
    if (!seen.has(required))
      throw Error(
        'build manifest is missing an executed main, preload or renderer artifact',
      );
  return {
    ...executed,
    sourceKind,
    sourceBuildHead: manifest.sourceBuildHead,
    sourceTreeSha256: manifest.sourceTreeSha256,
    ...(sourceKind === 'working-tree'
      ? { sourceBaseHead: manifest.sourceBaseHead }
      : {}),
  };
}

/** Hash only paths belonging to the actual running main window, including asar files. */
export async function executedNativeBuildEvidence(app, manifest) {
  const page = await app.firstWindow();
  const session = await app.context().newCDPSession(page);
  const loadedScripts = [];
  session.on('Debugger.scriptParsed', (script) =>
    loadedScripts.push(script.url),
  );
  try {
    await session.send('Debugger.enable');
  } finally {
    await session.detach();
  }
  return app.evaluate(
    async ({ app, BrowserWindow }, { requested, loadedScripts }) => {
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
      const expectedPreload = path.join(path.dirname(mainPath), 'preload.cjs');
      const preloadPath = loadedScripts.find((url) => url === expectedPreload);
      if (!preloadPath)
        throw Error('executed preload script identity is unavailable');
      const rendererPath = path.join(
        path.dirname(mainPath),
        'renderer',
        'index.html',
      );
      const rendererRoot = path.dirname(rendererPath);
      const workerPath = path.join(
        path.dirname(mainPath),
        'runtime-worker.mjs',
      );
      const supervisorManifestPath = path.join(
        path.dirname(mainPath),
        'tools',
        'command-supervisor.mjs',
      );
      const commandSupervisorPath = supervisorManifestPath.replace(
        /([\\/])app\.asar([\\/])/,
        '$1app.asar.unpacked$2',
      );
      const nativeRoots = ['koffi', '@koromix'].map(
        (folder) =>
          path.join(path.dirname(mainPath), 'node_modules', folder) + path.sep,
      );
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
          ![mainPath, preloadPath, workerPath, supervisorManifestPath].includes(
            entry.path,
          ) &&
          !rendererAsset &&
          !nativeRoots.some((root) => entry.path.startsWith(root))
        )
          throw Error('manifest artifact is outside the executed application');
        artifacts.push({
          path: entry.path,
          sha256: crypto
            .createHash('sha256')
            .update(
              await fs.readFile(
                entry.path === supervisorManifestPath ||
                  nativeRoots.some((root) => entry.path.startsWith(root))
                  ? entry.path.replace(
                      /([\\/])app\.asar([\\/])/,
                      '$1app.asar.unpacked$2',
                    )
                  : entry.path,
              ),
            )
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
        commandSupervisorPath,
        commandSupervisorManifestPath: supervisorManifestPath,
        artifacts,
      };
    },
    { requested: manifest, loadedScripts },
  );
}
