import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withPrivateJsonLock } from '../src/settings.js';
import { scratch } from './helpers.js';

for (const code of ['EPERM', 'EBUSY']) {
  test(`a temporary ${code} acquiring a private JSON lock does not drop the operation`, (t) => {
    const path = join(scratch(t), 'state.json');
    const mkdir = fs.mkdirSync;
    let attempts = 0;
    let operations = 0;
    t.after(() => t.mock.restoreAll());
    t.mock.method(fs, 'mkdirSync', ((folder: fs.PathLike, options: unknown) => {
      if (folder === `${path}.lock` && ++attempts === 1)
        throw Object.assign(new Error('temporary lock sharing violation'), {
          code,
        });
      return mkdir(folder, options as fs.MakeDirectoryOptions);
    }) as typeof fs.mkdirSync);

    withPrivateJsonLock(path, () => {
      operations++;
      fs.writeFileSync(path, 'committed');
    });

    assert.equal(attempts, 2);
    assert.equal(operations, 1);
    assert.equal(fs.readFileSync(path, 'utf8'), 'committed');
    assert.equal(fs.existsSync(`${path}.lock`), false);
  });

  test(`a temporary ${code} releasing a private JSON lock retries removal without replaying the operation`, (t) => {
    const path = join(scratch(t), 'state.json');
    const rmdir = fs.rmdirSync;
    let attempts = 0;
    let operations = 0;
    t.after(() => t.mock.restoreAll());
    t.mock.method(fs, 'rmdirSync', (folder: fs.PathLike) => {
      if (folder === `${path}.lock` && ++attempts === 1)
        throw Object.assign(new Error('temporary lock sharing violation'), {
          code,
        });
      return rmdir(folder);
    });

    withPrivateJsonLock(path, () => {
      operations++;
      fs.writeFileSync(path, 'committed');
    });

    assert.equal(attempts, 2);
    assert.equal(operations, 1);
    assert.equal(fs.readFileSync(path, 'utf8'), 'committed');
    assert.equal(fs.existsSync(`${path}.lock`), false);
    withPrivateJsonLock(path, () => operations++);
    assert.equal(operations, 2);
    assert.equal(fs.existsSync(`${path}.lock`), false);
  });
}

test('permanent EACCES acquiring a private JSON lock fails without retrying or running the operation', (t) => {
  const path = join(scratch(t), 'state.json');
  const denied = Object.assign(new Error('permanent lock permission denial'), {
    code: 'EACCES',
  });
  const mkdir = fs.mkdirSync;
  let attempts = 0;
  let operations = 0;
  t.after(() => t.mock.restoreAll());
  t.mock.method(fs, 'mkdirSync', ((folder: fs.PathLike, options: unknown) => {
    if (folder === `${path}.lock`) {
      attempts++;
      throw denied;
    }
    return mkdir(folder, options as fs.MakeDirectoryOptions);
  }) as typeof fs.mkdirSync);

  assert.throws(
    () => withPrivateJsonLock(path, () => operations++),
    (error) => error === denied,
  );
  assert.equal(attempts, 1);
  assert.equal(operations, 0);
  assert.equal(fs.existsSync(`${path}.lock`), false);
});

test('permanent EACCES releasing a private JSON lock fails without retrying or replaying a committed operation', (t) => {
  const path = join(scratch(t), 'state.json');
  const denied = Object.assign(new Error('permanent lock permission denial'), {
    code: 'EACCES',
  });
  const rmdir = fs.rmdirSync;
  let attempts = 0;
  let operations = 0;
  t.after(() => t.mock.restoreAll());
  t.mock.method(fs, 'rmdirSync', (folder: fs.PathLike) => {
    if (folder === `${path}.lock`) {
      attempts++;
      throw denied;
    }
    return rmdir(folder);
  });

  assert.throws(
    () =>
      withPrivateJsonLock(path, () => {
        operations++;
        fs.writeFileSync(path, 'committed');
      }),
    (error) => error === denied,
  );
  assert.equal(attempts, 1);
  assert.equal(operations, 1);
  assert.equal(fs.readFileSync(path, 'utf8'), 'committed');
  assert.equal(fs.existsSync(`${path}.lock`), true);
});
