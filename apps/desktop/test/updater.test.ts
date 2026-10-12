import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checksumFor,
  installation,
  releasesUrl,
  systemTar,
  Updater,
  type Installation,
} from '../src/updater';

const windows = process.platform === 'win32';
const scratch = (t: { after: (fn: () => void) => void }) => {
  const folder = mkdtempSync(join(tmpdir(), 'circle-updater-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
};
const until = async (done: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test('an installation is found from where the application runs', () => {
  const mac = installation(
    'darwin',
    'arm64',
    '/Applications/Circle.app/Contents/MacOS/Circle',
  );
  assert.equal(mac?.kind, 'bundle');
  assert.equal(mac?.target, '/Applications/Circle.app');
  assert.equal(mac?.asset('1.3.0'), 'circle-desktop-1.3.0-darwin-arm64.dmg');
  assert.equal(
    installation('darwin', 'x64', '/opt/electron/Electron'),
    undefined,
  );
  const msi = installation(
    'win32',
    'x64',
    'C:\\Program Files\\Circle\\Circle.exe',
    'C:\\Program Files',
  );
  assert.equal(msi?.kind, 'msi');
  assert.equal(msi?.asset('1.3.0'), 'circle-desktop-1.3.0-windows-x64.msi');
  const zip = installation(
    'win32',
    'x64',
    'D:\\tools\\Circle-win32-x64\\Circle.exe',
    'C:\\Program Files',
  );
  assert.equal(zip?.kind, 'folder');
  assert.equal(zip?.target, 'D:\\tools\\Circle-win32-x64');
  assert.equal(zip?.asset('1.3.0'), 'circle-desktop-1.3.0-windows-x64.zip');
  // No package for these, and Linux's sandbox helper must stay root's
  assert.equal(
    installation('win32', 'arm64', 'C:\\Circle\\Circle.exe'),
    undefined,
  );
  assert.equal(
    installation('linux', 'x64', '/opt/Circle-linux-x64/Circle'),
    undefined,
  );
});

test('releases come from GitHub unless a local or https copy is named', () => {
  assert.equal(
    releasesUrl(''),
    'https://github.com/qingshanfeihu/circle/releases',
  );
  assert.equal(
    releasesUrl('http://127.0.0.1:4000/releases/'),
    'http://127.0.0.1:4000/releases',
  );
  assert.throws(() => releasesUrl('http://example.com/releases'), /https/);
});

test('a checksum file gives the hash for its file', () => {
  const hash = 'ab'.repeat(32);
  assert.equal(
    checksumFor(
      `${hash}  circle-desktop-1.0.0.dmg\n`,
      'circle-desktop-1.0.0.dmg',
    ),
    hash,
  );
  assert.equal(checksumFor(`${hash.toUpperCase()}\n`, 'x'), hash);
  assert.throws(() => checksumFor('nothing here', 'x'), /no checksum/);
});

// A release on a local server: /releases/latest redirects to the tag, and the tag's files
// are under /releases/download/v<version>/.
async function release(
  t: { after: (fn: () => void) => void },
  version: string,
  files: Record<string, Buffer | string>,
): Promise<string> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    if (path === '/releases/latest') {
      res.writeHead(302, { Location: `/releases/tag/v${version}` }).end();
    } else if (path === `/releases/tag/v${version}`) {
      res.writeHead(200).end();
    } else {
      const name = path.replace(`/releases/download/v${version}/`, '');
      const body = files[name];
      if (body === undefined) res.writeHead(404).end();
      else
        res
          .writeHead(200, { 'Content-Length': Buffer.byteLength(body) })
          .end(body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/releases`;
}
// An installed folder, as the .zip unpacks: the program, its archive's package.json and a
// file that says which version it is. The program notes in `<root>/started` how it was started.
function folderApp(parent: string, version: string, root: string): string {
  const folder = join(parent, 'Circle-test');
  mkdirSync(join(folder, 'resources/app.asar'), { recursive: true });
  writeFileSync(
    join(folder, 'resources/app.asar/package.json'),
    JSON.stringify({ name: 'circle', version }),
  );
  writeFileSync(join(folder, 'VERSION'), version);
  const marker = join(root, 'started');
  if (windows)
    writeFileSync(join(folder, 'run.cmd'), `@echo %* > "${marker}"\r\n`);
  else {
    writeFileSync(
      join(folder, 'run.sh'),
      `#!/bin/sh\necho "$@" > "${marker}"\n`,
      {
        mode: 0o755,
      },
    );
  }
  return folder;
}
function archive(root: string, version: string): Buffer {
  const source = join(root, 'source');
  rmSync(source, { recursive: true, force: true });
  mkdirSync(source);
  folderApp(source, version, root);
  const file = join(root, 'package.tar.gz');
  execFileSync(systemTar(), ['-czf', file, '-C', source, 'Circle-test']);
  return readFileSync(file);
}
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

test('an update is checked, downloaded, installed over the old folder and reported', async (t) => {
  const root = scratch(t);
  const installed = folderApp(join(root, 'apps'), '1.0.0', root);
  const found: Installation = {
    kind: 'folder',
    target: installed,
    executable: join(installed, windows ? 'run.cmd' : 'run.sh'),
    asset: (version) => `circle-desktop-${version}-test.tar.gz`,
  };
  const good = archive(root, '1.1.0');
  const releases = await release(t, '1.1.0', {
    'circle-desktop-1.1.0-test.tar.gz': good,
    'circle-desktop-1.1.0-test.tar.gz.sha256': `${sha(good)}  circle-desktop-1.1.0-test.tar.gz\n`,
  });
  const home = join(root, 'home');
  const folder = join(root, 'data', 'updates');
  const launched: [string, string[]][] = [];
  let quit = 0;
  const updater = new Updater({
    version: '1.0.0',
    home,
    folder,
    installation: found,
    releases,
    launch: (command, args) => launched.push([command, args]),
    quit: () => quit++,
    args: ['--remote-debugging-port=9555'],
    pid: 1,
  });
  const seen: string[] = [];
  updater.subscribe((state) => seen.push(state.phase));

  assert.deepEqual(await updater.check(), {
    phase: 'available',
    version: '1.1.0',
  });
  // The daily check does not ask again today
  assert.equal(
    JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8')).latest,
    '1.1.0',
  );
  assert.deepEqual(await updater.download(), {
    phase: 'ready',
    version: '1.1.0',
  });
  assert.ok(seen.includes('checking') && seen.includes('downloading'));
  const ready = JSON.parse(readFileSync(join(folder, 'ready.json'), 'utf8'));
  assert.equal(readFileSync(join(ready.staged, 'VERSION'), 'utf8'), '1.1.0');

  // A restart still finds the download
  const again = new Updater({
    version: '1.0.0',
    home,
    folder,
    installation: found,
    releases,
    launch: (command, args) => launched.push([command, args]),
    quit: () => quit++,
    args: ['--remote-debugging-port=9555'],
    pid: 1,
  });
  assert.deepEqual(await again.start(), { phase: 'ready', version: '1.1.0' });

  assert.deepEqual(await again.install(), {
    phase: 'installing',
    version: '1.1.0',
  });
  assert.equal(quit, 1);
  assert.equal(launched.length, 1);
  const [command, args] = launched[0];
  assert.deepEqual(
    JSON.parse(readFileSync(join(folder, 'pending.json'), 'utf8')),
    { version: '1.1.0', from: '1.0.0' },
  );

  // Run the installer as the application would, for a process that has already ended
  const ended = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(ended.status, 0);
  if (windows) {
    const plan = args.at(-1)!;
    const value = JSON.parse(readFileSync(plan, 'utf8'));
    assert.equal(value.kind, 'folder');
    assert.equal(value.target, installed);
    assert.deepEqual(value.args, ['--remote-debugging-port=9555']);
    value.pid = 2 ** 30;
    writeFileSync(plan, JSON.stringify(value));
    assert.equal(command, 'powershell.exe');
    spawnSync(command, args, { stdio: 'inherit' });
  } else {
    assert.equal(command, '/bin/sh');
    args[1] = String(2 ** 22 + 12345); // no such process
    spawn(command, args, { stdio: 'inherit' });
  }
  await until(() => existsSync(join(root, 'started')));
  assert.match(
    readFileSync(join(root, 'started'), 'utf8'),
    /--remote-debugging-port=9555/,
  );
  assert.equal(readFileSync(join(installed, 'VERSION'), 'utf8'), '1.1.0');
  assert.deepEqual(readdirSync(join(root, 'apps')), ['Circle-test']);
  assert.match(readFileSync(join(folder, 'install.log'), 'utf8'), /installed/);

  // The new version starts, sees that it is the one asked for and clears the folder
  const after = new Updater({
    version: '1.1.0',
    home,
    folder,
    installation: found,
    releases,
    launch: () => assert.fail('nothing to install'),
    quit: () => assert.fail('nothing to install'),
  });
  assert.deepEqual(await after.start(), { phase: 'current', updated: '1.1.0' });
  assert.equal(existsSync(folder), false);
  assert.deepEqual(await after.check(), { phase: 'current' });
});

test('a download that does not match its checksum or version is not installed', async (t) => {
  const root = scratch(t);
  const installed = folderApp(join(root, 'apps'), '1.0.0', root);
  const found: Installation = {
    kind: 'folder',
    target: installed,
    executable: join(installed, windows ? 'run.cmd' : 'run.sh'),
    asset: (version) => `circle-desktop-${version}-test.tar.gz`,
  };
  const wrong = archive(root, '1.0.5');
  const options = (releases: string) => ({
    version: '1.0.0',
    home: join(root, 'home'),
    folder: join(root, 'updates'),
    installation: found,
    releases,
    launch: () => assert.fail('nothing to install'),
    quit: () => assert.fail('nothing to install'),
  });
  const corrupt = new Updater(
    options(
      await release(t, '1.1.0', {
        'circle-desktop-1.1.0-test.tar.gz': wrong,
        'circle-desktop-1.1.0-test.tar.gz.sha256': `${'0'.repeat(64)}  circle-desktop-1.1.0-test.tar.gz\n`,
      }),
    ),
  );
  await corrupt.check();
  const failed = await corrupt.download();
  assert.equal(failed.phase, 'failed');
  assert.match(
    (failed as { error: string }).error,
    /does not match its checksum/,
  );
  assert.equal(existsSync(join(root, 'updates')), false);

  const mislabelled = new Updater(
    options(
      await release(t, '1.1.0', {
        'circle-desktop-1.1.0-test.tar.gz': wrong,
        'circle-desktop-1.1.0-test.tar.gz.sha256': sha(wrong),
      }),
    ),
  );
  await mislabelled.check();
  const other = await mislabelled.download();
  assert.match(
    (other as { error: string }).error,
    /does not hold Circle 1\.1\.0/,
  );
  assert.equal(readFileSync(join(installed, 'VERSION'), 'utf8'), '1.0.0');
});

test('a copy that cannot replace itself points to the release page, and an update that did not go in says so', async (t) => {
  const root = scratch(t);
  const releases = await release(t, '2.0.0', {});
  const manual = new Updater({
    version: '1.0.0',
    home: join(root, 'home'),
    folder: join(root, 'updates'),
    releases,
    launch: () => assert.fail('nothing to install'),
    quit: () => assert.fail('nothing to install'),
  });
  assert.deepEqual(await manual.check(), {
    phase: 'available',
    version: '2.0.0',
    page: `${releases}/tag/v2.0.0`,
  });
  assert.deepEqual(await manual.download(), manual.state);

  mkdirSync(join(root, 'updates'), { recursive: true });
  writeFileSync(
    join(root, 'updates', 'pending.json'),
    JSON.stringify({ version: '2.0.0', from: '1.0.0' }),
  );
  writeFileSync(
    join(root, 'updates', 'install.log'),
    'Mon installing\nMon failed: the new copy could not be written beside the old one\n',
  );
  const state = await manual.start();
  assert.equal(state.phase, 'failed');
  assert.equal(
    (state as { error: string }).error,
    'Circle 2.0.0 was not installed: the new copy could not be written beside the old one',
  );

  // Offline: a check now says why; the daily check says nothing
  const offline = new Updater({
    version: '1.0.0',
    home: join(root, 'home2'),
    folder: join(root, 'updates2'),
    releases: 'http://127.0.0.1:9/releases',
    launch: () => {},
    quit: () => {},
  });
  assert.deepEqual(await offline.check(false), { phase: 'idle' });
  assert.equal((await offline.check()).phase, 'failed');
});
