import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import lockfile from 'proper-lockfile';
import { withPrivateJsonLock } from '../src/settings.js';
import { scratch } from './helpers.js';

for (const method of [
  'mkdirSync',
  'statSync',
  'utimesSync',
  'rmdirSync',
] as const)
  test(`a transient lock ${method} refusal preserves the transaction and releases the actual lock`, (t) => {
    const path = join(scratch(t), 'settings.json');
    fs.writeFileSync(path, JSON.stringify({ first: true }));
    const original = fs[method];
    let refused = 0;
    t.mock.method(fs, method, (...args: unknown[]) => {
      if (String(args[0]) === `${path}.lock` && refused++ === 0)
        throw Object.assign(new Error('temporary filesystem refusal'), {
          code: 'EPERM',
        });
      return Reflect.apply(original, fs, args);
    });
    // Supply the same real filesystem under the old implementation too, so the
    // injected refusal reaches proper-lockfile rather than its cached fs copy.
    const acquire = lockfile.lockSync;
    t.mock.method(
      lockfile,
      'lockSync',
      (file: string, options?: lockfile.LockOptions) =>
        acquire(file, { ...options, fs: options?.fs ?? fs }),
    );
    let writes = 0;
    withPrivateJsonLock(path, () => {
      writes++;
      const saved = JSON.parse(fs.readFileSync(path, 'utf8'));
      fs.writeFileSync(path, JSON.stringify({ ...saved, second: true }));
    });
    assert.equal(
      writes,
      1,
      'a release retry must never replay a committed transaction',
    );
    assert(refused >= 2, 'the refused real filesystem call was retried');
    assert.equal(fs.existsSync(`${path}.lock`), false);
    withPrivateJsonLock(path, () => {
      const saved = JSON.parse(fs.readFileSync(path, 'utf8'));
      fs.writeFileSync(path, JSON.stringify({ ...saved, third: true }));
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')), {
      first: true,
      second: true,
      third: true,
    });
  });
