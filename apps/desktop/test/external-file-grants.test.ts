import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import test, { type TestContext } from 'node:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  symlink,
  link,
  readdir,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalFileGrants } from '../src/workspace/external-file-grants.ts';
import { FileRewindJournal } from '../../../src/file_rewind.ts';

async function fixture(t: TestContext) {
  const scratch = await mkdtemp(join(tmpdir(), 'circle-exact-grant-'));
  const root = await realpath(scratch);
  const path = join(root, 'outside.txt');
  await writeFile(path, '\uFEFFbefore 中文\r\n');
  const grants = new ExternalFileGrants();
  t.after(async () => {
    await grants.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, path, grants, signal: new AbortController().signal };
}
test('exact grants bind sessions and access without granting siblings; opaque revisions expire on regrant', async (t) => {
  const { root, path, grants, signal } = await fixture(t);
  await writeFile(join(root, 'sibling.txt'), 'sibling');
  const read = await grants.mint('a', path, 'read');
  assert.match(read.id, /^[\da-f-]{36}$/);
  assert.match(
    (await grants.read('a', path, signal)).content!,
    /^\uFEFFbefore/,
  );
  await assert.rejects(grants.read('b', path, signal), /explicit grant/);
  await assert.rejects(
    grants.read('a', join(root, 'sibling.txt'), signal),
    /explicit grant/,
  );
  const old = await grants.read('a', path, signal);
  await assert.rejects(
    grants.apply(
      'a',
      [{ path, content: 'no', expectedRevision: old.revision }],
      signal,
    ),
    /read-only/,
  );
  const writable = await grants.mint('a', path, 'readwrite');
  assert.equal(grants.list('a').length, 1);
  assert.notEqual(writable.id, read.id);
  await assert.rejects(
    grants.apply(
      'a',
      [{ path, content: 'no', expectedRevision: old.revision }],
      signal,
    ),
    /changed since read_file/,
  );
  const current = await grants.read('a', path, signal);
  await grants.apply(
    'a',
    [
      {
        path,
        content: '\uFEFFafter 中文\r\n',
        expectedRevision: current.revision,
      },
    ],
    signal,
  );
  assert.equal(await readFile(path, 'utf8'), '\uFEFFafter 中文\r\n');
  await grants.revoke('a', writable.id);
  await assert.rejects(grants.read('a', path, signal), /explicit grant/);
  assert.deepEqual((await readdir(root)).sort(), [
    'outside.txt',
    'sibling.txt',
  ]);
});
test('revocation and regrant invalidate an already prepared text undo preview', async (t) => {
  const { path, grants, signal } = await fixture(t);
  const grant = await grants.mint('a', path, 'readwrite');
  const journal = new FileRewindJournal({
    read: (p, s) => grants.read('a', p, s),
    apply: (c, s) => grants.apply('a', c, s),
    restoreAtomic: (c, s) => grants.restoreAtomic('a', c, s),
  });
  const before = await grants.read('a', path, signal);
  journal.beginTurn('turn');
  await journal.files.apply(
    [{ path, content: 'after', expectedRevision: before.revision }],
    signal,
  );
  journal.endTurn();
  const preview = await journal.preview('turn', signal);
  await grants.revoke('a', grant.id);
  await grants.mint('a', path, 'readwrite');
  await assert.rejects(
    journal.restore(preview.id, signal),
    /changed after the turn/,
  );
  assert.equal(await readFile(path, 'utf8'), 'after');
  await grants.revokeSession('a');
  assert.deepEqual(grants.list('a'), []);
});
test('symlink hardlink credential binary oversized and private-data grants are refused', async (t) => {
  const { root, path, grants } = await fixture(t);
  const alias = join(root, 'alias.txt');
  await symlink(path, alias);
  await assert.rejects(
    grants.mint('a', alias, 'readwrite'),
    /regular non-linked/,
  );
  await rm(alias);
  await link(path, alias);
  await assert.rejects(grants.mint('a', path, 'read'), /regular non-linked/);
  await rm(alias);
  for (const name of ['.env', 'id_ed25519']) {
    const p = join(root, name);
    await writeFile(p, 'secret');
    await assert.rejects(grants.mint('a', p, 'read'), /credential/);
  }
  await writeFile(path, Buffer.from([0xff, 0x01]));
  await assert.rejects(grants.mint('a', path, 'read'), /encoded data/);
  await writeFile(path, 'a\0b');
  await assert.rejects(grants.mint('a', path, 'read'), /binary/);
  await writeFile(path, 'x'.repeat(100));
  const limited = new ExternalFileGrants({ maxBytes: 32 });
  t.after(() => limited.close());
  await assert.rejects(limited.mint('a', path, 'read'), /too large/);
  const privateGrants = new ExternalFileGrants({ protectedRoots: [root] });
  t.after(() => privateGrants.close());
  await assert.rejects(
    privateGrants.mint('a', path, 'read'),
    /private application/,
  );
});
test('file replacement parent rename and symlink swaps never inherit an exact grant', async (t) => {
  const { root, path, grants, signal } = await fixture(t);
  await grants.mint('a', path, 'readwrite');
  await rename(path, path + '.old');
  await writeFile(path, 'replacement');
  await assert.rejects(grants.read('a', path, signal), /identity changed/);
  await rm(path);
  await rename(path + '.old', path);
  await grants.mint('a', path, 'readwrite');
  await rename(path, path + '.old');
  await symlink(path + '.old', path);
  await assert.rejects(
    grants.read('a', path, signal),
    /identity changed|symbolic/,
  );
  await rm(path);
  await rename(path + '.old', path);
  const parent = join(root, 'parent');
  await mkdir(parent);
  const nested = join(parent, 'file.txt');
  await writeFile(nested, 'original');
  await grants.mint('a', nested, 'readwrite');
  await rename(parent, parent + '.old');
  await mkdir(parent);
  await writeFile(nested, 'replacement');
  await assert.rejects(grants.read('a', nested, signal), /parent moved/);
});
test('all-file preflight and cancellation leave actual files and temporary directory unchanged', async (t) => {
  const { root, path, grants, signal } = await fixture(t);
  const other = join(root, 'other.txt');
  await writeFile(other, 'before other');
  await grants.mint('a', path, 'readwrite');
  await grants.mint('a', other, 'readwrite');
  const one = await grants.read('a', path, signal);
  const two = await grants.read('a', other, signal);
  await writeFile(other, 'external edit');
  await assert.rejects(
    grants.apply(
      'a',
      [
        { path, content: 'after', expectedRevision: one.revision },
        { path: other, content: 'after two', expectedRevision: two.revision },
      ],
      signal,
    ),
    /changed since read_file/,
  );
  assert.equal(await readFile(path, 'utf8'), '\uFEFFbefore 中文\r\n');
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    grants.apply(
      'a',
      [{ path, content: 'after', expectedRevision: one.revision }],
      cancelled.signal,
    ),
  );
  assert.equal(
    (await readdir(root)).some((name) => name.startsWith('.circle-document-')),
    false,
  );
});

test('revoking a session while a read is in flight withholds content and removes its capability', async (t) => {
  const { path, grants, signal } = await fixture(t);
  const grant = await grants.mint('a', path, 'read');
  const internal = grants as unknown as {
    entries: Map<
      string,
      {
        documents: { readTargetOnce: (...args: unknown[]) => Promise<unknown> };
      }
    >;
  };
  const documents = internal.entries.get(grant.id)!.documents;
  const original = documents.readTargetOnce.bind(documents);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  documents.readTargetOnce = async (...args) => {
    const value = await original(...args);
    entered();
    await blocked;
    return value;
  };
  const pending = grants.read('a', path, signal);
  await started;
  const revoked = grants.revokeSession('a');
  const rejected = assert.rejects(pending, /revoked/);
  release();
  await Promise.all([revoked, rejected]);
  assert.deepEqual(grants.list('a'), []);
});

test('abort or revoke after staged bytes cleans the temporary file and does not replace the granted file', async (t) => {
  for (const failure of ['abort', 'revoke'] as const) {
    const { root, path, grants, signal } = await fixture(t);
    const grant = await grants.mint('a', path, 'readwrite');
    const before = await grants.read('a', path, signal);
    const internal = grants as unknown as {
      entries: Map<
        string,
        { documents: { stage: (...args: unknown[]) => Promise<unknown> } }
      >;
    };
    const documents = internal.entries.get(grant.id)!.documents;
    const stage = documents.stage.bind(documents);
    const abort = new AbortController();
    documents.stage = async (...args) => {
      const staged = await stage(...args);
      if (failure === 'abort') abort.abort();
      else void grants.revoke('a', grant.id);
      return staged;
    };
    await assert.rejects(
      grants.apply(
        'a',
        [{ path, content: 'replacement', expectedRevision: before.revision }],
        abort.signal,
      ),
      /transaction failed/,
    );
    assert.equal(await readFile(path, 'utf8'), '\uFEFFbefore 中文\r\n');
    assert.equal(
      (await readdir(root)).some((name) =>
        name.startsWith('.circle-document-'),
      ),
      false,
    );
  }
});

test('a later external mutation failure compensates earlier granted files across parent directories', async (t) => {
  const { root, path, grants, signal } = await fixture(t);
  const parent = join(root, 'separate');
  await mkdir(parent);
  const second = join(parent, 'second.txt');
  await writeFile(second, 'second before');
  await grants.mint('a', path, 'readwrite');
  const grant = await grants.mint('a', second, 'readwrite');
  const one = await grants.read('a', path, signal);
  const two = await grants.read('a', second, signal);
  const internal = grants as unknown as {
    entries: Map<
      string,
      { documents: { applyChanges: () => Promise<unknown> } }
    >;
  };
  internal.entries.get(grant.id)!.documents.applyChanges = async () => {
    throw Error('injected second-file failure');
  };
  await assert.rejects(
    grants.apply(
      'a',
      [
        { path, content: 'first after', expectedRevision: one.revision },
        {
          path: second,
          content: 'second after',
          expectedRevision: two.revision,
        },
      ],
      signal,
    ),
    /completed file changes compensated/,
  );
  assert.equal(await readFile(path, 'utf8'), '\uFEFFbefore 中文\r\n');
  assert.equal(await readFile(second, 'utf8'), 'second before');
  assert.equal(
    (await readdir(root)).some((name) => name.startsWith('.circle-document-')),
    false,
  );
});

test(
  'revocation acknowledgement drains a previously dispatched rename before returning',
  { timeout: 5000 },
  async (t) => {
    const { path, grants, signal } = await fixture(t);
    const grant = await grants.mint('a', path, 'readwrite');
    const before = await grants.read('a', path, signal);
    const require = createRequire(import.meta.url);
    const fs = require('node:fs/promises') as typeof import('node:fs/promises');
    const original = fs.rename;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fs.rename = async (from, to) => {
      if (String(to) === path) {
        entered();
        await blocked;
      }
      return original(from, to);
    };
    syncBuiltinESMExports();
    t.after(() => {
      fs.rename = original;
      syncBuiltinESMExports();
      release();
    });
    const pending = grants.apply(
      'a',
      [
        {
          path,
          content: 'dispatched replacement',
          expectedRevision: before.revision,
        },
      ],
      signal,
    );
    const failure = assert.rejects(pending, (error: unknown) => {
      assert.deepEqual((error as { committedPaths: string[] }).committedPaths, [
        path,
      ]);
      assert.match(String(error), /compensation incomplete/);
      return true;
    });
    await started;
    let acknowledged = false;
    const revoked = grants.revoke('a', grant.id).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    assert.equal(acknowledged, false);
    assert.equal(await readFile(path, 'utf8'), '\uFEFFbefore 中文\r\n');
    release();
    await Promise.all([revoked, failure]);
    assert.equal(acknowledged, true);
    assert.equal(await readFile(path, 'utf8'), 'dispatched replacement');
    assert.equal(grants.allows('a', path, 'write'), false);
  },
);

test('custom relative and absolute credential path patterns deny exact grants', async (t) => {
  const { root, path } = await fixture(t);
  const folder = join(root, 'secrets');
  await mkdir(folder);
  const secret = join(folder, 'config.json');
  await writeFile(secret, 'secret');
  for (const pattern of ['secrets/config.json', secret]) {
    const grants = new ExternalFileGrants({ credentialFiles: [pattern] });
    t.after(() => grants.close());
    await assert.rejects(grants.mint('a', secret, 'read'), /credential/);
  }
  const unrelated = new ExternalFileGrants({
    credentialFiles: ['secrets/config.json'],
  });
  t.after(() => unrelated.close());
  await unrelated.mint('a', path, 'read');
});

test(
  'session revocation also invalidates a picker grant still resolving its selected path',
  { timeout: 5000 },
  async (t) => {
    const { path, grants } = await fixture(t);
    const require = createRequire(import.meta.url);
    const fs = require('node:fs/promises') as typeof import('node:fs/promises');
    const original = fs.realpath;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fs.realpath = (async (...args: Parameters<typeof original>) => {
      if (String(args[0]) === path) {
        entered();
        await blocked;
      }
      return original(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    t.after(() => {
      fs.realpath = original;
      syncBuiltinESMExports();
      release();
    });
    const pending = grants.mint('a', path, 'readwrite');
    const denied = assert.rejects(pending, /request expired with its session/);
    await started;
    await grants.revokeSession('a');
    release();
    await denied;
    assert.deepEqual(grants.list('a'), []);
  },
);
