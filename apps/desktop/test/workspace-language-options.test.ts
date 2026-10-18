import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { LanguageService } from '../src/workspace/language.ts';

const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/lib/tsc.js');
type Diagnostic = { code: string; source?: string };
const codes = (diagnostics: Diagnostic[]) =>
  [...new Set(diagnostics.map((item) => item.code))].sort();

function fixture(
  t: test.TestContext,
  config?: object,
  content = 'const count: number = "oops";\n',
) {
  const root = mkdtempSync(join(tmpdir(), 'circle-project-options-'));
  if (config)
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify(config));
  writeFileSync(join(root, 'main.ts'), content);
  let service: LanguageService | undefined;
  t.after(() => {
    service?.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    diagnose: () => {
      service ??= new LanguageService(root);
      return service.call('request', {
        method: 'diagnostics',
        path: 'main.ts',
      }) as Diagnostic[];
    },
    compile: () => {
      const result = spawnSync(
        process.execPath,
        [tsc, '--project', root, '--noEmit', '--pretty', 'false'],
        { cwd: root, encoding: 'utf8' },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      return [
        ...new Set(
          [...result.stdout.matchAll(/error TS(\d+):/g)].map(
            (match) => match[1],
          ),
        ),
      ].sort();
    },
  };
}

test('configured CommonJS options match the bundled tsc without inferred Bundler defaults', async (t) => {
  const version = spawnSync(process.execPath, [tsc, '--version'], {
    encoding: 'utf8',
  });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), `Version ${ts.version}`);
  for (const variant of [
    'implicit resolution',
    'inherited options',
    'explicit Node10',
  ] as const) {
    await t.test(variant, (t) => {
      const compilerOptions = {
        strict: true,
        target: 'ES2022',
        module: 'CommonJS',
        ...(variant === 'explicit Node10'
          ? { moduleResolution: 'Node10' }
          : {}),
      };
      const configured = fixture(
        t,
        variant === 'inherited options'
          ? { extends: './base.json', include: ['main.ts'] }
          : { compilerOptions, include: ['main.ts'] },
      );
      if (variant === 'inherited options')
        writeFileSync(
          join(configured.root, 'base.json'),
          JSON.stringify({ compilerOptions }),
        );
      const before = readFileSync(join(configured.root, 'main.ts'), 'utf8');
      const cliCodes = configured.compile();
      assert.deepEqual(cliCodes, ['2322'], 'real tsc retains the source error');
      const diagnostics = configured.diagnose();
      assert.deepEqual(
        codes(diagnostics),
        cliCodes,
        'editor project options follow tsc, including omitted/inherited resolution',
      );
      assert.equal(
        diagnostics.some((item) => item.source === 'configuration'),
        false,
      );
      assert.equal(
        readFileSync(join(configured.root, 'main.ts'), 'utf8'),
        before,
      );
    });
  }
});

test('an explicit project keeps TypeScript target defaults rather than inferred ESNext', (t) => {
  const configured = fixture(
    t,
    { include: ['main.ts'] },
    'const large = 1n;\nconst count: number = "oops";\n',
  );
  const cliCodes = configured.compile();
  assert.deepEqual(cliCodes, ['2322', '2737']);
  assert.deepEqual(codes(configured.diagnose()), cliCodes);
});

test('configless editor keeps ESNext inference and reports real type errors without writes', (t) => {
  const content = 'const large = 1n;\nconst count: number = "oops";\n';
  const inferred = fixture(t, undefined, content);
  assert.deepEqual(codes(inferred.diagnose()), ['2322']);
  assert.equal(readFileSync(join(inferred.root, 'main.ts'), 'utf8'), content);
});
