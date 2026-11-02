import { readFileSync } from 'node:fs';

// Kept at the runtime root: desktop bundles, like the CLI, copy data beside their entry point.
export function knowledgeAsset(name: string): unknown {
  if (!/^[a-z0-9.-]+\.json$/.test(name)) throw Error('invalid knowledge asset');
  return JSON.parse(
    readFileSync(
      new URL(`./data/knowledge-sync/v1/${name}`, import.meta.url),
      'utf8',
    ),
  );
}
