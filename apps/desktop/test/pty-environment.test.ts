import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ptyEnvironment } from '../src/workspace/pty-environment.ts';

const exec = promisify(execFile);

test('Windows launch layers replace case aliases and leave one trusted PATH', () => {
  const inherited = {
    Path: 'host-node',
    SYSTEMROOT: 'C:\\Windows',
    NODE_OPTIONS: '--inspect',
  };
  const manager = {
    PATH: 'bundled-node',
    node_options: '--enable-source-maps',
  };
  const env = ptyEnvironment('win32', inherited, manager, {
    pAtH: 'launch-node',
    NODE_OPTIONS: '--no-warnings',
  });
  assert.deepEqual(env, {
    PATH: 'launch-node',
    SYSTEMROOT: 'C:\\Windows',
    NODE_OPTIONS: '--no-warnings',
  });
  assert.equal(inherited.Path, 'host-node');
  assert.equal(manager.PATH, 'bundled-node');
  assert.deepEqual(
    ptyEnvironment('win32', inherited, manager, {
      path: null,
      node_OPTIONS: null,
    }),
    { SYSTEMROOT: 'C:\\Windows' },
  );
});

test('POSIX launch layers retain case-sensitive keys and precise deletions', () => {
  assert.deepEqual(
    ptyEnvironment(
      'linux',
      { PATH: 'upper', Path: 'mixed', KEEP: 'yes' },
      { PATH: 'bundled' },
      { Path: null },
    ),
    { PATH: 'bundled', KEEP: 'yes' },
  );
  assert.deepEqual(ptyEnvironment('darwin', { A: 'a' }, { A: undefined }), {});
});

test('a real child receives merged values, debug options and literal argv', async () => {
  const env = ptyEnvironment(
    process.platform,
    process.env,
    { CIRCLE_ENV_PROBE: 'manager', NODE_OPTIONS: '--no-warnings' },
    { CIRCLE_ENV_PROBE: 'launch', CIRCLE_DELETE_PROBE: null },
  );
  const argument = 'spaces & dollar $ and unicode 中文';
  const result = await exec(
    process.execPath,
    [
      '-e',
      'console.log(JSON.stringify({value:process.env.CIRCLE_ENV_PROBE,options:process.env.NODE_OPTIONS,deleted:process.env.CIRCLE_DELETE_PROBE??null,arg:process.argv[1]}))',
      argument,
    ],
    { env },
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    value: 'launch',
    options: '--no-warnings',
    deleted: null,
    arg: argument,
  });
});
