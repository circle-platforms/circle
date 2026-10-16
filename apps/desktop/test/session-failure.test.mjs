import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureSessionFailure,
  cleanupSessionTest,
} from './helpers/session-failure.mjs';

function fixture(t) {
  const output = mkdtempSync(join(tmpdir(), 'circle-session-evidence-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const logs = [];
  t.mock.method(console, 'error', (record) => logs.push(JSON.parse(record)));
  const records = () =>
    readdirSync(output).map((file) =>
      JSON.parse(readFileSync(join(output, file), 'utf8')),
    );
  return { output, logs, records };
}
async function fail(app, original, output, cleanup = []) {
  try {
    try {
      throw original;
    } catch (error) {
      await captureSessionFailure(app, error, output);
      throw error;
    }
  } finally {
    await cleanupSessionTest(cleanup);
  }
}

test('session evidence persists the primary before exactly one DOM read', async (t) => {
  const f = fixture(t),
    original = Error('original click failed');
  let reads = 0;
  const app = {
    windows: () => [
      {
        evaluate: async () => {
          reads++;
          const primary = f.records().find((record) => record.error);
          assert.equal(primary.error.message, original.message);
          assert.equal(primary.error.stack, original.stack);
          return { bodyPointer: { inline: 'none' }, menus: { count: 1 } };
        },
      },
    ],
  };
  await assert.rejects(
    fail(app, original, f.output),
    (error) => error === original,
  );
  assert.equal(reads, 1);
  assert.equal(
    f.records().find((record) => record.sample).sample.menus.count,
    1,
  );
  assert.equal(f.logs[0].error.message, original.message);
});

for (const closed of [false, true])
  test(`unavailable session evidence retains primary identity with closed=${closed}`, async (t) => {
    const f = fixture(t),
      original = Error('original session failure');
    const app = closed
      ? {
          windows: () => {
            throw Error('application is closed');
          },
        }
      : {
          windows: () => [
            {
              evaluate: async () => {
                throw Error('renderer read failed');
              },
            },
          ],
        };
    await assert.rejects(
      fail(app, original, f.output),
      (error) => error === original,
    );
    assert.ok(
      f.records().some((record) => record.error?.message === original.message),
    );
    assert.ok(f.records().some((record) => record.unavailable));
  });

test(
  'a hung renderer read has one two-second bound and cannot replace the primary',
  { timeout: 6000 },
  async (t) => {
    const f = fixture(t),
      original = Error('original timed-out click');
    let reads = 0;
    const app = {
      windows: () => [
        {
          evaluate: () => {
            reads++;
            return new Promise(() => {});
          },
        },
      ],
    };
    const started = Date.now();
    await assert.rejects(
      fail(app, original, f.output),
      (error) => error === original,
    );
    assert.equal(reads, 1);
    assert.ok(Date.now() - started < 5000);
    assert.match(
      f.records().find((record) => record.unavailable).unavailable.message,
      /timed out after 2000ms/,
    );
    assert.ok(
      f.records().some((record) => record.error?.message === original.message),
    );
  },
);

test('failed evidence writes and every cleanup failure leave the primary unchanged', async (t) => {
  const f = fixture(t),
    original = Error('original check failed');
  const file = join(f.output, 'not-a-directory');
  writeFileSync(file, 'fixture');
  const effects = [];
  await assert.rejects(
    fail(undefined, original, file, [
      () => {
        effects.push('app');
        throw Error('close failed');
      },
      () => {
        effects.push('scratch');
        throw Error('remove failed');
      },
    ]),
    (error) => error === original,
  );
  assert.deepEqual(effects, ['app', 'scratch']);
  assert.ok(f.logs.some((record) => record.evidenceWriteError));
  assert.equal(f.logs.filter((record) => record.cleanupError).length, 2);
  assert.equal(await cleanupSessionTest([() => {}]), true);
  assert.equal(
    await cleanupSessionTest([
      () => {
        throw Error('cleanup after success');
      },
    ]),
    false,
  );
});
