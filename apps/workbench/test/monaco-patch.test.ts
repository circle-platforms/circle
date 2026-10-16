import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Script is shared by npm ci, development, direct editor tests and packaging.
const script = await import(
  new URL('../scripts/prepare-monaco.mjs', import.meta.url).href
);
const sdk = fileURLToPath(
  new URL('../node_modules/monaco-editor/', import.meta.url),
);
const current = await readFile(join(sdk, script.MONACO_PATCH.file), 'utf8');
const original = current
  .replace(
    "\nimport { onUnexpectedError } from '../../../common/errors.js';",
    '',
  )
  .replace(
    '            }).catch(onUnexpectedError);\n        }));\n        this.onDidChangeActiveNodesRelay',
    '            });\n        }));\n        this.onDidChangeActiveNodesRelay',
  );
test('pinned Monaco patch is idempotent and rejects unreviewed versions or source changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-monaco-patch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'node_modules/monaco-editor');
  const file = join(target, script.MONACO_PATCH.file);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(
    join(target, 'package.json'),
    JSON.stringify({ version: '0.57.0' }),
  );
  await writeFile(file, original);
  assert.equal((await script.prepareMonaco(root)).state, 'patched');
  assert.equal((await script.prepareMonaco(root)).state, 'already-patched');
  await writeFile(
    join(target, 'package.json'),
    JSON.stringify({ version: '0.57.1' }),
  );
  await assert.rejects(script.prepareMonaco(root), /reviewed version/);
  await writeFile(
    join(target, 'package.json'),
    JSON.stringify({ version: '0.57.0' }),
  );
  await writeFile(file, original + '\n// changed');
  await assert.rejects(script.prepareMonaco(root), /source changed/);
  assert.equal(await readFile(file, 'utf8'), original + '\n// changed');
});
test('actual SDK delayed tree callback consumes cancellation and still reports other failures', async () => {
  const { Delayer } = await import(
    pathToFileURL(join(sdk, 'esm/vs/base/common/async.js')).href
  );
  const { Emitter, Event } = await import(
    pathToFileURL(join(sdk, 'esm/vs/base/common/event.js')).href
  );
  const { DisposableStore } = await import(
    pathToFileURL(join(sdk, 'esm/vs/base/common/lifecycle.js')).href
  );
  const { onUnexpectedError, errorHandler } = await import(
    pathToFileURL(join(sdk, 'esm/vs/base/common/errors.js')).href
  );
  const patched = await readFile(join(sdk, script.MONACO_PATCH.file), 'utf8');
  const start = patched.indexOf('        const activeNodesEmitter =');
  const end = patched.indexOf(
    '        this.onDidChangeActiveNodesRelay.input',
    start,
  );
  assert.ok(start > 0 && end > start);
  const callback = new Function(
    'Emitter',
    'Delayer',
    'Event',
    'onDidModelSplice',
    'onUnexpectedError',
    patched.slice(start, end),
  );
  const errors: unknown[] = [];
  const previous = errorHandler.unexpectedErrorHandler;
  errorHandler.unexpectedErrorHandler = (e: unknown) => errors.push(e);
  const create = (getNodes: () => unknown[]) => {
    const focus = new Emitter();
    const modelDisposables = new DisposableStore();
    callback.call(
      {
        modelDisposables,
        focus: { getNodes, onDidChange: focus.event },
        selection: { getNodes: () => [], onDidChange: Event.None },
      },
      Emitter,
      Delayer,
      Event,
      Event.None,
      onUnexpectedError,
    );
    return { focus, modelDisposables };
  };
  try {
    const cancelled = create(() => []);
    cancelled.focus.fire();
    cancelled.modelDisposables.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 0);
    const failure = Error('non-cancellation sentinel');
    let reported!: () => void;
    const report = new Promise<void>((resolve) => {
      reported = resolve;
    });
    errorHandler.unexpectedErrorHandler = (error: unknown) => {
      errors.push(error);
      reported();
    };
    const throwing = create(() => {
      throw failure;
    });
    throwing.focus.fire();
    await report;
    assert.deepEqual(errors, [failure]);
    throwing.modelDisposables.dispose();
  } finally {
    errorHandler.unexpectedErrorHandler = previous;
  }
});
