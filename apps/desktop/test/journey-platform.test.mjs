import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { expectedSessionChanges } from './helpers/native-changes-oracle.mjs';
import {
  isolatedJourneyPath,
  journeyShellInput,
  journeyBundledNodePath,
  journeyNodeCommand,
} from './helpers/native-journey-platform.mjs';
test('session changes include restored edits as well as Git changes', () => {
  const workspace = join(process.cwd(), 'fixture-workspace');
  assert.deepEqual(
    expectedSessionChanges(
      [
        ['external.txt', 'A'],
        ['shared.txt', 'M'],
      ],
      [
        { path: join(workspace, 'restored.md'), kind: 'modified' },
        { path: join(workspace, 'shared.txt'), kind: 'deleted' },
      ],
      workspace,
    ),
    [
      ['external.txt', 'A'],
      ['restored.md', 'M'],
      ['shared.txt', 'D'],
    ],
  );
  assert.deepEqual(
    expectedSessionChanges([['external.txt', 'A']], [], workspace),
    [['external.txt', 'A']],
  );
});
test('Windows journey only grants system commands and Git directory, excluding host Node', async () => {
  const result = await isolatedJourneyPath({
    platform: 'win32',
    environment: {
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\host-node;C:\\Users\\personal',
    },
    findGit: async () => 'C:\\Program Files\\Git\\cmd\\git.exe\r\n',
  });
  assert.equal(result, 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd');
  await assert.rejects(
    isolatedJourneyPath({
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      findGit: async () => '',
    }),
    /runner Git/,
  );
});
test('PTY input respects cmd.exe expansion and Unix read semantics', () => {
  assert.deepEqual(journeyShellInput('win32'), [
    'set /p answer=JOURNEY_INPUT? \r',
    'native-input\r',
    'echo JOURNEY_ECHO:%answer%\r',
  ]);
  assert.match(journeyShellInput('linux')[0], /read answer/);
  assert.equal(journeyShellInput('linux')[1], 'native-input\n');
});

test('performance producer uses explicit bundled Node and platform-specific shell quoting', () => {
  const windows = journeyBundledNodePath({
    desktopRoot: 'C:\\source',
    applicationPath: 'C:\\Circle',
    platform: 'win32',
  });
  assert.equal(
    windows,
    'C:\\Circle\\resources\\app.asar.unpacked\\dist\\tools\\node\\bin\\node.exe',
  );
  assert.equal(
    journeyNodeCommand(windows, 'C:\\fixture space\\producer.cjs', 'win32'),
    `"${windows}" "C:\\fixture space\\producer.cjs"\r`,
  );
  assert.throws(
    () =>
      journeyNodeCommand('C:\\%HOSTNODE%\\node.exe', 'fixture.cjs', 'win32'),
    /expansion characters/,
  );
  const unix = journeyBundledNodePath({
    desktopRoot: '/source',
    platform: 'linux',
  });
  assert.equal(unix, '/source/dist/tools/node/bin/node');
  assert.equal(
    journeyNodeCommand(unix, "/tmp/a'b.cjs", 'linux'),
    "'/source/dist/tools/node/bin/node' '/tmp/a'\\''b.cjs'\r",
  );
});
