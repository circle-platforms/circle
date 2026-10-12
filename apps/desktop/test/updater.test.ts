import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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
  assert.equal(msi?.target, 'C:\\Program Files\\Circle');
  // Only the .msi is released for Windows: a copy elsewhere is updated by hand. No package
  // for the others, and Linux's sandbox helper must stay root's
  assert.equal(
    installation(
      'win32',
      'x64',
      'D:\\tools\\Circle-win32-x64\\Circle.exe',
      'C:\\Program Files',
    ),
    undefined,
  );
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
const sha = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
// A program that notes how it was started, in `marker`: what the installer starts again, or
// on Windows a stand-in for msiexec.
function recorder(path: string, marker: string): string {
  if (windows) {
    writeFileSync(`${path}.cmd`, `@echo %* > "${marker}"\r\n@exit /b 0\r\n`);
    return `${path}.cmd`;
  }
  writeFileSync(path, `#!/bin/sh\necho "$@" > "${marker}"\n`, { mode: 0o755 });
  return path;
}
const INSTALLER = 'circle-desktop-1.1.0-windows-x64.msi';
const msiInstallation = (root: string): Installation => {
  const target = join(root, 'Program Files', 'Circle');
  mkdirSync(target, { recursive: true });
  return {
    kind: 'msi',
    target,
    executable: recorder(join(target, 'Circle'), join(root, 'started')),
    asset: (version) => `circle-desktop-${version}-windows-x64.msi`,
  };
};

test('an update is checked, downloaded, checked against its checksum, handed to the installer and reported', async (t) => {
  const root = scratch(t);
  const found = msiInstallation(root);
  const msi = 'an installer package';
  const releases = await release(t, '1.1.0', {
    [INSTALLER]: msi,
    [`${INSTALLER}.sha256`]: `${sha(msi)}  ${INSTALLER}\n`,
  });
  const home = join(root, 'home');
  const folder = join(root, 'data', 'updates');
  const launched: [string, string[]][] = [];
  let quit = 0;
  const options = {
    version: '1.0.0',
    home,
    folder,
    installation: found,
    releases,
    launch: (command: string, args: string[]) => {
      launched.push([command, args]);
    },
    quit: () => quit++,
    args: ['--remote-debugging-port=9555'],
    pid: 1,
    platform: 'win32',
    msiexec: recorder(join(root, 'msiexec'), join(root, 'msiexec-ran')),
  };
  const updater = new Updater(options);
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
  assert.equal(readFileSync(ready.staged, 'utf8'), msi);

  // A restart still finds the download
  const again = new Updater(options);
  assert.deepEqual(await again.start(), { phase: 'ready', version: '1.1.0' });
  assert.deepEqual(await again.install(), {
    phase: 'installing',
    version: '1.1.0',
  });
  assert.equal(quit, 1);
  const [command, args] = launched[0];
  assert.equal(command, 'powershell.exe');
  assert.equal(args.at(-1), '-Start');
  assert.deepEqual(
    JSON.parse(readFileSync(join(folder, 'pending.json'), 'utf8')),
    { version: '1.1.0', from: '1.0.0' },
  );
  const plan = JSON.parse(readFileSync(args.at(-2)!, 'utf8'));
  assert.equal(plan.staged, ready.staged);
  assert.equal(plan.target, found.target);
  assert.deepEqual(plan.args, ['--remote-debugging-port=9555']);

  if (windows) {
    // As Circle does: the installer starts itself again on its own and returns at once; that
    // copy waits for Circle, runs the package and starts Circle again
    plan.pid = 2 ** 30;
    writeFileSync(args.at(-2)!, JSON.stringify(plan));
    assert.equal(spawnSync(command, args, { stdio: 'inherit' }).status, 0);
    await until(() => existsSync(join(root, 'started')));
    assert.match(
      readFileSync(join(root, 'msiexec-ran'), 'utf8'),
      /\/i ".+circle-desktop-1\.1\.0-windows-x64\.msi" \/passive \/norestart/,
    );
    assert.match(
      readFileSync(join(root, 'started'), 'utf8'),
      /--remote-debugging-port=9555/,
    );
    assert.match(
      readFileSync(join(folder, 'install.log'), 'utf8'),
      /installed/,
    );
  }

  // The new version starts, sees that it is the one asked for and clears the download
  const after = new Updater({ ...options, version: '1.1.0' });
  assert.deepEqual(await after.start(), {
    phase: 'current',
    updated: '1.1.0',
  });
  // Only the installer's log stays, until the next update
  assert.deepEqual(readdirSync(folder), windows ? ['install.log'] : []);
  assert.deepEqual(await after.check(), { phase: 'current' });
});

test(
  'the macOS installer puts the new bundle in place of the old one and starts it',
  {
    skip: windows,
  },
  async (t) => {
    const root = scratch(t);
    const bundle = (parent: string, version: string) => {
      const app = join(parent, 'Circle.app');
      mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
      writeFileSync(join(app, 'Contents', 'VERSION'), version);
      recorder(join(app, 'Contents', 'MacOS', 'Circle'), join(root, 'started'));
      return app;
    };
    const installed = bundle(join(root, 'Applications'), '1.0.0');
    const folder = join(root, 'updates');
    const staged = bundle(join(folder, '1.1.0'), '1.1.0');
    writeFileSync(
      join(folder, 'ready.json'),
      JSON.stringify({ version: '1.1.0', staged }),
    );
    const launched: [string, string[]][] = [];
    const updater = new Updater({
      version: '1.0.0',
      home: join(root, 'home'),
      folder,
      installation: {
        kind: 'bundle',
        target: installed,
        executable: join(installed, 'Contents', 'MacOS', 'Circle'),
        asset: (version) => `circle-desktop-${version}-darwin-arm64.dmg`,
      },
      releases: 'http://127.0.0.1:9/releases',
      launch: (command, args) => {
        launched.push([command, args]);
      },
      quit: () => {},
      args: ['--remote-debugging-port=9555'],
      platform: 'darwin',
    });
    assert.deepEqual(await updater.start(), {
      phase: 'ready',
      version: '1.1.0',
    });
    await updater.install();
    const [command, args] = launched[0];
    assert.equal(command, '/bin/sh');
    args[1] = String(2 ** 22 + 12345); // a process that has ended
    spawn(command, args, { stdio: 'inherit' });
    await until(() => existsSync(join(root, 'started')));
    assert.match(
      readFileSync(join(root, 'started'), 'utf8'),
      /--remote-debugging-port=9555/,
    );
    assert.equal(
      readFileSync(join(installed, 'Contents', 'VERSION'), 'utf8'),
      '1.1.0',
    );
    assert.deepEqual(readdirSync(join(root, 'Applications')), ['Circle.app']);
    assert.equal(existsSync(staged), false);
    assert.match(
      readFileSync(join(folder, 'install.log'), 'utf8'),
      /installed/,
    );
  },
);

test('a download that does not match its checksum is not installed', async (t) => {
  const root = scratch(t);
  const releases = await release(t, '1.1.0', {
    [INSTALLER]: 'an installer package',
    [`${INSTALLER}.sha256`]: `${'0'.repeat(64)}  ${INSTALLER}\n`,
  });
  const updater = new Updater({
    version: '1.0.0',
    home: join(root, 'home'),
    folder: join(root, 'updates'),
    installation: msiInstallation(root),
    releases,
    launch: () => assert.fail('nothing to install'),
    quit: () => assert.fail('nothing to install'),
  });
  await updater.check();
  const failed = await updater.download();
  assert.equal(failed.phase, 'failed');
  assert.match(
    (failed as { error: string }).error,
    /does not match its checksum/,
  );
  assert.equal(existsSync(join(root, 'updates')), false);
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
    'Mon installing\nMon failed: msiexec exited with 1602\nMon starting Circle\n',
  );
  const state = await manual.start();
  assert.equal(state.phase, 'failed');
  assert.equal(
    (state as { error: string }).error,
    'Circle 2.0.0 was not installed: msiexec exited with 1602',
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

test('an installer that does not start leaves the application running and says so', async (t) => {
  const root = scratch(t);
  const folder = join(root, 'updates');
  mkdirSync(join(folder, '1.1.0'), { recursive: true });
  writeFileSync(join(folder, '1.1.0', INSTALLER), 'an installer package');
  writeFileSync(
    join(folder, 'ready.json'),
    JSON.stringify({
      version: '1.1.0',
      staged: join(folder, '1.1.0', INSTALLER),
    }),
  );
  let quit = 0;
  const updater = new Updater({
    version: '1.0.0',
    home: join(root, 'home'),
    folder,
    installation: msiInstallation(root),
    releases: 'http://127.0.0.1:9/releases',
    launch: async () => {
      throw Error('no PowerShell');
    },
    quit: () => quit++,
  });
  assert.equal((await updater.start()).phase, 'ready');
  assert.deepEqual(await updater.install(), {
    phase: 'failed',
    version: '1.1.0',
    error: 'the installer did not start: no PowerShell',
  });
  assert.equal(quit, 0);
  assert.equal(existsSync(join(folder, 'pending.json')), false);
});
