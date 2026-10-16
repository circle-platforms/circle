import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitWorkspaceService } from '../src/workspace/git.ts';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-git-canonical-'));
  const git = new GitWorkspaceService(root);
  await git.git(['init']);
  return { root, git };
}

async function preview(git: GitWorkspaceService, file: string) {
  return (await git.call('diff', { paths: [file] })) as {
    text: string;
    previews: { path: string; status: string }[];
  };
}

async function stage(git: GitWorkspaceService, patch: string) {
  await git.call('applyHunk', {
    revision: (await git.snapshot()).revision,
    patch,
    action: 'stage',
  });
}

test('untracked canonical EOL matches real git add without changing the original index or objects', async () => {
  const { root, git } = await fixture();
  try {
    await git.git(['config', 'core.autocrlf', 'true']);
    await writeFile(path.join(root, 'new.txt'), 'first\r\nsecond\r\n');
    const objects = await readdir(path.join(root, '.git', 'objects'), {
      recursive: true,
    });
    const shown = await preview(git, 'new.txt');
    assert(
      !shown.text.includes('\r'),
      'preview must represent canonical index bytes',
    );
    assert.deepEqual(
      await readdir(path.join(root, '.git', 'objects'), { recursive: true }),
      objects,
    );
    await assert.rejects(readFile(path.join(root, '.git', 'index')), {
      code: 'ENOENT',
    });
    const partial = shown.text
      .replace('@@ -0,0 +1,2 @@', '@@ -0,0 +1 @@')
      .replace('+second\n', '');
    assert.notEqual(partial, shown.text);
    await stage(git, partial);
    assert.equal(await git.git(['show', ':new.txt']), 'first\n');
    assert.equal(
      await readFile(path.join(root, 'new.txt'), 'utf8'),
      'first\r\nsecond\r\n',
    );
    await git.git(['rm', '--cached', '-f', '--', 'new.txt']);
    await stage(git, shown.text);
    const staged = await git.git(['show', ':new.txt']);
    assert.equal(staged, 'first\nsecond\n');
    await git.git(['rm', '--cached', '--', 'new.txt']);
    await git.git(['add', '--', 'new.txt']);
    assert.equal(await git.git(['show', ':new.txt']), staged);
    assert.equal(
      await readFile(path.join(root, 'new.txt'), 'utf8'),
      'first\r\nsecond\r\n',
    );

    await git.git(['config', 'core.autocrlf', 'false']);
    await writeFile(
      path.join(root, '.gitattributes'),
      'attr.txt text eol=lf\n',
    );
    await writeFile(path.join(root, 'attr.txt'), 'attribute\r\n');
    const attribute = await preview(git, 'attr.txt');
    assert(!attribute.text.includes('\r'));
    await stage(git, attribute.text);
    assert.equal(await git.git(['show', ':attr.txt']), 'attribute\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('untracked mode follows the real Git owner execute bit and core.filemode', async () => {
  const { root, git } = await fixture();
  try {
    await git.git(['config', 'core.autocrlf', 'false']);
    const modes = process.platform === 'win32' ? [0o644] : [0o641, 0o755];
    for (const mode of modes) {
      const name = 'mode-' + mode;
      await writeFile(path.join(root, name), 'mode\n');
      await chmod(path.join(root, name), mode);
      await git.git([
        'config',
        'core.filemode',
        process.platform === 'win32' ? 'false' : 'true',
      ]);
      const shown = await preview(git, name);
      await stage(git, shown.text);
      const staged = await git.git(['ls-files', '--stage', '--', name]);
      assert.match(staged, mode === 0o755 ? /^100755 / : /^100644 /);
      await git.git(['rm', '--cached', '-f', '--', name]);
      await git.git(['add', '--', name]);
      assert.equal(await git.git(['ls-files', '--stage', '--', name]), staged);
      assert.match(staged, mode === 0o755 ? /^100755 / : /^100644 /);
    }
    await git.git(['config', 'core.filemode', 'false']);
    await writeFile(path.join(root, 'ignore-mode'), 'executable\n');
    await chmod(path.join(root, 'ignore-mode'), 0o755);
    const shown = await preview(git, 'ignore-mode');
    await stage(git, shown.text);
    assert.match(
      await git.git(['ls-files', '--stage', '--', 'ignore-mode']),
      /^100644 /,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('untracked preview reports unsupported filters and encodings without running conversion commands', async () => {
  const { root, git } = await fixture();
  try {
    await writeFile(
      path.join(root, '.gitattributes'),
      'filtered.txt filter=unsafe\nencoded.txt working-tree-encoding=UTF-16\n',
    );
    const marker = path.join(root, 'FILTER_MUST_NOT_RUN');
    await git.git([
      'config',
      'filter.unsafe.clean',
      `echo unsafe > "${marker}"`,
    ]);
    await git.git([
      'config',
      'filter.unsafe.process',
      `echo unsafe > "${marker}"`,
    ]);
    await git.git(['config', 'filter.unsafe.required', 'true']);
    for (const name of ['filtered.txt', 'encoded.txt']) {
      await writeFile(path.join(root, name), 'plain\n');
      const shown = await preview(git, name);
      assert.deepEqual(shown.previews, [
        { path: name, status: 'unsupported-conversion' },
      ]);
      assert(!shown.text.includes('@@'));
    }
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(root, '.git', 'index')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('canonical preview converts the validated bytes instead of reopening a replaced working file', async () => {
  const { root } = await fixture();
  const file = path.join(root, 'file.txt'),
    backup = path.join(root, 'original');
  let replaced = false,
    restored = false;
  class FileRace extends GitWorkspaceService {
    override async git(args: string[], input?: string) {
      if (
        args[0] === 'config' &&
        args[1] === '--bool' &&
        args[2] === 'core.filemode' &&
        replaced &&
        !restored
      ) {
        await rm(file);
        await rename(backup, file);
        restored = true;
      }
      const value = await super.git(args, input);
      if (args[0] === 'check-attr' && !replaced) {
        await rename(file, backup);
        await writeFile(file, 'later file must not be previewed\r\n');
        replaced = true;
      }
      return value;
    }
  }
  const git = new FileRace(root);
  try {
    await git.git(['config', 'core.autocrlf', 'true']);
    await writeFile(file, 'validated descriptor bytes\r\n');
    const shown = await preview(git, 'file.txt');
    assert(
      replaced && restored,
      'actual file replacement must straddle Git conversion',
    );
    assert(shown.text.includes('+validated descriptor bytes\n'));
    assert(!shown.text.includes('later file must not be previewed'));
    assert.equal(
      await readFile(file, 'utf8'),
      'validated descriptor bytes\r\n',
    );
    await stage(git, shown.text);
    assert.equal(
      await git.git(['show', ':file.txt']),
      'validated descriptor bytes\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
