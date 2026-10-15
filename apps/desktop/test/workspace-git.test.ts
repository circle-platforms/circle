import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitWorkspaceService } from '../src/workspace/git.ts';
test('explicit staging, partial patch, stale revision and selected commits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-'));
  const service = new GitWorkspaceService(root);
  try {
    await service.git(['init']);
    await service.git(['config', 'user.name', 'Test']);
    await service.git(['config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
    await service.git(['add', 'a.txt']);
    await service.git(['commit', '-m', 'Initial']);
    await writeFile(path.join(root, 'a.txt'), 'ONE\ntwo\n');
    await writeFile(path.join(root, 'private.txt'), 'keep');
    const state = await service.snapshot();
    await assert.rejects(
      service.call('stage', { revision: 'stale', paths: ['a.txt'] }),
      /changed/,
    );
    const diff = (await service.call('diff', { paths: ['a.txt'] })) as {
      text: string;
    };
    await service.call('applyPatch', {
      revision: state.revision,
      patch: diff.text,
      action: 'stage',
    });
    assert.equal(await service.git(['show', ':a.txt']), 'ONE\ntwo\n');
    await assert.rejects(
      service.call('commit', {
        revision: (await service.snapshot()).revision,
        paths: ['private.txt'],
        message: 'Wrong',
      }),
      /selection/,
    );
    await service.call('commit', {
      revision: (await service.snapshot()).revision,
      paths: ['a.txt'],
      message: 'Selected',
    });
    assert.equal(
      await readFile(path.join(root, 'private.txt'), 'utf8'),
      'keep',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('merge conflict is resolved and continued through service', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-conflict-'));
  const s = new GitWorkspaceService(root);
  try {
    await s.git(['init', '-b', 'main']);
    await s.git(['config', 'user.name', 'Test']);
    await s.git(['config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(root, 'a'), 'base\n');
    await s.git(['add', 'a']);
    await s.git(['commit', '-m', 'Base']);
    await s.git(['checkout', '-b', 'feature']);
    await writeFile(path.join(root, 'a'), 'feature\n');
    await s.git(['commit', '-am', 'Feature']);
    await s.git(['checkout', 'main']);
    await writeFile(path.join(root, 'a'), 'main\n');
    await s.git(['commit', '-am', 'Main']);
    await s.git(['merge', 'feature']).catch(() => {});
    assert.equal((await s.snapshot()).merging, true);
    await assert.rejects(
      s.call('conflictContinue', { revision: (await s.snapshot()).revision }),
      /resolve/,
    );
    await writeFile(path.join(root, 'a'), 'main\nfeature\n');
    await s.call('stage', {
      revision: (await s.snapshot()).revision,
      paths: ['a'],
    });
    await s.call('conflictContinue', {
      revision: (await s.snapshot()).revision,
    });
    assert.equal((await s.snapshot()).merging, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('literal filenames and one hunk preserve other unstaged edits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-hunk-'));
  const s = new GitWorkspaceService(root);
  try {
    await s.git(['init']);
    await s.git(['config', 'user.name', 'Test']);
    await s.git(['config', 'user.email', 'test@example.invalid']);
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    await writeFile(path.join(root, 'file'), lines.join('\n') + '\n');
    await s.git(['add', 'file']);
    await s.git(['commit', '-m', 'Base']);
    const changed = [...lines];
    changed[1] = 'first edit';
    changed[28] = 'second edit';
    await writeFile(path.join(root, 'file'), changed.join('\n') + '\n');
    const { text } = (await s.call('diff', { paths: ['file'] })) as {
      text: string;
    };
    const offset = text.search(/^@@ /m);
    const header = text.slice(0, offset);
    const hunks = text.slice(offset).split(/(?=^@@ )/m);
    assert.equal(hunks.length, 2);
    await s.call('applyHunk', {
      revision: (await s.snapshot()).revision,
      patch: header + hunks[0],
      action: 'stage',
    });
    const staged = await s.git(['show', ':file']);
    assert.ok(staged.includes('first edit'));
    assert.ok(!staged.includes('second edit'));
    await s.call('discard', {
      revision: (await s.snapshot()).revision,
      patch: header + hunks[1],
    });
    assert.ok(
      !(await readFile(path.join(root, 'file'), 'utf8')).includes(
        'second edit',
      ),
    );
    await s.call('unstage', {
      revision: (await s.snapshot()).revision,
      paths: ['file'],
    });
    await writeFile(path.join(root, '*'), 'literal');
    await writeFile(path.join(root, 'other'), 'private');
    await s.call('stage', {
      revision: (await s.snapshot()).revision,
      paths: ['*'],
    });
    assert.equal(await s.git(['diff', '--cached', '--name-only']), '*\n');
    await assert.rejects(
      s.call('stage', {
        revision: (await s.snapshot()).revision,
        paths: ['../escape'],
      }),
      /relative/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('trusted constructor identity signs commits while renderer identity overrides are ignored', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-identity-'));
  const s = new GitWorkspaceService(root, {
    identity: { name: 'Trusted Maintainer', email: 'trusted@example.invalid' },
    signoff: true,
  });
  try {
    await s.git(['init']);
    await s.git(['config', 'user.name', 'Original']);
    await s.git(['config', 'user.email', 'original@example.invalid']);
    await writeFile(path.join(root, 'feature'), 'verified');
    await s.call('stage', {
      revision: (await s.snapshot()).revision,
      paths: ['feature'],
    });
    await s.call('commit', {
      revision: (await s.snapshot()).revision,
      paths: ['feature'],
      message: 'Add verified feature',
      identity: { name: 'Forged', email: 'forged@example.invalid' },
      signoff: false,
    });
    assert.equal(
      (await s.git(['log', '-1', '--format=%an <%ae>'])).trim(),
      'Trusted Maintainer <trusted@example.invalid>',
    );
    const body = await s.git(['log', '-1', '--format=%B']);
    assert.match(
      body,
      /Signed-off-by: Trusted Maintainer <trusted@example.invalid>/,
    );
    assert.doesNotMatch(body, /Forged|forged@/);
    assert.equal((await s.git(['config', 'user.name'])).trim(), 'Original');
    assert.equal(
      (await s.git(['config', 'user.email'])).trim(),
      'original@example.invalid',
    );
    const manual = new GitWorkspaceService(root);
    await writeFile(path.join(root, 'feature'), 'manual change');
    await manual.call('stage', {
      revision: (await manual.snapshot()).revision,
      paths: ['feature'],
    });
    await manual.call('commit', {
      revision: (await manual.snapshot()).revision,
      paths: ['feature'],
      message: 'Record manual change',
      identity: { name: 'Forged', email: 'forged@example.invalid' },
      signoff: true,
    });
    assert.equal(
      (await manual.git(['log', '-1', '--format=%an <%ae>'])).trim(),
      'Original <original@example.invalid>',
    );
    assert.doesNotMatch(
      await manual.git(['log', '-1', '--format=%B']),
      /Signed-off-by|Forged/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('same-head branch changes and origin push destination changes invalidate old revisions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-base-'));
  const remoteA = await mkdtemp(path.join(tmpdir(), 'circle-git-remote-a-'));
  const remoteB = await mkdtemp(path.join(tmpdir(), 'circle-git-remote-b-'));
  const s = new GitWorkspaceService(root);
  try {
    await s.git(['init', '-b', 'codex/a']);
    await s.git(['config', 'user.name', 'Test']);
    await s.git(['config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(root, 'feature'), 'base');
    await s.git(['add', 'feature']);
    await s.git(['commit', '-m', 'Base']);
    await s.git(['init', '--bare', remoteA]);
    await s.git(['init', '--bare', remoteB]);
    await s.git(['remote', 'add', 'origin', remoteA]);
    await s.git(['branch', 'codex/b']);
    const a = await s.snapshot();
    await s.git(['checkout', 'codex/b']);
    const b = await s.snapshot();
    assert.equal(a.head, b.head);
    assert.notEqual(a.revision, b.revision);
    await assert.rejects(
      s.call('push', { revision: a.revision }),
      /branch or push destination changed/,
    );
    await assert.rejects(
      s.git([
        '--git-dir=' + remoteA,
        'rev-parse',
        '--verify',
        'refs/heads/codex/b',
      ]),
    );
    await s.git(['remote', 'set-url', '--push', 'origin', remoteB]);
    const changedRemote = await s.snapshot();
    assert.notEqual(changedRemote.revision, b.revision);
    await assert.rejects(
      s.call('push', { revision: b.revision }),
      /push destination changed/,
    );
    await assert.rejects(
      s.git([
        '--git-dir=' + remoteB,
        'rev-parse',
        '--verify',
        'refs/heads/codex/b',
      ]),
    );
    await s.call('push', { revision: changedRemote.revision });
    assert.equal(
      (
        await s.git(['--git-dir=' + remoteB, 'rev-parse', 'refs/heads/codex/b'])
      ).trim(),
      b.head,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remoteA, { recursive: true, force: true });
    await rm(remoteB, { recursive: true, force: true });
  }
});
