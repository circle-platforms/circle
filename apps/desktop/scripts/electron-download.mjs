// How the packager gets Electron's archive: from the same folder the development install
// keeps it in, checked against the checksums that ship inside the installed electron
// package. Without them the downloader fetches SHASUMS256.txt from GitHub for every
// archive, cached or not, and a 504 there fails the package step.
//
// This file imports nothing that `npm ci` installs: the workflows run it with
// --configure-cache before the desktop application's packages are there.
import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * The folder `electron_config_cache` names, which the electron package's own install reads
 * too. Unset, there is nothing to pass: both then use the downloader's default folder.
 */
export const electronCacheRoot = (env = process.env) =>
  env.electron_config_cache ? resolve(env.electron_config_cache) : undefined;

/**
 * The checksums to verify one archive with. They are those of the installed electron
 * package, so they hold only for the version the manifest asks for and the lock file pins.
 */
export function validateElectronDownload({
  version,
  installedVersion,
  lockedVersion,
  checksums,
  platform,
  arch,
}) {
  if (
    !/^\d+\.\d+\.\d+$/.test(version) ||
    version !== installedVersion ||
    version !== lockedVersion
  )
    throw Error(
      `Electron version mismatch: requested ${version}, installed ${installedVersion}, locked ${lockedVersion}`,
    );
  const artifact = `electron-v${version}-${platform}-${arch}.zip`;
  if (!/^[a-f0-9]{64}$/.test(checksums?.[artifact] ?? ''))
    throw Error(`missing Electron SHA-256 checksum for ${artifact}`);
  return { checksums };
}

/** The packager's `download` option for one target. */
export async function electronDownloadOptions({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const json = async (path) =>
    JSON.parse(await readFile(join(root, path), 'utf8'));
  const [manifest, installed, lock, checksums] = await Promise.all([
    json('package.json'),
    json('node_modules/electron/package.json'),
    json('package-lock.json'),
    json('node_modules/electron/checksums.json'),
  ]);
  const cacheRoot = electronCacheRoot(env);
  return {
    ...validateElectronDownload({
      version: manifest.devDependencies.electron,
      installedVersion: installed.version,
      lockedVersion: lock.packages['node_modules/electron']?.version,
      checksums,
      platform,
      arch,
    }),
    ...(cacheRoot ? { cacheRoot } : {}),
  };
}

// A workflow step: every later step of the job, `npm ci` and the packager among them,
// keeps Electron's archive in the folder the job restores and saves.
if (process.argv[2] === '--configure-cache') {
  if (!process.env.GITHUB_ENV || !process.env.CIRCLE_ELECTRON_CACHE_ROOT)
    throw Error(
      'Electron cache configuration requires GITHUB_ENV and CIRCLE_ELECTRON_CACHE_ROOT',
    );
  await appendFile(
    process.env.GITHUB_ENV,
    `electron_config_cache=${resolve(process.env.CIRCLE_ELECTRON_CACHE_ROOT)}\n`,
  );
}
