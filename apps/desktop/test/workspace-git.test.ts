import nodeTest from 'node:test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitWorkspaceService } from '../src/workspace/git.ts';
// CI may buffer a later test file's TAP behind another file. A separate journal
// records actual entry, each Git completion and cleanup without changing limits.
const progressPath =
  process.env.CIRCLE_GIT_TEST_PROGRESS ??
  (process.env.CI && process.platform === 'win32'
    ? fileURLToPath(
        new URL(
          `../artifacts/runtime/git-progress-${process.pid}.jsonl`,
          import.meta.url,
        ),
      )
    : undefined);
const pendingGit = new Map<number, string>();
let commandId = 0;
function progress(event: string, details: Record<string, unknown> = {}) {
  if (!progressPath) return;
  mkdirSync(path.dirname(progressPath), { recursive: true });
  appendFileSync(
    progressPath,
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      event,
      ...details,
    }) + '\n',
  );
}
const test = (name: string, run: () => Promise<void>) =>
  nodeTest(name, async () => {
    progress('test-start', { name });
    try {
      await run();
    } finally {
      progress('test-cleanup-complete', {
        name,
        pending: [...pendingGit.values()],
        resources: process.getActiveResourcesInfo(),
      });
    }
  });
class ObservedGit extends GitWorkspaceService {
  override async git(args: string[], input?: string) {
    const id = ++commandId,
      command = args[0];
    pendingGit.set(id, command ?? 'unknown');
    progress('git-start', { id, command });
    try {
      const result = await super.git(args, input);
      progress('git-close', { id, command });
      return result;
    } catch (error) {
      progress('git-error', {
        id,
        command,
        code: (error as NodeJS.ErrnoException).code,
      });
      throw error;
    } finally {
      pendingGit.delete(id);
    }
  }
}

test('explicit staging, partial patch, stale revision and selected commits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-'));
  const service = new ObservedGit(root);
  try {
    await service.git(['init']);
    await service.git(['config', 'core.autocrlf', 'false']);
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
  const s = new ObservedGit(root);
  try {
    await s.git(['init', '-b', 'main']);
    await s.git(['config', 'core.autocrlf', 'false']);
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
  const s = new ObservedGit(root);
  try {
    await s.git(['init']);
    await s.git(['config', 'core.autocrlf', 'false']);
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
    const literal = process.platform === 'win32' ? '[literal]' : '*';
    await writeFile(path.join(root, literal), 'literal');
    await writeFile(path.join(root, 'other'), 'private');
    await s.call('stage', {
      revision: (await s.snapshot()).revision,
      paths: [literal],
    });
    assert.equal(
      await s.git(['diff', '--cached', '--name-only']),
      literal + '\n',
    );
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
  const s = new ObservedGit(root, {
    identity: { name: 'Trusted Maintainer', email: 'trusted@example.invalid' },
    signoff: true,
  });
  try {
    await s.git(['init']);
    await s.git(['config', 'core.autocrlf', 'false']);
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
    const manual = new ObservedGit(root);
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
  const s = new ObservedGit(root);
  try {
    await s.git(['init', '-b', 'codex/a']);
    await s.git(['config', 'core.autocrlf', 'false']);
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

test('read-only refresh preserves index bytes and required write locks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-read-lock-'));
  const s = new ObservedGit(root);
  try {
    await s.git(['init', '-b', 'codex/a']);
    await s.git(['config', 'core.autocrlf', 'false']);
    await s.git(['config', 'user.name', 'Test']);
    await s.git(['config', 'user.email', 'test@example.invalid']);
    for (let i = 0; i < 40; i++)
      await writeFile(path.join(root, `file-${i}`), 'original\n');
    await s.git([
      'add',
      '--',
      ...Array.from({ length: 40 }, (_, i) => `file-${i}`),
    ]);
    await s.git(['commit', '-m', 'Initial']);
    await s.git(['branch', 'codex/b']);
    const index = path.join(root, '.git', 'index');
    const before = await readFile(index);
    const future = new Date(Date.now() + 5000);
    for (let i = 0; i < 40; i++)
      await utimes(path.join(root, `file-${i}`), future, future);
    await s.snapshot();
    await s.call('diff', { paths: ['file-0'] });
    assert.deepEqual(
      await readFile(index),
      before,
      'readers must not refresh index stat cache',
    );
    for (let round = 0; round < 10; round++) {
      await utimes(
        path.join(root, 'file-0'),
        new Date(Date.now() + 6000 + round),
        new Date(Date.now() + 6000 + round),
      );
      await Promise.all([
        ...Array.from({ length: 6 }, () =>
          s.git(['status', '--porcelain=v1', '-z']),
        ),
        s.git(['switch', round % 2 ? 'codex/a' : 'codex/b']),
      ]);
    }
    await writeFile(path.join(root, 'file-0'), 'changed\n');
    const revision = (await s.snapshot()).revision;
    const lock = path.join(root, '.git', 'index.lock');
    await writeFile(lock, 'owned sentinel');
    await assert.rejects(
      s.call('stage', { revision, paths: ['file-0'] }),
      /index.lock/,
    );
    assert.equal(await readFile(lock, 'utf8'), 'owned sentinel');
    await rm(lock);
    await s.call('stage', {
      revision: (await s.snapshot()).revision,
      paths: ['file-0'],
    });
    assert.equal(await s.git(['show', ':file-0']), 'changed\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parallel snapshots retry a changed baseline and reject continuous mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-consistent-'));
  const service = new ObservedGit(root);
  try {
    await service.git(['init', '-b', 'codex/a']);
    await service.git(['config', 'user.name', 'Fixture']);
    await service.git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(root, 'value'), 'original\n');
    await service.git(['add', 'value']);
    await service.git(['commit', '-m', 'Create baseline']);
    await service.git(['branch', 'codex/b']);
    const run = service.git.bind(service);
    let active = 0,
      peak = 0,
      statusReads = 0;
    let branchCaptured!: () => void;
    const branchRead = new Promise<void>((resolve) => {
      branchCaptured = resolve;
    });
    service.git = async (args, input) => {
      active++;
      peak = Math.max(peak, active);
      try {
        const value = await run(args, input);
        if (args[0] === 'symbolic-ref') branchCaptured();
        if (args[0] === 'status' && ++statusReads === 1) {
          await branchRead;
          await run(['switch', 'codex/b']);
        }
        return value;
      } finally {
        active--;
      }
    };
    const result = await service.snapshot();
    assert.equal(result.branch, 'codex/b');
    assert.ok(statusReads >= 3, 'a mixed first read must be retried');
    assert.ok(peak > 1, 'independent read commands run concurrently');
    let writes = 0;
    service.git = async (args, input) => {
      const value = await run(args, input);
      if (args[0] === 'status')
        await writeFile(path.join(root, 'value'), `change ${++writes}\n`);
      return value;
    };
    await assert.rejects(service.snapshot(), /changed while reading/);
    assert.equal(writes, 4, 'unstable reads stop at a bounded retry count');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('isolated delivery pushes leave shared configuration unchanged while manual pushes establish upstream', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-shared-config-'));
  const source = path.join(root, 'source'),
    remote = path.join(root, 'remote.git');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(source);
  const s = new ObservedGit(source);
  try {
    await s.git(['init', '-b', 'main']);
    await s.git(['config', 'user.name', 'Fixture']);
    await s.git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(source, 'value'), 'baseline');
    await s.git(['add', 'value']);
    await s.git(['commit', '-m', 'Create baseline']);
    await s.git(['init', '--bare', remote]);
    await s.git(['remote', 'add', 'origin', remote]);
    const a = path.join(root, 'owner-a'),
      b = path.join(root, 'owner-b');
    await s.git(['worktree', 'add', '-b', 'codex/a', a]);
    await s.git(['worktree', 'add', '-b', 'codex/b', b]);
    const left = new ObservedGit(a, { setUpstream: false }),
      right = new ObservedGit(b, { setUpstream: false });
    const config = path.join(source, '.git', 'config'),
      before = await readFile(config);
    const [sa, sb] = await Promise.all([left.snapshot(), right.snapshot()]);
    await Promise.all([
      left.call('push', { revision: sa.revision }),
      right.call('push', { revision: sb.revision }),
      ...Array.from({ length: 4 }, () => s.snapshot()),
    ]);
    assert.deepEqual(
      await readFile(config),
      before,
      'owned automatic pushes must not rename shared config',
    );
    assert.equal(
      (
        await s.git(['--git-dir=' + remote, 'rev-parse', 'refs/heads/codex/a'])
      ).trim(),
      sa.head,
    );
    assert.equal(
      (
        await s.git(['--git-dir=' + remote, 'rev-parse', 'refs/heads/codex/b'])
      ).trim(),
      sb.head,
    );
    await assert.rejects(
      left.git(['config', '--get', 'branch.codex/a.remote']),
    );
    const manual = new ObservedGit(a);
    await manual.call('push', {
      revision: (await manual.snapshot()).revision,
      setUpstream: false,
    });
    assert.equal(
      (await manual.git(['config', '--get', 'branch.codex/a.remote'])).trim(),
      'origin',
      'renderer cannot override trusted constructor policy',
    );
    assert.equal(
      (await manual.git(['config', '--get', 'branch.codex/a.merge'])).trim(),
      'refs/heads/codex/a',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configuration permission errors are not interpreted as an absent remote or detached HEAD', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-read-denied-'));
  const s = new ObservedGit(root);
  try {
    await s.git(['init', '-b', 'codex/safe']);
    const empty = await s.snapshot();
    assert.equal(empty.head, 'unborn');
    assert.equal(empty.merging, false);
    const run = s.git.bind(s);
    for (const command of ['remote', 'symbolic-ref']) {
      s.git = async (args, input) => {
        if (args[0] === command)
          throw Object.assign(
            Error('Permission denied while reading configuration files'),
            { code: 128 },
          );
        return run(args, input);
      };
      await assert.rejects(s.snapshot(), /Permission denied/);
    }
    s.git = run;
    assert.equal((await s.snapshot()).branch, 'codex/safe');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native writes in distinct worktrees share the actual repository mutation queue', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-common-queue-'));
  const source = path.join(root, 'source');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(source);
  const s = new ObservedGit(source);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await s.git(['init', '-b', 'main']);
    await s.git(['config', 'user.name', 'Fixture']);
    await s.git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(source, 'base'), 'base');
    await s.git(['add', 'base']);
    await s.git(['commit', '-m', 'Create baseline']);
    const a = path.join(root, 'a'),
      b = path.join(root, 'b');
    await s.git(['worktree', 'add', '-b', 'codex/a', a]);
    await s.git(['worktree', 'add', '-b', 'codex/b', b]);
    const left = new ObservedGit(a),
      right = new ObservedGit(b);
    await writeFile(path.join(a, 'left'), 'left');
    await writeFile(path.join(b, 'right'), 'right');
    const [sa, sb] = await Promise.all([left.snapshot(), right.snapshot()]);
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = 0,
      peak = 0,
      rightWrites = 0;
    for (const [service, first] of [
      [left, true],
      [right, false],
    ] as const) {
      const run = service.git.bind(service);
      service.git = async (args, input) => {
        if (args[0] !== 'add') return run(args, input);
        active++;
        peak = Math.max(peak, active);
        try {
          const result = await run(args, input);
          if (first) {
            entered();
            await gate;
          } else rightWrites++;
          return result;
        } finally {
          active--;
        }
      };
    }
    const one = left.call('stage', { revision: sa.revision, paths: ['left'] });
    await firstEntered;
    const two = right.call('stage', {
      revision: sb.revision,
      paths: ['right'],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      rightWrites,
      0,
      'second worktree cannot enter its real index write while first owns common repo',
    );
    release();
    await Promise.all([one, two]);
    assert.equal(peak, 1);
    assert.equal((await left.git(['show', ':left'])).trim(), 'left');
    assert.equal((await right.git(['show', ':right'])).trim(), 'right');
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test('only read-only configuration sharing failures retry with a strict bound', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-read-retry-'));
  const s = new ObservedGit(root);
  const transport = s as unknown as {
    executeGit: (args: string[], input?: string) => Promise<string>;
  };
  const execute = transport.executeGit.bind(s);
  let attempts = 0;
  const denied = () =>
    Object.assign(Error('unable to access .git/config: Permission denied'), {
      code: 128,
    });
  try {
    await s.git(['init', '-b', 'codex/retry']);
    transport.executeGit = async (args, input) => {
      if (args[0] === 'rev-parse' && ++attempts < 3) throw denied();
      return execute(args, input);
    };
    assert.ok(
      (await s.git(['rev-parse', '--git-common-dir'])).includes('.git'),
    );
    assert.equal(attempts, 3);
    attempts = 0;
    transport.executeGit = async () => {
      attempts++;
      throw denied();
    };
    await assert.rejects(
      s.git(['rev-parse', '--git-common-dir']),
      /Permission denied/,
    );
    assert.equal(attempts, 3);
    attempts = 0;
    await assert.rejects(
      s.git(['push', 'origin', 'codex/retry']),
      /Permission denied/,
    );
    assert.equal(attempts, 1, 'unknown push effects must never be replayed');
    attempts = 0;
    transport.executeGit = async () => {
      attempts++;
      throw Error('unrelated failure');
    };
    await assert.rejects(s.git(['status', '--porcelain']), /unrelated failure/);
    assert.equal(attempts, 1);
  } finally {
    transport.executeGit = execute;
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit untracked previews show real added text without changing index or reading external links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-untracked-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'circle-git-outside-'));
  const s = new ObservedGit(root);
  try {
    await s.git(['init']);
    await s.git(['config', 'core.autocrlf', 'false']);
    await s.git(['config', 'user.name', 'Fixture']);
    await s.git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(root, 'base'), 'base\n');
    await s.git(['add', '--', 'base']);
    await s.git(['commit', '-m', 'Create baseline']);
    const indexPath = path.join(root, '.git', 'index');
    const beforeIndex = await readFile(indexPath);
    const filename = 'new [file] 中文.txt';
    await writeFile(path.join(root, filename), 'first\nsecond');
    await writeFile(path.join(root, 'private-unselected'), 'DO_NOT_INCLUDE');
    await writeFile(path.join(root, 'binary'), Buffer.from([1, 0, 3]));
    await writeFile(
      path.join(root, 'huge'),
      Buffer.alloc(1024 * 1024 + 1, 120),
    );
    const result = (await s.call('diff', { paths: [filename] })) as {
      text: string;
      previews: { path: string; status: string }[];
    };
    assert.match(result.text, /--- \/dev\/null/);
    assert.match(
      result.text,
      /\+first\n\+second\n\\ No newline at end of file/,
    );
    assert(!result.text.includes('DO_NOT_INCLUDE'));
    assert.deepEqual(result.previews, [{ path: filename, status: 'text' }]);
    assert.deepEqual(await readFile(indexPath), beforeIndex);
    assert.equal(
      await readFile(path.join(root, filename), 'utf8'),
      'first\nsecond',
    );
    const bounded = (await s.call('diff', { paths: ['binary', 'huge'] })) as {
      text: string;
      previews: { status: string }[];
    };
    assert.deepEqual(bounded.previews.map((p) => p.status).sort(), [
      'binary',
      'too-large',
    ]);
    assert.match(bounded.text, /Binary files/);
    assert.match(bounded.text, /1 MiB/);
    const { mkdir, symlink } = await import('node:fs/promises');
    await mkdir(path.join(root, 'directory'));
    await writeFile(path.join(root, 'directory', 'nested'), 'NESTED_SECRET');
    assert.equal(
      ((await s.call('diff', { paths: ['directory'] })) as { text: string })
        .text,
      '',
    );
    await writeFile(path.join(outside, 'secret'), 'EXTERNAL_SECRET');
    await symlink(
      outside,
      path.join(root, 'external'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const linked = (await s.call('diff', { paths: ['external'] })) as {
      text: string;
      previews: { status: string }[];
    };
    assert(!linked.text.includes('EXTERNAL_SECRET'));
    // Snapshot fingerprints link identity, not the external target content.
    const revision = (await s.snapshot()).revision;
    await writeFile(path.join(outside, 'secret'), 'EXTERNAL_SECRET_CHANGED');
    assert.equal((await s.snapshot()).revision, revision);
    await assert.rejects(s.call('diff', { paths: ['../secret'] }), /relative/);
    assert.deepEqual(await readFile(indexPath), beforeIndex);
    // The generated quoted UTF-8 patch is accepted by actual Git's existing hunk stage path.
    const partial = result.text
      .replace('@@ -0,0 +1,2 @@', '@@ -0,0 +1,1 @@')
      .replace('+second\n\\ No newline at end of file\n', '');
    await s.call('applyHunk', {
      revision: (await s.snapshot()).revision,
      patch: partial,
      action: 'stage',
    });
    assert.equal(await s.git(['show', `:${filename}`]), 'first\n');
    assert.equal(
      await readFile(path.join(root, filename), 'utf8'),
      'first\nsecond',
    );
    await s.call('unstage', {
      revision: (await s.snapshot()).revision,
      paths: [filename],
    });
    const fresh = await s.snapshot();
    await s.call('applyHunk', {
      revision: fresh.revision,
      patch: result.text,
      action: 'stage',
    });
    assert.equal(await s.git(['show', `:${filename}`]), 'first\nsecond');
    if (process.platform !== 'win32') {
      const control = 'line\nbreak\t.txt';
      await writeFile(path.join(root, control), 'controlled\n');
      const preview = (await s.call('diff', { paths: [control] })) as {
        text: string;
      };
      assert(preview.text.includes('\\n') && preview.text.includes('\\t'));
      await s.call('applyHunk', {
        revision: (await s.snapshot()).revision,
        patch: preview.text,
        action: 'stage',
      });
      assert.equal(await s.git(['show', `:${control}`]), 'controlled\n');
    }

    assert.equal(
      (
        (await s.call('diff', { scope: 'index', paths: [filename] })) as {
          text: string;
        }
      ).text.includes('+first'),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('untracked previews enforce parent boundaries and preserve the Git executable mode policy', async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'circle-git-preview-boundary-'),
  );
  const outside = await mkdtemp(
    path.join(tmpdir(), 'circle-git-preview-secret-'),
  );
  const s = new ObservedGit(root);
  try {
    await s.git(['init']);
    await s.git(['config', 'core.autocrlf', 'false']);
    const { symlink, chmod } = await import('node:fs/promises');
    await symlink(
      outside,
      path.join(root, 'outside-parent'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(path.join(outside, 'regular'), 'OUTSIDE_BYTES');
    const preview = s as unknown as {
      untrackedPreview(
        root: string,
        path: string,
      ): Promise<{ status: string; text: string }>;
      fileFingerprint(root: string, path: string): Promise<Buffer>;
    };
    assert.equal(
      (await preview.untrackedPreview(root, 'outside-parent/regular')).status,
      'outside',
    );
    assert.equal(
      (
        await preview.fileFingerprint(root, 'outside-parent/regular')
      ).toString(),
      'unreadable:outside',
    );
    if (process.platform !== 'win32') {
      await symlink('PRIVATE_TARGET_TEXT', path.join(outside, 'link'));
      const result = await preview.untrackedPreview(
        root,
        'outside-parent/link',
      );
      assert.equal(result.status, 'outside');
      assert(!result.text.includes('PRIVATE_TARGET_TEXT'));
      assert.equal(
        (await preview.fileFingerprint(root, 'outside-parent/link')).toString(),
        'unreadable:outside',
      );
    }
    await writeFile(
      path.join(root, 'script.sh'),
      '#!/bin/sh\necho first\necho second\n',
    );
    await chmod(path.join(root, 'script.sh'), 0o755);
    await s.git(['config', 'core.filemode', 'true']);
    let diff = (await s.call('diff', { paths: ['script.sh'] })) as {
      text: string;
    };
    if (process.platform !== 'win32')
      assert.match(diff.text, /new file mode 100755/);
    else assert.match(diff.text, /new file mode 100(?:644|755)/);
    await s.call('applyHunk', {
      revision: (await s.snapshot()).revision,
      patch: diff.text
        .replace('@@ -0,0 +1,3 @@', '@@ -0,0 +1,2 @@')
        .replace('+echo second\n', ''),
      action: 'stage',
    });
    assert.equal(
      await s.git(['show', ':script.sh']),
      '#!/bin/sh\necho first\n',
    );
    const nativeMode = (
      await s.git(['ls-files', '--stage', '--', 'script.sh'])
    ).split(' ')[0];
    if (process.platform !== 'win32') assert.equal(nativeMode, '100755');
    await s.git(['rm', '--cached', '-f', '--', 'script.sh']);
    await s.git(['config', 'core.filemode', 'false']);
    diff = (await s.call('diff', { paths: ['script.sh'] })) as { text: string };
    assert.match(diff.text, /new file mode 100644/);
    await s.call('applyHunk', {
      revision: (await s.snapshot()).revision,
      patch: diff.text,
      action: 'stage',
    });
    assert.equal(
      (await s.git(['ls-files', '--stage', '--', 'script.sh'])).split(' ')[0],
      '100644',
    );
    assert.equal(
      await readFile(path.join(root, 'script.sh'), 'utf8'),
      '#!/bin/sh\necho first\necho second\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
