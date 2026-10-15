import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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
test('opened markdown and JSON overlays do not become TypeScript source roots or pollute project diagnostics', (t) => {
  const { root, service } = fixture(t);
  writeFileSync(join(root, 'AGENTS.md'), '# rules\nRead the project first.\n');
  service.call('change', {
    path: 'AGENTS.md',
    content: '# unsaved rules\nKeep these instructions.',
  });
  service.call('change', {
    path: 'tsconfig.json',
    content: readFileSync(join(root, 'tsconfig.json'), 'utf8'),
  });
  service.call('change', {
    path: 'notes.json',
    content: '{"humanDraft":true}',
  });
  for (const file of ['AGENTS.md', 'tsconfig.json', 'notes.json']) {
    const diagnostics = service.call('diagnostics', { path: file }) as {
      code: string;
    }[];
    assert.deepEqual(diagnostics, [], file);
  }
  const diagnostics = service.call('diagnostics', {
    path: 'main.ts',
    content: 'const value: number = "still invalid";',
  }) as { code: string; message: string }[];
  assert.ok(diagnostics.some((item) => item.code === '2322'));
  assert.ok(diagnostics.every((item) => item.code !== '6054'));
  assert.equal(
    readFileSync(join(root, 'AGENTS.md'), 'utf8'),
    '# rules\nRead the project first.\n',
  );
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

test('semantic import resolution cannot read through workspace symlink escapes', (t) => {
  const { root, service } = fixture(t);
  const outside = root + '-outside';
  mkdirSync(outside);
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(
    join(outside, 'secret.ts'),
    'export const secret = "outside-only-value";',
  );
  symlinkSync(outside, join(root, 'linked'));
  const content =
    'import { secret } from "./linked/secret"; console.log(secret);';
  const diagnostics = service.call('request', {
    method: 'diagnostics',
    path: 'main.ts',
    content,
  }) as { message: string }[];
  assert.ok(
    diagnostics.some((item) => item.message.includes('Cannot find module')),
  );
  assert.ok(
    diagnostics.every((item) => !item.message.includes('outside-only-value')),
  );
  const definitions = service.call('request', {
    method: 'definition',
    path: 'main.ts',
    content,
    line: 1,
    column: 11,
  }) as { path: string }[];
  // TypeScript may return the unresolved import's own local alias declaration.
  assert.ok(definitions.every((item) => item.path === 'main.ts'));
});

test('extends, path aliases and JSX refresh in place while keeping unsaved overlays', (t) => {
  const { root, service } = fixture(t);
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'src'));
  const base = (target: string) =>
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'preserve',
        baseUrl: '..',
        paths: { '@value': [target] },
      },
    });
  writeFileSync(join(root, 'config/base.json'), base('src/a.ts'));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      extends: './config/base.json',
      include: ['src/**/*.ts', 'src/**/*.tsx', 'jsx.d.ts'],
    }),
  );
  writeFileSync(
    join(root, 'jsx.d.ts'),
    'declare namespace JSX { interface IntrinsicElements { button: {label:string} } }',
  );
  writeFileSync(join(root, 'src/a.ts'), 'export const title = "first";');
  writeFileSync(join(root, 'src/b.ts'), 'export const title = 42;');
  const content =
    'import { title } from "@value";\nexport const node = <button label={title}/>;';
  writeFileSync(join(root, 'src/view.tsx'), content);
  const initial = service.call('request', {
    method: 'diagnostics',
    path: 'src/view.tsx',
  }) as { message: string }[];
  assert.deepEqual(initial, []);
  const definitions = () =>
    service.call('request', {
      method: 'definition',
      path: 'src/view.tsx',
      line: 1,
      column: 11,
    }) as { path: string }[];
  assert.equal(definitions()[0]?.path, 'src/a.ts');
  service.call('change', {
    path: 'src/view.tsx',
    content: content + '\nconst humanDraft: number = "unsaved";',
  });
  writeFileSync(join(root, 'config/base.json'), base('src/b.ts'));
  const changed = service.call('request', {
    method: 'diagnostics',
    path: 'src/view.tsx',
  }) as { message: string }[];
  assert.ok(
    changed.filter((item) => item.message.includes('not assignable')).length >=
      2,
  );
  assert.equal(definitions()[0]?.path, 'src/b.ts');
  assert.equal(readFileSync(join(root, 'src/view.tsx'), 'utf8'), content);
  const state = service.call('request', { method: 'project' }) as {
    configPath: string;
    files: string[];
  };
  assert.equal(state.configPath, 'tsconfig.json');
  assert.ok(state.files.includes('src/view.tsx'));
});

test('new and deleted project files update definitions without app restart or explicit invalidation', (t) => {
  const { root, service } = fixture(t);
  const content = 'export const value = newFeature;';
  const diagnostic = () =>
    service.call('request', {
      method: 'diagnostics',
      path: 'main.ts',
      content,
    }) as { message: string }[];
  assert.ok(
    diagnostic().some((item) => item.message.includes('Cannot find name')),
  );
  writeFileSync(join(root, 'new-global.ts'), 'const newFeature = 123;');
  assert.ok(
    !diagnostic().some((item) => item.message.includes('Cannot find name')),
  );
  const definitions = service.call('request', {
    method: 'definition',
    path: 'main.ts',
    line: 1,
    column: 24,
  }) as { path: string }[];
  assert.equal(definitions[0]?.path, 'new-global.ts');
  rmSync(join(root, 'new-global.ts'));
  assert.ok(
    diagnostic().some((item) => item.message.includes('Cannot find name')),
  );
  const state = service.call('request', { method: 'project' }) as {
    files: string[];
  };
  assert.ok(!state.files.includes('new-global.ts'));
});

test('installed, changed and removed dependency declarations refresh diagnostics and completion', (t) => {
  const { root, service } = fixture(t);
  const content =
    'import { greet } from "fixture-package";\nconst result: number = greet();';
  const diagnostics = () =>
    service.call('request', {
      method: 'diagnostics',
      path: 'main.ts',
      content,
    }) as { message: string }[];
  assert.ok(
    diagnostics().some((item) => item.message.includes('Cannot find module')),
  );
  const pkg = join(root, 'node_modules/fixture-package');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'fixture-package',
      version: '1.0.0',
      types: 'index.d.ts',
    }),
  );
  writeFileSync(
    join(pkg, 'index.d.ts'),
    'export declare function greet(): number;\nexport declare const installed: string;',
  );
  assert.deepEqual(diagnostics(), []);
  const completion = () =>
    service.call('request', {
      method: 'completion',
      path: 'main.ts',
      content: 'import * as lib from "fixture-package";\nlib.',
      line: 2,
      column: 5,
    }) as { label: string }[];
  assert.ok(completion().some((item) => item.label === 'installed'));
  writeFileSync(
    join(pkg, 'index.d.ts'),
    'export declare function greet(): string;\nexport declare const replacement: boolean;',
  );
  assert.ok(
    diagnostics().some((item) => item.message.includes('not assignable')),
  );
  const changed = completion();
  assert.ok(changed.some((item) => item.label === 'replacement'));
  assert.ok(!changed.some((item) => item.label === 'installed'));
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  assert.ok(
    diagnostics().some((item) => item.message.includes('Cannot find module')),
  );
});

test('configuration syntax and option errors are explicit diagnostics and recover after edits', (t) => {
  const { root, service } = fixture(t);
  const content = 'const humanDraft: number = "unsaved";';
  service.call('change', { path: 'main.ts', content });
  writeFileSync(
    join(root, 'tsconfig.json'),
    '{"compilerOptions":{"strict": true,,}}',
  );
  const syntax = service.call('request', {
    method: 'diagnostics',
    path: 'main.ts',
  }) as { path: string; source: string; message: string }[];
  assert.ok(
    syntax.some(
      (item) =>
        item.source === 'configuration' && item.path === 'tsconfig.json',
    ),
  );
  const project = service.call('request', { method: 'project' }) as {
    diagnostics: { source: string }[];
  };
  assert.ok(project.diagnostics.length > 0);
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'not-a-target' },
      include: ['*.ts'],
    }),
  );
  const option = service.call('request', {
    method: 'diagnostics',
    path: 'main.ts',
  }) as { source: string; message: string }[];
  assert.ok(
    option.some(
      (item) =>
        item.source === 'configuration' && item.message.includes('target'),
    ),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['*.ts'],
    }),
  );
  const fixed = service.call('request', {
    method: 'diagnostics',
    path: 'main.ts',
  }) as { source: string; message: string }[];
  assert.ok(!fixed.some((item) => item.source === 'configuration'));
  assert.ok(fixed.some((item) => item.message.includes('not assignable')));
  assert.doesNotMatch(
    readFileSync(join(root, 'main.ts'), 'utf8'),
    /humanDraft/,
  );
});

test('explicit invalidation preserves drafts and jsconfig is picked up after tsconfig removal', (t) => {
  const { root, service } = fixture(t);
  service.call('change', {
    path: 'main.ts',
    content: 'const value: number = "unsaved";',
  });
  service.invalidate(['main.ts']);
  assert.ok(
    (
      service.call('request', { method: 'diagnostics', path: 'main.ts' }) as {
        message: string;
      }[]
    ).some((item) => item.message.includes('not assignable')),
  );
  rmSync(join(root, 'tsconfig.json'));
  writeFileSync(
    join(root, 'jsconfig.json'),
    JSON.stringify({ compilerOptions: { checkJs: true }, include: ['*.js'] }),
  );
  writeFileSync(join(root, 'app.js'), 'const value = 1; value.toUpperCase();');
  const diagnostics = service.call('request', {
    method: 'diagnostics',
    path: 'app.js',
  }) as { message: string }[];
  assert.ok(diagnostics.some((item) => item.message.includes('toUpperCase')));
  const project = service.call('request', { method: 'refresh' }) as {
    configPath: string;
  };
  assert.equal(project.configPath, 'jsconfig.json');
});

test('configuration extends cannot load files outside the granted root', (t) => {
  const { root, service } = fixture(t);
  const outside = root + '-outside.json';
  t.after(() => rmSync(outside, { force: true }));
  writeFileSync(
    outside,
    JSON.stringify({ compilerOptions: { types: ['outside-sensitive-type'] } }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ extends: outside, include: ['*.ts'] }),
  );
  const project = service.call('request', { method: 'project' }) as {
    diagnostics: { message: string; source: string }[];
  };
  assert.ok(
    project.diagnostics.some(
      (item) =>
        item.source === 'configuration' &&
        item.message.includes('Cannot read file'),
    ),
  );
  assert.ok(
    project.diagnostics.every(
      (item) => !item.message.includes('outside-sensitive-type'),
    ),
  );
});

test('inferred JavaScript projects suppress emit collisions but configured projects retain them', (t) => {
  const { root, service } = fixture(t);
  rmSync(join(root, 'tsconfig.json'));
  writeFileSync(
    join(root, 'debug.js'),
    'const value = 1; console.log(value);\n',
  );
  service.invalidate();
  const inferred = service.call('request', { method: 'project' }) as {
    diagnostics: { code: string }[];
  };
  assert(!inferred.diagnostics.some((d) => d.code === '5055'));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { allowJs: true, noEmit: false },
      include: ['debug.js'],
    }),
  );
  service.invalidate();
  const configured = service.call('request', { method: 'project' }) as {
    diagnostics: { code: string }[];
  };
  assert(configured.diagnostics.some((d) => d.code === '5055'));
});

test(
  'Windows short-root grants accept native canonical document paths',
  { skip: process.platform !== 'win32' },
  (t) => {
    const { root, service: original } = fixture(t);
    original.dispose();
    const shortRoot = execFileSync(
      'cmd.exe',
      ['/d', '/c', `for %I in ("${root}") do @echo %~sI`],
      { encoding: 'utf8', windowsVerbatimArguments: true },
    ).trim();
    const service = new LanguageService(shortRoot);
    t.after(() => service.dispose());
    const main = realpathSync.native(join(root, 'main.ts'));
    const definition = service.call('request', {
      method: 'definition',
      path: main,
      line: 3,
      column: 13,
    }) as { path: string }[];
    assert.equal(definition[0]?.path, 'lib.ts');
    const diagnostics = service.call('request', {
      method: 'diagnostics',
      path: main,
      content: 'const value: number = "bad";',
    }) as { code: string }[];
    assert(diagnostics.some((d) => d.code === '2322'));
  },
);
