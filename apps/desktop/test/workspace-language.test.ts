import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LanguageService } from '../src/workspace/language.ts';
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'circle-language-'));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['*.ts'],
    }),
  );
  writeFileSync(join(root, 'lib.ts'), 'export const amount = 1;\n');
  writeFileSync(
    join(root, 'main.ts'),
    'import { amount } from "./lib";\nconst label = "amount";\nconsole.log(amount, label);\n',
  );
  const service = new LanguageService(root);
  t.after(() => {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, service };
}
test('semantic definitions, references and rename span modules and preserve strings', (t) => {
  const { root, service } = fixture(t);
  const definition = service.call('request', {
    method: 'definition',
    path: 'main.ts',
    line: 3,
    column: 13,
  }) as { path: string }[];
  assert.equal(definition[0]?.path, 'lib.ts');
  const references = service.call('request', {
    method: 'references',
    path: 'lib.ts',
    line: 1,
    column: 15,
  }) as { path: string }[];
  assert.equal(references.length, 3);
  const renamed = service.call('request', {
    method: 'rename',
    path: 'lib.ts',
    line: 1,
    column: 15,
    newName: 'total',
  }) as { path: string; range: { startLineNumber: number }; text: string }[];
  assert.equal(renamed.length, 3);
  assert.ok(renamed.every((item) => item.text === 'total'));
  assert.ok(
    !renamed.some(
      (item) => item.path === 'main.ts' && item.range.startLineNumber === 2,
    ),
  );
  assert.match(
    readFileSync(join(root, 'main.ts'), 'utf8'),
    /const label = "amount"/,
  );
});
test('unsaved cross-file overlay drives diagnostics and completion without disk writes', (t) => {
  const { root, service } = fixture(t);
  const content =
    'import { amount } from "./lib";\nconst value: number = amount;\n';
  const diagnostics = service.call('request', {
    method: 'diagnostics',
    path: 'main.ts',
    content,
    documents: [
      { path: 'lib.ts', content: 'export const amount = "unsaved";\n' },
    ],
  }) as { message: string }[];
  assert.ok(diagnostics.some((item) => /string.*number/.test(item.message)));
  assert.equal(
    readFileSync(join(root, 'lib.ts'), 'utf8'),
    'export const amount = 1;\n',
  );
  const completion = service.call('request', {
    method: 'completion',
    path: 'main.ts',
    content: 'const value = "text";\nvalue.',
    line: 2,
    column: 7,
  }) as { label: string }[];
  assert.ok(completion.some((item) => item.label === 'toUpperCase'));
});
test('formatting returns actual edits and close releases unsaved overlay', (t) => {
  const { service } = fixture(t);
  const edits = service.call('request', {
    method: 'format',
    path: 'main.ts',
    content: 'const x=1+2;\n',
  }) as { text: string }[];
  assert.ok(edits.length > 0);
  assert.ok(edits.some((item) => item.text === ' '));
  service.call('change', {
    path: 'lib.ts',
    content: 'export const amount = "text";',
  });
  service.call('close', { path: 'lib.ts' });
  const diagnostics = service.call('request', {
    method: 'diagnostics',
    path: 'main.ts',
    content: 'import { amount } from "./lib"; const x: number = amount;',
  }) as unknown[];
  assert.equal(diagnostics.length, 0);
});
test('language requests reject traversal, symlink escapes and invalid symbol names', (t) => {
  const { root, service } = fixture(t);
  assert.throws(
    () =>
      service.call('request', { method: 'diagnostics', path: '../escape.ts' }),
    /outside workspace/,
  );
  symlinkSync(tmpdir(), join(root, 'escape'));
  assert.throws(
    () =>
      service.call('request', {
        method: 'diagnostics',
        path: 'escape/secret.ts',
      }),
    /outside workspace/,
  );
  assert.throws(
    () =>
      service.call('request', {
        method: 'rename',
        path: 'lib.ts',
        line: 1,
        column: 15,
        newName: 'not valid',
      }),
    /invalid symbol/,
  );
});
