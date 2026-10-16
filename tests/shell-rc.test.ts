import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shellStartupFile } from '../src/shell_rc.js';

const exists =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

test('the installer writes the rc of an installed bash or zsh only', () => {
  assert.deepEqual(
    shellStartupFile({
      home: '/home/me',
      env: { SHELL: '/bin/bash' },
      exists: exists('/bin/bash'),
    }),
    { file: '/home/me/.bashrc', family: 'bash' },
  );
  assert.deepEqual(
    shellStartupFile({
      home: '/home/me',
      env: { SHELL: '/bin/zsh' },
      exists: exists('/bin/zsh'),
    }),
    { file: '/home/me/.zshrc', family: 'zsh' },
  );
  // $SHELL names a shell that is not installed. $BASH is, so bash wins.
  assert.deepEqual(
    shellStartupFile({
      home: '/home/me',
      env: { SHELL: '/no/such/zsh', BASH: '/bin/bash' },
      exists: exists('/bin/bash'),
    }),
    { file: '/home/me/.bashrc', family: 'bash' },
  );
  // Neither $SHELL nor $BASH is installed. The login shell is.
  assert.deepEqual(
    shellStartupFile({
      home: '/home/me',
      env: { SHELL: '/usr/bin/zsh' },
      exists: exists('/bin/bash'),
      loginShell: '/bin/bash',
    }),
    { file: '/home/me/.bashrc', family: 'bash' },
  );
  assert.equal(
    shellStartupFile({
      home: '/home/me',
      env: { SHELL: '/bin/fish', BASH: '/no/bash' },
      exists: exists('/bin/fish'),
      loginShell: '/usr/bin/fish',
    }),
    undefined,
  );
  assert.equal(
    shellStartupFile({
      home: '/home/me',
      env: { SHELL: 'zsh' },
      exists: exists('/usr/bin/zsh'),
    })?.file,
    '/home/me/.zshrc',
  );
});
