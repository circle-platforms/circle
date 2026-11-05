import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../..', import.meta.url));

// The desktop runtime is one bundle, and a bundle renames the classes both SDKs share:
// a timed-out request must still be known for one there, or it is never sent again
test('a timeout, a lost connection or an error inside the stream from either SDK is still retried inside a bundle, a stop is not', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-model-errors-'));
  try {
    const outfile = join(folder, 'guard.mjs');
    await build({
      stdin: {
        contents: [
          "export { errorKind } from './src/model_guard.ts';",
          "export { default as OpenAI } from 'openai';",
          "export { default as Anthropic } from '@anthropic-ai/sdk';",
        ].join('\n'),
        resolveDir: root,
        loader: 'ts',
      },
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      banner: {
        js: "import { createRequire as circleCreateRequire } from 'node:module'; const require = circleCreateRequire(import.meta.url);",
      },
      logLevel: 'silent',
    });
    const { errorKind, OpenAI, Anthropic } = await import(
      pathToFileURL(outfile).href
    );
    for (const sdk of [OpenAI, Anthropic]) {
      assert.equal(errorKind(new sdk.APIConnectionTimeoutError()), 'timeout');
      assert.equal(errorKind(new sdk.APIConnectionError({})), 'network');
      assert.equal(
        errorKind(new sdk.APIError(undefined, {}, 'overloaded', new Headers())),
        'inband',
      );
      assert.equal(errorKind(new sdk.APIUserAbortError()), undefined);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
