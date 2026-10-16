import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BETA, RELEASE, channelOf } from '../src/channel.ts';

const desktop = fileURLToPath(new URL('..', import.meta.url));

test('only a package.json that says beta makes a beta; anything else is the release', () => {
  assert.equal(channelOf({ name: 'circle', channel: 'beta' }), BETA);
  for (const manifest of [
    undefined,
    null,
    'beta',
    {},
    { name: 'circle' },
    { channel: 'Beta' },
    { channel: 'release' },
    { channel: true },
  ])
    assert.equal(channelOf(manifest), RELEASE, JSON.stringify(manifest));
});

test('the beta has a name, an id and a data folder of its own, and the release keeps its own', () => {
  assert.deepEqual(RELEASE, {
    beta: false,
    name: 'Circle',
    id: 'com.qingshanfeihu.circle',
    folder: 'Circle',
  });
  assert.deepEqual(BETA, {
    beta: true,
    name: 'Circle (beta)',
    id: 'com.qingshanfeihu.circle.beta',
    folder: 'Circle (beta)',
  });
});

test('package:beta packages the beta, which neither updates itself nor shares the data folder', async () => {
  const manifest = JSON.parse(
    await readFile(join(desktop, 'package.json'), 'utf8'),
  );
  assert.equal(
    manifest.scripts['package:beta'],
    'npm run build && node scripts/package.mjs --beta',
  );
  const script = await readFile(join(desktop, 'scripts/package.mjs'), 'utf8');
  assert.match(script, /process\.argv\.includes\('--beta'\) \? BETA : RELEASE/);
  // The packaged package.json is what the application reads its channel from
  assert.match(
    script,
    /\.\.\.\(channel\.beta \? \{ channel: 'beta' \} : \{\}\)/,
  );
  assert.match(script, /name: channel\.name,/);
  assert.match(
    script,
    /writeFile\(join\(path, 'CIRCLE_VERSION'\), `\$\{version\}\\n`\)/,
  );
  const main = await readFile(join(desktop, 'src/main.ts'), 'utf8');
  assert.match(main, /app\.setName\(channel\.name\)/);
  assert.match(main, /join\(app\.getPath\('appData'\), channel\.folder\)/);
  assert.match(main, /app\.isPackaged && !channel\.beta/);
});
