import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, join, dirname, relative, sep, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isBuildInput = (file) =>
  /^(?:src|assets|resources)\//.test(file) ||
  /^apps\/(?:desktop|workbench)\/(?:src|scripts|assets|resources|public)\//.test(
    file,
  ) ||
  /^(?:apps\/(?:desktop|workbench)\/)?(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s|index\.html|\.npmrc)$/.test(
    file,
  );
async function sourceIdentity(root, allowWorkingTree = false) {
  const git = async (args) =>
    (await exec('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 }))
      .stdout;
  if (!allowWorkingTree) await git(['diff', '--quiet', 'HEAD']);
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  if (!/^[a-f0-9]{40}$/.test(head))
    throw Error('full build source commit is required');
  const files = (await git(['ls-files', '-z']))
    .split('\0')
    .filter(Boolean)
    .sort();
  const untracked = (
    await git(['ls-files', '--others', '--exclude-standard', '-z'])
  )
    .split('\0')
    .filter((file) =>
      allowWorkingTree
        ? isBuildInput(file)
        : /^(?:src\/|apps\/(?:desktop|workbench)\/src\/)/.test(file),
    );
  if (!allowWorkingTree && untracked.length)
    throw Error('untracked build source prevents commit attribution');
  const digest = createHash('sha256');
  const sourceFiles = [];
  for (const file of [
    ...new Set([...files, ...(allowWorkingTree ? untracked : [])]),
  ].sort()) {
    const kind = files.includes(file) ? 'tracked' : 'untracked';
    let hash;
    try {
      hash = sha(await readFile(join(root, file)));
    } catch (error) {
      if (!allowWorkingTree || kind !== 'tracked' || error.code !== 'ENOENT')
        throw error;
      hash = null; // A tracked deletion is part of this exact working-tree identity.
    }
    sourceFiles.push({
      path: file,
      kind,
      sha256: hash,
      ...(hash === null ? { deleted: true } : {}),
    });
    digest.update(file + '\0').update((hash ?? 'deleted') + '\0');
    if (allowWorkingTree) digest.update(kind + '\0');
  }
  return {
    sourceKind: allowWorkingTree ? 'working-tree' : 'commit',
    sourceBuildHead: head,
    ...(allowWorkingTree ? { sourceBaseHead: head, sourceFiles } : {}),
    sourceTreeSha256: digest.digest('hex'),
    trackedFiles: files.length,
  };
}
export async function captureNativeBuildSource({
  root,
  output,
  allowWorkingTree = false,
}) {
  const receipt = {
    version: 1,
    root: resolve(root),
    ...(await sourceIdentity(resolve(root), allowWorkingTree)),
    capturedAt: new Date().toISOString(),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2));
  return receipt;
}
export async function generateNativeBuildManifest({
  root,
  sourceReceipt,
  appPath,
  output,
  allowWorkingTree = false,
}) {
  root = resolve(root);
  appPath = resolve(appPath);
  const receipt = JSON.parse(await readFile(sourceReceipt, 'utf8'));
  const sourceKind = receipt.sourceKind ?? 'commit';
  if (sourceKind !== 'commit' && sourceKind !== 'working-tree')
    throw Error('unknown source kind');
  if (sourceKind === 'working-tree' && !allowWorkingTree)
    throw Error('working-tree receipt requires explicit allowWorkingTree');
  if (sourceKind === 'commit' && allowWorkingTree)
    throw Error('cannot change the receipt source kind');
  const current = await sourceIdentity(root, sourceKind === 'working-tree');
  if (
    receipt.version !== 1 ||
    receipt.root !== root ||
    sourceKind !== current.sourceKind ||
    receipt.sourceBuildHead !== current.sourceBuildHead ||
    (sourceKind === 'working-tree' &&
      (receipt.sourceBaseHead !== current.sourceBaseHead ||
        JSON.stringify(receipt.sourceFiles) !==
          JSON.stringify(current.sourceFiles))) ||
    receipt.sourceTreeSha256 !== current.sourceTreeSha256
  )
    throw Error('source changed since the pre-build receipt');
  let read, files;
  if (appPath.endsWith('.asar')) {
    const require = createRequire(import.meta.url);
    const packagedRequire = createRequire(
      require.resolve('@electron/packager'),
    );
    const asar = await import(
      pathToFileURL(packagedRequire.resolve('@electron/asar')).href
    );
    read = async (file) =>
      asar.extractFile(appPath, relative(appPath, file).split(sep).join('/'));
    files = asar
      .listPackage(appPath)
      .filter(
        (file) =>
          !('files' in asar.statFile(appPath, file.replace(/^[/\\]/, ''))),
      )
      .map((file) => join(appPath, file.replace(/^[/\\]/, '')));
  } else {
    read = (file) => readFile(file);
    files = [];
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else files.push(file);
      }
    };
    await walk(join(appPath, 'dist', 'renderer'));
    for (const folder of ['koffi', '@koromix'])
      await walk(join(appPath, 'dist', 'node_modules', folder)).catch(
        (error) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
  }
  const pkg = JSON.parse(
    (await read(join(appPath, 'package.json'))).toString(),
  );
  const main = resolve(appPath, pkg.main);
  const mainRelative = relative(appPath, main);
  if (mainRelative.startsWith('..') || isAbsolute(mainRelative))
    throw Error('application main is outside the executed app');
  const dist = dirname(main);
  const required = [
    main,
    join(dist, 'preload.cjs'),
    join(dist, 'runtime-worker.mjs'),
    join(dist, 'tools', 'command-supervisor.mjs'),
    join(dist, 'renderer', 'index.html'),
  ];
  const renderer = join(dist, 'renderer') + sep;
  const nativeRoots = ['koffi', '@koromix'].map(
    (folder) => join(dist, 'node_modules', folder) + sep,
  );
  const selected = [
    ...new Set([
      ...required,
      ...files.filter(
        (file) =>
          (file.startsWith(renderer) ||
            nativeRoots.some((root) => file.startsWith(root))) &&
          !file.endsWith('.map'),
      ),
    ]),
  ].sort();
  const artifacts = [];
  for (const file of selected)
    artifacts.push({ path: file, sha256: sha(await read(file)) });
  const manifest = {
    version: 1,
    sourceKind,
    sourceBuildHead: receipt.sourceBuildHead,
    ...(sourceKind === 'working-tree'
      ? {
          sourceBaseHead: receipt.sourceBaseHead,
          sourceFiles: receipt.sourceFiles,
        }
      : {}),
    sourceTreeSha256: receipt.sourceTreeSha256,
    sourceReceipt: resolve(sourceReceipt),
    appPath,
    generatedAt: new Date().toISOString(),
    artifacts,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(manifest, null, 2));
  return manifest;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [action, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (key === 'allow-working-tree') options[key] = true;
    else options[key] = args[++i];
  }
  if (action === 'capture')
    await captureNativeBuildSource({
      root: options.root,
      output: options.output,
      allowWorkingTree: options['allow-working-tree'] === true,
    });
  else if (action === 'create')
    await generateNativeBuildManifest({
      root: options.root,
      sourceReceipt: options.receipt,
      appPath: options.app,
      output: options.output,
      allowWorkingTree: options['allow-working-tree'] === true,
    });
  else
    throw Error(
      'use capture --root --output [--allow-working-tree] before build, then create --root --receipt --app --output [--allow-working-tree] after build',
    );
}
