import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

interface FilePin {
  source: string;
  path: string;
  sha256: string;
}
/** An explicit upstream checkout is required to establish upstream equality; offline mode checks only the mirror. */
export function verifyKnowledgeSync(
  root: string,
  upstream?: string,
): { mirrored: number; upstream: number } {
  const manifest = JSON.parse(
    readFileSync(
      resolve(root, 'src/data/knowledge-sync/v1/provenance.json'),
      'utf8',
    ),
  ) as {
    files: FilePin[];
    derived: { path: string; sha256: string }[];
    references: { source: string; sha256: string }[];
  };
  let mirrored = 0,
    compared = 0;
  const check = (directory: string, name: string, expected: string): void => {
    const path = resolve(directory, name),
      rel = relative(resolve(directory), path);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw Error('provenance path escapes checkout');
    const actual = createHash('sha256')
      .update(readFileSync(path))
      .digest('hex');
    if (actual !== expected)
      throw Error(`knowledge sync mirror differs: ${name}`);
  };
  for (const pin of [...manifest.files, ...manifest.derived]) {
    check(root, pin.path, pin.sha256);
    mirrored++;
  }
  if (upstream !== undefined) {
    for (const pin of [...manifest.files, ...manifest.references]) {
      check(upstream, pin.source, pin.sha256);
      compared++;
    }
  }
  return { mirrored, upstream: compared };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--upstream'))
    throw Error('usage: verify-knowledge-sync.ts [--upstream <checkout>]');
  console.log(
    JSON.stringify(
      verifyKnowledgeSync(
        fileURLToPath(new URL('..', import.meta.url)),
        args[1],
      ),
    ),
  );
}
