import { readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const MONACO_PATCH = Object.freeze({
  version: '0.57.0',
  file: 'esm/vs/base/browser/ui/tree/abstractTree.js',
  original: 'd40605ee170fcfac5e33c203ad5020bcc9951124b182e2fef02656de1271c278',
  patched: '5489ef66c0f8681747f01c3760ac5a4710ccfd58b0f9a70fa91f2bbf55912526',
});
const sha = (value) => createHash('sha256').update(value).digest('hex');
/** Patch only this pinned SDK file, before either Vite optimization or bundling. */
export async function prepareMonaco(
  root = fileURLToPath(new URL('..', import.meta.url)),
) {
  const sdk = join(root, 'node_modules/monaco-editor');
  const metadata = JSON.parse(
    await readFile(join(sdk, 'package.json'), 'utf8'),
  );
  if (metadata.version !== MONACO_PATCH.version)
    throw Error('Monaco patch requires reviewed version 0.57.0');
  const path = join(sdk, MONACO_PATCH.file);
  const original = await readFile(path, 'utf8');
  const before = sha(original);
  if (before === MONACO_PATCH.patched)
    return {
      state: 'already-patched',
      version: metadata.version,
      sha256: before,
    };
  if (before !== MONACO_PATCH.original)
    throw Error(
      'Monaco abstractTree source changed; review the scoped cancellation patch',
    );
  const anchor =
    "import { Delayer, disposableTimeout } from '../../../common/async.js';";
  const callback =
    '                activeNodesEmitter.fire([...set.values()]);\n            });';
  if (
    original.split(anchor).length !== 2 ||
    original.split(callback).length !== 2
  )
    throw Error('Monaco cancellation patch anchor changed');
  const patched = original
    .replace(
      anchor,
      anchor +
        "\nimport { onUnexpectedError } from '../../../common/errors.js';",
    )
    .replace(
      callback,
      '                activeNodesEmitter.fire([...set.values()]);\n            }).catch(onUnexpectedError);',
    );
  if (sha(patched) !== MONACO_PATCH.patched)
    throw Error('Monaco cancellation patch output fingerprint changed');
  const temporary = path + '.circle-' + randomUUID();
  try {
    await writeFile(temporary, patched, { mode: (await stat(path)).mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    state: 'patched',
    version: metadata.version,
    sha256: MONACO_PATCH.patched,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  console.log(JSON.stringify(await prepareMonaco()));
