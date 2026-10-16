import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { finishNativePasteCleanup } from './helpers/native-paste-cleanup.mjs';

test('real evidence EISDIR cannot prevent restoration or hide the primary error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'circle-paste-cleanup-'));
  const primary = new Error('original paste assertion failed');
  let restored = false;
  try {
    await assert.rejects(
      finishNativePasteCleanup({
        primaryError: primary,
        observe: async () => {},
        writeEvidence: () => writeFile(directory, 'evidence'),
        restore: async () => {
          restored = true;
        },
      }),
      (error) => {
        assert(error instanceof AggregateError);
        assert.equal(error.cause, primary);
        assert.equal(error.errors[0], primary);
        assert.equal(error.errors[1].cause.code, 'EISDIR');
        return true;
      },
    );
    assert.equal(restored, true);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('all cleanup failures remain visible without a primary operation failure', async () => {
  const calls = [];
  await assert.rejects(
    finishNativePasteCleanup({
      observe: async () => {
        calls.push('observe');
        throw Error('observer failed');
      },
      writeEvidence: async () => {
        calls.push('evidence');
        throw Error('disk full');
      },
      restore: async () => {
        calls.push('restore');
        throw Error('clipboard failed');
      },
    }),
    (error) => {
      assert.deepEqual(
        error.errors.map((e) => e.cause.message),
        ['observer failed', 'disk full', 'clipboard failed'],
      );
      return true;
    },
  );
  assert.deepEqual(calls, ['observe', 'evidence', 'restore']);
});

test('successful cleanup preserves an already propagating primary error', async () => {
  const primary = new Error('original');
  await assert.rejects(
    async () => {
      try {
        throw primary;
      } finally {
        await finishNativePasteCleanup({
          primaryError: primary,
          observe: async () => {},
          writeEvidence: async () => {},
          restore: async () => {},
        });
      }
    },
    (error) => error === primary,
  );
});
