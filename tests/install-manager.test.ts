import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installLocation, pruneVersions } from '../src/install_layout.js';
import { scratch } from './helpers.js';
import { fixture } from './release-fixture.js';

const windows = process.platform === 'win32';

/** A directory that stands in for `/` when the installer looks for bash and zsh. */
function shellRoot(dir: string, names: readonly string[]): string {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const name of names) writeFileSync(join(dir, 'bin', name), '');
  return dir;
}

function runManager(
  base: string,
  root: string,
  path: string[],
  extra: Record<string, string> = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'CIRCLE_PREFIX',
    'CIRCLE_BIN_DIR',
    'CIRCLE_REPO',
    'CIRCLE_INSTALL_RESULT',
    'CIRCLE_SHELL_ROOT',
  ])
    delete env[name];
  // Only fake locations: the installer must never write to the real home or its startup files.
  Object.assign(env, {
    HOME: join(base, 'home'),
    USERPROFILE: join(base, 'home'),
    LOCALAPPDATA: join(base, 'appdata'),
    PATH: path.join(windows ? ';' : ':'),
    Path: path.join(windows ? ';' : ':'),
    ...extra,
  });
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/install_manager.ts', root],
    { encoding: 'utf8', env, timeout: 60_000 },
  );
}

test('the installer says each step while it takes it, and which old versions it removed', (t) => {
  const base = scratch(t);
  const prefix = join(base, 'install');
  // Three releases from before, of which the oldest is one too many.
  for (const version of ['0.1.0', '0.2.0', '0.3.0']) {
    mkdirSync(join(prefix, 'versions', version), { recursive: true });
    writeFileSync(join(prefix, 'versions', version, 'release.json'), '{}');
  }
  const result = join(base, 'result.json');
  const run = runManager(base, fixture(base, '1.0.0'), [], {
    CIRCLE_PREFIX: prefix,
    CIRCLE_BIN_DIR: join(base, 'bin'),
    CIRCLE_NO_PATH: '1',
    CIRCLE_INSTALL_RESULT: result,
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.deepEqual(run.stdout.split('\n').slice(0, 4), [
    '[circle-install] checking the release',
    `[circle-install] copying circle 1.0.0 to ${join(prefix, 'versions', '1.0.0')}`,
    '[circle-install] removed circle 0.1.0',
    `[circle-install] installed circle 1.0.0 in ${prefix}`,
  ]);
  assert.equal(existsSync(join(prefix, 'versions', '0.1.0')), false);
  assert.ok(existsSync(join(prefix, 'versions', '0.2.0')));
  // What install.ps1 reads back to put the launcher folder on PATH.
  assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), {
    version: '1.0.0',
    prefix,
    binDir: join(base, 'bin'),
  });
});

test('an explicit prefix and bin folder win over the default location', (t) => {
  const base = scratch(t);
  const env = {
    HOME: join(base, 'home'),
    USERPROFILE: join(base, 'home'),
    LOCALAPPDATA: join(base, 'appdata'),
  };
  assert.deepEqual(installLocation({}, env, 'darwin'), {
    prefix: resolve(base, 'home', '.local', 'share', 'circle'),
    binDir: resolve(base, 'home', '.local', 'bin'),
  });
  assert.deepEqual(installLocation({}, env, 'win32'), {
    prefix: resolve(base, 'appdata', 'circle'),
    binDir: resolve(base, 'appdata', 'circle', 'bin'),
  });
  // On Windows the launcher folder follows a prefix that was given.
  assert.equal(
    installLocation({ prefix: join(base, 'mine') }, env, 'win32').binDir,
    resolve(base, 'mine', 'bin'),
  );
  assert.deepEqual(
    installLocation(
      { prefix: join(base, 'mine'), binDir: join(base, 'my bin') },
      env,
      'linux',
    ),
    { prefix: resolve(base, 'mine'), binDir: resolve(base, 'my bin') },
  );
});

test(
  'a launcher folder missing from PATH gets one marked line in the shell startup file',
  {
    skip: windows,
  },
  (t) => {
    const base = scratch(t);
    const root = fixture(base, '1.0.0');
    const shells = shellRoot(join(base, 'shells'), ['bash']);
    for (const run of [1, 2]) {
      const result = runManager(base, root, [], {
        SHELL: '/bin/bash',
        CIRCLE_SHELL_ROOT: shells,
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(/added .* to PATH/.test(result.stdout), run === 1);
    }
    const rc = readFileSync(join(base, 'home', '.bashrc'), 'utf8');
    assert.equal(rc.match(/# circle path/g)?.length, 1);
    assert.match(
      rc,
      new RegExp(
        `export PATH="${join(base, 'home', '.local', 'bin')}:\\$PATH"`,
      ),
    );
    const quiet = runManager(base, root, [], {
      SHELL: '/bin/zsh',
      CIRCLE_NO_PATH: '1',
      CIRCLE_SHELL_ROOT: shells,
    });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(existsSync(join(base, 'home', '.zshrc')), false);
  },
);

test(
  'a missing zsh does not get a startup file when bash is installed',
  { skip: windows },
  (t) => {
    const base = scratch(t);
    const root = fixture(base, '1.0.0');
    const result = runManager(base, root, [], {
      SHELL: '/no/such/zsh',
      BASH: '/bin/bash',
      CIRCLE_SHELL_ROOT: shellRoot(join(base, 'shells'), ['bash']),
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /added .* to PATH in .*\.bashrc/);
    assert.equal(existsSync(join(base, 'home', '.bashrc')), true);
    assert.equal(existsSync(join(base, 'home', '.zshrc')), false);
  },
);

test(
  'an otherwise empty zshrc is deleted when the installer PATH block is removed',
  { skip: windows },
  (t) => {
    const base = scratch(t);
    const root = fixture(base, '1.0.0');
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const zshrc = join(home, '.zshrc');
    const block = '# circle path\nexport PATH="/usr/local/bin:$PATH"\n';
    const absent = shellRoot(join(base, 'no-zsh'), ['bash']);
    writeFileSync(zshrc, block);
    const emptied = runManager(base, root, [], {
      SHELL: '/bin/bash',
      CIRCLE_SHELL_ROOT: absent,
    });
    assert.equal(emptied.status, 0, emptied.stderr + emptied.stdout);
    assert.equal(existsSync(zshrc), false);
    assert.match(emptied.stdout, /removed .*zshrc/);
    writeFileSync(
      zshrc,
      'export EDITOR=vi\n\n# circle path\nexport PATH="/usr/local/bin:$PATH"\n',
    );
    const trimmed = runManager(base, root, [], {
      SHELL: '/bin/bash',
      CIRCLE_SHELL_ROOT: absent,
    });
    assert.equal(trimmed.status, 0, trimmed.stderr + trimmed.stdout);
    assert.equal(readFileSync(zshrc, 'utf8'), 'export EDITOR=vi\n');
    // The same file stays when the probe can see zsh, including on a Mac where
    // /bin/zsh is real. The probe root is the only place that counts.
    const present = shellRoot(join(base, 'with-zsh'), ['bash', 'zsh']);
    writeFileSync(zshrc, block);
    const kept = runManager(base, root, [], {
      SHELL: '/bin/bash',
      CIRCLE_SHELL_ROOT: present,
    });
    assert.equal(kept.status, 0, kept.stderr + kept.stdout);
    assert.equal(readFileSync(zshrc, 'utf8'), block);
    assert.equal(/removed .*zshrc/.test(kept.stdout), false);
  },
);

test('installing keeps the newest three versions and the one it replaces', (t) => {
  const base = scratch(t);
  const prefix = join(base, 'prefix');
  for (const version of ['0.9.0', '1.0.0', '1.0.1', '1.0.2', '1.1.0']) {
    mkdirSync(join(prefix, 'versions', version), { recursive: true });
    writeFileSync(join(prefix, 'versions', version, 'release.json'), '{}');
  }
  // A folder that is not one of ours stays.
  mkdirSync(join(prefix, 'versions', 'notes'));
  assert.deepEqual(pruneVersions(prefix, ['1.1.0', '0.9.0']).sort(), ['1.0.0']);
  assert.deepEqual(readdirSync(join(prefix, 'versions')).sort(), [
    '0.9.0',
    '1.0.1',
    '1.0.2',
    '1.1.0',
    'notes',
  ]);
});
