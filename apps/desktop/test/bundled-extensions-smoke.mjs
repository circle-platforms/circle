import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const extensionsRoot = fileURLToPath(
  new URL('../dist/extensions', import.meta.url),
);

assert.equal(
  existsSync(extensionsRoot),
  true,
  `missing built bundled extensions directory: ${extensionsRoot}`,
);

for (const required of ['hub', 'github']) {
  const requiredEntry = join(extensionsRoot, required, 'extension.js');
  assert.equal(
    existsSync(requiredEntry),
    true,
    `missing required bundled extension entry: ${requiredEntry}`,
  );
}

const dirs = readdirSync(extensionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

assert.ok(dirs.length > 0, `no bundled extensions found in ${extensionsRoot}`);

for (const name of dirs) {
  const entryPath = join(extensionsRoot, name, 'extension.js');
  assert.equal(
    existsSync(entryPath),
    true,
    `missing compiled extension.js for bundled extension '${name}': ${entryPath}`,
  );
  const code = readFileSync(entryPath, 'utf8');
  assert.equal(
    code.includes('__require('),
    false,
    `bundled extension '${name}' contains forbidden dynamic CJS __require(: ${entryPath}`,
  );
  const mod = await import(pathToFileURL(entryPath).href);
  assert.equal(
    typeof mod.register,
    'function',
    `bundled extension '${name}' must export a register(api) function`,
  );
}

console.log(`Bundled extensions smoke passed (${dirs.join(', ')}).`);
