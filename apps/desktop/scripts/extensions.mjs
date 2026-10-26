// Bundled extensions for the desktop runtime. The terminal copies extension.ts and
// lets Node strip types. This build does not run tsc: it compiles each extension
// to extension.js and emits extension_error.js where an extension's import of it
// resolves. The worker imports the same extension_error.js, so ExtensionError is
// one class.
import { build } from 'esbuild';
import { cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const sourceRoot = fileURLToPath(new URL('../../../src/', import.meta.url));

/** Keep an extension's import of extension_error.js as written, and do not bundle it. */
export function keepExtensionImports() {
  return {
    name: 'keep-extension-imports',
    setup(build) {
      build.onResolve(
        { filter: /^(?:\.\.\/)+extension_error\.js$/ },
        (args) => ({ path: args.path, external: true }),
      );
    },
  };
}

/** The worker outfile sits beside extension_error.js and must import that file. */
export function shareExtensionError() {
  return {
    name: 'share-extension-error',
    setup(build) {
      build.onResolve({ filter: /extension_error\.js$/ }, () => ({
        path: './extension_error.js',
        external: true,
      }));
    },
  };
}

const moduleBuild = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
};

/** Compile the module a bundled extension may import, and the extensions themselves. */
export async function buildBundledExtensions(dist) {
  await build({
    ...moduleBuild,
    entryPoints: [join(sourceRoot, 'extension_error.ts')],
    outfile: join(dist, 'extension_error.js'),
  });
  const from = join(sourceRoot, 'extensions');
  const to = join(dist, 'extensions');
  if (!existsSync(from)) return;
  await cp(from, to, {
    recursive: true,
    filter: (path) => !path.endsWith('.ts'),
  });
  for (const directory of await readdir(from, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const entry = join(from, directory.name, 'extension.ts');
    if (!existsSync(entry)) continue;
    await build({
      ...moduleBuild,
      entryPoints: [entry],
      outfile: join(to, directory.name, 'extension.js'),
      plugins: [keepExtensionImports()],
    });
  }
}
