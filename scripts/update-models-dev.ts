// Refresh the models.dev snapshot that ships with Circle.
//
//   npx tsx scripts/update-models-dev.ts            fetch https://models.dev/api.json
//   npx tsx scripts/update-models-dev.ts api.json   use a file saved before
//
// Writes src/data/models_dev.json.gz: for each provider its API address and, per model, the
// context window, the output limit, the prices and whether it reads images (`slimCatalog`).
// Run it before a release so a Circle without network access still knows recent models.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CATALOG_URL, slimCatalog } from '../src/model_catalog.js';

// Keys in order, so the same data gives the same bytes and an unchanged snapshot no diff
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
    );
  return value;
}

const source = process.argv[2];
const raw: unknown = source
  ? JSON.parse(readFileSync(source, 'utf8'))
  : await (
      await fetch(CATALOG_URL, {
        headers: { Accept: 'application/json', 'User-Agent': 'circle' },
        signal: AbortSignal.timeout(60_000),
      })
    ).json();
const data = slimCatalog(raw);
const providers = Object.values(data.providers);
if (!providers.length) {
  console.error('models.dev gave no providers; snapshot left as it was');
  process.exit(1);
}
const target = join(
  import.meta.dirname,
  '..',
  'src',
  'data',
  'models_dev.json.gz',
);
writeFileSync(target, gzipSync(JSON.stringify(sorted(data)), { level: 9 }));
const models = providers.reduce(
  (sum, provider) => sum + Object.keys(provider.models).length,
  0,
);
console.log(
  `src/data/models_dev.json.gz: ${providers.length} providers, ${models} models, ${statSync(target).size} bytes`,
);
