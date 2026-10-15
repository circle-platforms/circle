import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isolatedJourneyPath,
  journeyShellInput,
} from './helpers/native-journey-platform.mjs';
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
