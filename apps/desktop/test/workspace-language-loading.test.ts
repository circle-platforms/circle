import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { scratch } from '../../../tests/helpers.ts';

const exec = promisify(execFile);
const entry = fileURLToPath(
  new URL('../src/workspace/language.ts', import.meta.url),
);
test('language bundles import without TypeScript and load packaged semantic services only on demand in ESM and CJS', async (t) => {
  const root = scratch(t, 'circle-lazy-language-');
  const empty = join(root, 'without-typescript'),
    dist = join(root, 'dist'),
    workspace = join(root, 'workspace');
  await Promise.all([empty, dist, workspace].map((path) => mkdir(path)));
  await writeFile(
    join(workspace, 'main.ts'),
    'const value: number = "wrong";\n',
  );
  const packagePath = createRequire(import.meta.url).resolve(
    'typescript/package.json',
  );
  await cp(dirname(packagePath), join(dist, 'node_modules', 'typescript'), {
    recursive: true,
  });
  for (const format of ['esm', 'cjs'] as const) {
    const filename = format === 'esm' ? 'language.mjs' : 'language.cjs';
    const bundle = join(empty, filename);
    const result = await build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format,
      metafile: true,
      logLevel: 'silent',
    });
    assert.equal(
      Object.keys(result.metafile!.inputs).some((path) =>
        /node_modules[\\/]typescript[\\/]/.test(path),
      ),
      false,
    );
    const load = (path: string) =>
      format === 'esm'
        ? `await import(${JSON.stringify(pathToFileURL(path).href)})`
        : `createRequire(import.meta.url)(${JSON.stringify(path)})`;
    const env = {
      ...process.env,
      NODE_PATH: '',
      CIRCLE_HOME: root,
      CIRCLE_WORKBENCH_DATA_DIR: root,
    };
    const imported = await exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';import {createRequire} from 'node:module';const module=${load(bundle)};assert.equal(typeof module.LanguageService,'function');console.log('LAZY_IMPORT_OK');`,
      ],
      { cwd: root, env },
    );
    assert.match(imported.stdout, /LAZY_IMPORT_OK/);
    const packaged = join(dist, filename);
    await cp(bundle, packaged);
    const actual = await exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';import {createRequire} from 'node:module';const module=${load(packaged)};const service=new module.LanguageService(${JSON.stringify(workspace)});try{const diagnostics=service.call('diagnostics',{path:'main.ts'});assert.ok(diagnostics.some(item=>item.code==='2322'));console.log('REAL_SEMANTICS_OK')}finally{service.dispose()}`,
      ],
      { cwd: root, env, timeout: 10000 },
    );
    assert.match(actual.stdout, /REAL_SEMANTICS_OK/);
  }
});
