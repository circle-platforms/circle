import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NODE_VERSION = '24.21.0';
const nodeAssets = {
  'darwin-arm64': [
    'darwin-arm64.tar.gz',
    'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  ],
  'darwin-x64': [
    'darwin-x64.tar.gz',
    '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
  ],
  'linux-arm64': [
    'linux-arm64.tar.gz',
    '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
  ],
  'linux-x64': [
    'linux-x64.tar.gz',
    '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
  ],
  'win32-x64': [
    'win-x64.zip',
    '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
  ],
};
export const GH_VERSION = '2.83.2';
export const DEBUG_VERSION = '1.140.0';
const ghAssets = {
  'darwin-arm64': [
    'macOS_arm64.zip',
    'ba3e0396ebbc8da17256144ddda503e4e79c8b502166335569f8390d6b75fa8d',
  ],
  'darwin-x64': [
    'macOS_amd64.zip',
    '6f1712519ccc768946791dc97da407bf188582345b73fef3d604d050ebf6f614',
  ],
  'linux-x64': [
    'linux_amd64.tar.gz',
    'ca6e7641214fbd0e21429cec4b64a7ba626fd946d8f9d6d191467545b092015e',
  ],
  'linux-arm64': [
    'linux_arm64.tar.gz',
    'b1a0c0a0fcf18524e36996caddc92a062355ed014defc836203fe20fba75a38e',
  ],
  'win32-x64': [
    'windows_amd64.zip',
    'b95bf2d953e3bf497bb2c0aed97ffcc5ed8471b80f0920d663a92a6111f05135',
  ],
};
export function verifyArchive(bytes, expected) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected)
    throw Error(
      `developer tool checksum mismatch: expected ${expected}, received ${actual}`,
    );
  return actual;
}
async function fileHashes(root, relative = '') {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const hashes = {};
  for (const entry of entries) {
    const path = join(relative, entry.name);
    if (entry.isDirectory())
      Object.assign(hashes, await fileHashes(root, path));
    else if (entry.isFile() && path !== 'circle-tool.json')
      hashes[path] = createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex');
  }
  return hashes;
}
export async function prepareNativeDependencies(root, dist) {
  const require = createRequire(join(root, 'package.json'));
  for (const name of ['node-pty', 'typescript-language-server', 'typescript']) {
    const source = dirname(require.resolve(`${name}/package.json`));
    await cp(source, join(dist, 'node_modules', name), { recursive: true });
  }
  await ensureNativeDependencyPermissions(dist);
}
export async function ensureNativeDependencyPermissions(root) {
  const require = createRequire(join(root, 'package.json'));
  const nodePtyRoot = dirname(require.resolve('node-pty/package.json'));
  for (const folder of ['build/Release', 'build/Debug']) {
    await chmod(join(nodePtyRoot, folder, 'spawn-helper'), 0o755).catch(
      (error) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
  }
  const helpers = join(nodePtyRoot, 'prebuilds');
  for (const target of await readdir(helpers)) {
    const helper = join(helpers, target, 'spawn-helper');
    await chmod(helper, 0o755).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function prepareDeveloperTools(
  dist,
  {
    platform = process.platform,
    arch = process.arch,
    fetchArchive = async (url) => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok)
        throw Error(
          `developer tool download failed: ${response.status} ${url}`,
        );
      return Buffer.from(await response.arrayBuffer());
    },
  } = {},
) {
  const target = `${platform}-${arch}`;
  const asset = ghAssets[target];
  if (!asset) throw Error(`unsupported developer tool target ${target}`);
  const tools = join(dist, 'tools');
  await mkdir(tools, { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), 'circle-developer-tools-'));
  const specs = [
    {
      name: 'node',
      version: NODE_VERSION,
      file: `node-v${NODE_VERSION}-${nodeAssets[target][0]}`,
      sha256: nodeAssets[target][1],
      base: `https://nodejs.org/dist/v${NODE_VERSION}/`,
    },
    {
      name: 'gh',
      version: GH_VERSION,
      file: `gh_${GH_VERSION}_${asset[0]}`,
      sha256: asset[1],
      base: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/`,
    },
    {
      name: 'js-debug',
      version: DEBUG_VERSION,
      file: `js-debug-dap-v${DEBUG_VERSION}.tar.gz`,
      sha256:
        '27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968',
      base: `https://github.com/microsoft/vscode-js-debug/releases/download/v${DEBUG_VERSION}/`,
    },
  ];
  try {
    for (const spec of specs) {
      const destination = join(tools, spec.name);
      // Only a verified receipt permits cache reuse; no system executable fallback.
      try {
        const cached = JSON.parse(
          await readFile(join(destination, 'circle-tool.json'), 'utf8'),
        );
        if (
          cached.sha256 === spec.sha256 &&
          cached.target === target &&
          cached.format === 1 &&
          JSON.stringify(cached.files) ===
            JSON.stringify(await fileHashes(destination))
        )
          continue;
      } catch {}
      const bytes = await fetchArchive(spec.base + spec.file);
      verifyArchive(bytes, spec.sha256);
      const archive = join(temp, spec.file);
      await writeFile(archive, bytes);
      const extracted = join(temp, spec.name);
      await mkdir(extracted);
      if (spec.file.endsWith('.zip') && process.platform === 'win32') {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            'Expand-Archive -LiteralPath $env:CIRCLE_TOOL_ARCHIVE -DestinationPath $env:CIRCLE_TOOL_EXTRACT',
          ],
          {
            env: {
              ...process.env,
              CIRCLE_TOOL_ARCHIVE: archive,
              CIRCLE_TOOL_EXTRACT: extracted,
            },
          },
        );
      } else if (spec.file.endsWith('.zip')) {
        execFileSync('unzip', ['-q', archive, '-d', extracted]);
      } else execFileSync('tar', ['-xzf', archive, '-C', extracted]);
      const entries = await readdir(extracted);
      const source =
        entries.length === 1 ? join(extracted, entries[0]) : extracted;
      await rm(destination, { recursive: true, force: true });
      if (spec.name === 'node') {
        await mkdir(join(destination, 'bin'), { recursive: true });
        const binary = platform === 'win32' ? 'node.exe' : 'bin/node';
        await cp(
          join(source, binary),
          join(destination, 'bin', platform === 'win32' ? 'node.exe' : 'node'),
        );
        for (const name of ['LICENSE', 'README.md', 'CHANGELOG.md'])
          await cp(join(source, name), join(destination, name));
        if (platform !== 'win32')
          await chmod(join(destination, 'bin/node'), 0o755);
      } else await cp(source, destination, { recursive: true });
      if (spec.name === 'js-debug')
        await writeFile(
          join(destination, 'package.json'),
          JSON.stringify({ type: 'commonjs' }) + '\n',
        );
      if (spec.name === 'gh' && platform !== 'win32')
        await chmod(join(destination, 'bin/gh'), 0o755);
      await writeFile(
        join(destination, 'circle-tool.json'),
        JSON.stringify(
          { ...spec, format: 1, target, files: await fileHashes(destination) },
          null,
          2,
        ) + '\n',
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (process.argv.includes('--native-permissions'))
    await ensureNativeDependencyPermissions(root);
  else
    await prepareDeveloperTools(join(root, 'dist'), {
      platform: process.env.CIRCLE_DESKTOP_PLATFORM,
      arch: process.env.CIRCLE_DESKTOP_ARCH,
    });
}
