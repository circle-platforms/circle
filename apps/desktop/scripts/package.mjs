import { createHash } from 'node:crypto';
import { packager } from '@electron/packager';
import { cp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const outputRoot = process.env.CIRCLE_DESKTOP_OUTPUT_DIR ?? join(root, 'out');
const stage = join(root, '.stage');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
// The application carries Circle's version, as the command line does
const { version } = JSON.parse(
  await readFile(join(root, '../../package.json'), 'utf8'),
);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
await cp(join(root, '../../LICENSE'), join(stage, 'LICENSE'));
await cp(
  join(root, '../../THIRD_PARTY_NOTICES.md'),
  join(stage, 'THIRD_PARTY_NOTICES.md'),
);
await writeFile(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'circle',
      version,
      main: 'dist/main.cjs',
      description: manifest.description,
      license: 'MIT',
    },
    null,
    2,
  ) + '\n',
);
const platform = process.env.CIRCLE_DESKTOP_PLATFORM ?? process.platform;
const arch = process.env.CIRCLE_DESKTOP_ARCH ?? process.arch;
const paths = await packager({
  dir: stage,
  out: outputRoot,
  name: 'Circle',
  platform,
  arch,
  electronVersion: manifest.devDependencies.electron,
  appBundleId: 'com.qingshanfeihu.circle',
  appCategoryType: 'public.app-category.developer-tools',
  icon:
    platform === 'darwin'
      ? join(root, 'dist/assets/circle.icns')
      : platform === 'win32'
        ? join(root, 'dist/assets/circle.ico')
        : join(root, 'dist/assets/circle.png'),
  asar: true,
  overwrite: true,
  prune: false,
});
for (const path of paths) console.log(path);
// circle-desktop-<version>-<os>-<arch>: never a name `circle update` looks for
const target = `${platform === 'win32' ? 'windows' : platform}-${arch}`;
const asset = join(outputRoot, `circle-desktop-${version}-${target}`);
const artifactPaths = paths.map((path) =>
  platform === 'darwin'
    ? join(path, 'Circle.app/Contents/Resources/app.asar')
    : join(path, 'resources/app.asar'),
);
const archives = [];
if (platform === 'darwin' && process.platform === 'darwin') {
  // Packaging changes the bundle Electron's own ad-hoc signature covered; a copy with a broken
  // signature is "damaged" once downloaded. Sign the whole application again, ad hoc.
  const bundle = join(paths[0], 'Circle.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], {
    stdio: 'inherit',
  });
  const image = `${asset}.dmg`;
  const content = join(root, '.stage-dmg');
  await rm(content, { recursive: true, force: true });
  await mkdir(content);
  await cp(bundle, join(content, 'Circle.app'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await symlink('/Applications', join(content, 'Applications'));
  await rm(image, { force: true });
  // hdiutil now and then fails with "Resource busy" while the system looks at the new image;
  // a later try goes through
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(
        'hdiutil',
        [
          'create',
          '-volname',
          'Circle',
          '-srcfolder',
          content,
          '-ov',
          '-format',
          'UDZO',
          image,
        ],
        { stdio: 'inherit' },
      );
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      console.log(`hdiutil failed (try ${attempt} of 5); trying again`);
      await rm(image, { force: true });
      await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }
  await rm(content, { recursive: true, force: true });
  archives.push(image);
} else if (platform === 'win32') {
  const archive = `${asset}.zip`;
  await rm(archive, { force: true });
  execFileSync(
    process.platform === 'win32' ? 'tar' : 'zip',
    process.platform === 'win32'
      ? ['-a', '-c', '-f', archive, relative(outputRoot, paths[0])]
      : ['-qry', archive, relative(outputRoot, paths[0])],
    { cwd: outputRoot, stdio: 'inherit' },
  );
  archives.push(archive);
} else if (platform === 'linux') {
  const archive = `${asset}.tar.gz`;
  execFileSync(
    'tar',
    ['-czf', archive, '-C', outputRoot, relative(outputRoot, paths[0])],
    { stdio: 'inherit' },
  );
  archives.push(archive);
}
for (const archive of archives) {
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(
    `${archive}.sha256`,
    `${sha256}  ${relative(outputRoot, archive)}\n`,
  );
  artifactPaths.push(archive);
  console.log(archive);
}
await writeFile(
  join(outputRoot, 'artifact-receipt.json'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      version,
      electron: manifest.devDependencies.electron,
      platform,
      arch,
      artifacts: await Promise.all(
        artifactPaths.map(async (path) => ({
          path: relative(outputRoot, path).split('\\').join('/'),
          sha256: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        })),
      ),
    },
    null,
    2,
  ) + '\n',
);
