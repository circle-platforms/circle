import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
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
  LINUX_INSTALLER,
  releasesUrl,
  sandboxIsSetuid,
  Updater,
  WINDOWS_INSTALLER,
  type Installation,
} from '../src/updater';
import { circleAppVersion } from '../src/circle-version';
import { VERSION } from '../../../src/version';

const windows = process.platform === 'win32';
const scratch = (t: { after: (fn: () => void) => void }) => {
  const folder = mkdtempSync(join(tmpdir(), 'circle-updater-'));
  // On Windows the installer's own hidden copy can hold its output files while it exits
  t.after(() =>
    rmSync(folder, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    }),
  );
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
  // Only the .msi is released for Windows: a copy elsewhere is updated by hand.
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
  const linux = installation('linux', 'x64', '/opt/Circle-linux-x64/Circle');
  assert.equal(linux?.kind, 'linux');
  assert.equal(linux?.target, '/opt/Circle-linux-x64');
  assert.equal(linux?.asset('1.7.4'), 'circle-desktop-1.7.4-linux-x64.tar.gz');
  assert.equal(
    installation('linux', 'arm64', '/opt/Circle-linux-arm64/Circle')?.asset(
      '1.7.4',
    ),
    'circle-desktop-1.7.4-linux-arm64.tar.gz',
  );
  assert.equal(installation('linux', 'ia32', '/opt/Circle/Circle'), undefined);
  assert.equal(installation('linux', 'x64', '/Circle'), undefined);
});

test('releases come from GitHub unless a local or https copy is named', () => {
  assert.equal(
    releasesUrl(''),
    'https://github.com/circle-platforms/circle/releases',
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
  'the Windows installer preserves the relaunched argv through real PowerShell',
  { skip: !windows },
  async (t) => {
    const root = scratch(t);
    const folder = join(root, 'updates');
    const target = join(root, 'owned-empty-app');
    mkdirSync(folder);
    mkdirSync(target);
    const staged = join(folder, INSTALLER);
    writeFileSync(staged, 'a stand-in package; never passed to native msiexec');
    writeFileSync(
      join(folder, 'ready.json'),
      JSON.stringify({ version: '1.1.0', staged }),
    );
    const marker = join(root, 'argv.json');
    const script = join(root, 'argument recorder.cjs');
    writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const expected = [
      '--fixture-path',
      'C:\\sample\\directory with spaces',
      '--label',
      'literal "quoted" marker',
      '',
      'one\targument',
      'C:\\space at end\\',
      'C:\\space at end' + '\\'.repeat(2),
      'one backslash before a quote: ' + '\\' + '"',
      'two backslashes before a quote: ' + '\\'.repeat(2) + '"',
      'three backslashes before a quote: ' + '\\'.repeat(3) + '"',
      'two adjacent quotes: ""',
      'plain\\path',
      '临时 工作区\\',
      '$() & | ^ %UNCHANGED%',
    ];
    let quits = 0;
    const updater = new Updater({
      version: '1.0.0',
      home: join(root, 'home'),
      folder,
      installation: {
        kind: 'msi',
        target,
        executable: process.execPath,
        asset: (version) => `circle-desktop-${version}-windows-x64.msi`,
      },
      platform: 'win32',
      pid: 2 ** 30,
      msiexec: recorder(join(root, 'synthetic-msiexec'), join(root, 'msi-ran')),
      args: [script, ...expected],
      launch: (command, args) => {
        // A console recorder stands in for the graphical app. Keep all test children hidden;
        // argument handling and the complete updater script still execute unchanged.
        const installer = args[args.indexOf('-File') + 1]!;
        assert.equal(readFileSync(installer, 'utf8'), WINDOWS_INSTALLER);
        writeFileSync(
          installer,
          WINDOWS_INSTALLER.replace(
            "$ErrorActionPreference = 'Stop'",
            `$ErrorActionPreference = 'Stop'
function Start-Process {
  [CmdletBinding()]
  param([Parameter(Position=0)][string]$FilePath, [string]$WorkingDirectory,
    [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru,
    [string]$RedirectStandardOutput, [string]$RedirectStandardError, [string]$WindowStyle)
  $PSBoundParameters['WindowStyle'] = 'Hidden'
  Microsoft.PowerShell.Management\\Start-Process @PSBoundParameters
}`,
          ),
        );
        const launched = spawnSync(command, args, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15000,
        });
        assert.equal(
          launched.status,
          0,
          launched.stderr || launched.error?.message,
        );
      },
      quit: () => quits++,
    });
    assert.equal((await updater.start()).phase, 'ready');
    assert.equal((await updater.install()).phase, 'installing');
    assert.equal(quits, 1);
    await until(() => existsSync(marker));
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), expected);
    assert.ok(existsSync(join(root, 'msi-ran')));
    assert.match(
      readFileSync(join(folder, 'install.log'), 'utf8'),
      /installed/,
    );
  },
);

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

test('a daily check that answers late does not take back a download the user started', async (t) => {
  const root = scratch(t);
  const msi = 'an installer package';
  const releases = await release(t, '1.1.0', {
    [INSTALLER]: msi,
    [`${INSTALLER}.sha256`]: `${sha(msi)}  ${INSTALLER}\n`,
  });
  // The daily check's question waits on the network; the user's check is answered at once
  let answerDaily: (version: string) => void = () => {};
  let asked = 0;
  const updater = new Updater({
    version: '1.0.0',
    home: join(root, 'home'),
    folder: join(root, 'updates'),
    installation: msiInstallation(root),
    releases,
    latest: () =>
      ++asked === 1
        ? new Promise<string>((resolve) => (answerDaily = resolve))
        : Promise.resolve('1.1.0'),
    launch: () => assert.fail('nothing to install'),
    quit: () => assert.fail('nothing to install'),
  });
  const seen: string[] = [];
  updater.subscribe((state) => seen.push(state.phase));
  const daily = updater.check(false);
  assert.deepEqual(await updater.check(), {
    phase: 'available',
    version: '1.1.0',
  });
  assert.deepEqual(await updater.download(), {
    phase: 'ready',
    version: '1.1.0',
  });
  answerDaily('1.1.0');
  assert.deepEqual(await daily, { phase: 'ready', version: '1.1.0' });
  assert.deepEqual(updater.state, { phase: 'ready', version: '1.1.0' });
  assert.equal(seen.at(-1), 'ready');
  assert.equal(asked, 2);
});

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

test('an installed update is reported while the installer still holds what it left', async (t) => {
  const root = scratch(t);
  const folder = join(root, 'updates');
  mkdirSync(folder);
  const leftovers = () => {
    writeFileSync(
      join(folder, 'pending.json'),
      JSON.stringify({ version: '1.1.0', from: '1.0.0' }),
    );
    writeFileSync(join(folder, 'install.json'), '{}');
    writeFileSync(join(folder, 'install.json.out'), '');
    writeFileSync(join(folder, 'install.json.err'), '');
    writeFileSync(join(folder, 'install.log'), 'Mon installed\n');
  };
  // As Windows answers while the installer's hidden PowerShell has not yet exited
  const busy = (path: string) =>
    Object.assign(Error(`EBUSY: resource busy or locked, unlink '${path}'`), {
      code: 'EBUSY',
    });
  const updater = (locked: (path: string, tries: number) => boolean) => {
    const tries = new Map<string, number>();
    return {
      tries,
      updater: new Updater({
        version: '1.1.0',
        home: join(root, 'home'),
        folder,
        launch: () => assert.fail('nothing to install'),
        quit: () => assert.fail('nothing to install'),
        remove: async (path) => {
          const count = (tries.get(path) ?? 0) + 1;
          tries.set(path, count);
          if (locked(path, count)) throw busy(path);
          rmSync(path, { recursive: true, force: true });
        },
      }),
    };
  };
  const err = join(folder, 'install.json.err');

  // Released after a moment: removed, and the update is reported
  leftovers();
  const brief = updater((path, tries) => path === err && tries < 3);
  assert.deepEqual(await brief.updater.start(), {
    phase: 'current',
    updated: '1.1.0',
  });
  assert.equal(brief.tries.get(err), 3);
  assert.deepEqual(readdirSync(folder), ['install.log']);

  // Never released: the rest goes, the update is still reported, and nothing else is
  // retried. Another error gives up at once.
  leftovers();
  const held = updater((path) => path === err);
  assert.deepEqual(await held.updater.start(), {
    phase: 'current',
    updated: '1.1.0',
  });
  assert.equal(held.tries.get(err), 12);
  assert.equal(held.tries.get(join(folder, 'pending.json')), 1);
  assert.deepEqual(readdirSync(folder).sort(), [
    'install.json.err',
    'install.log',
  ]);
  rmSync(err);

  leftovers();
  const denied = updater((path) => {
    if (path === err)
      throw Object.assign(Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
    return false;
  });
  assert.deepEqual(await denied.updater.start(), {
    phase: 'current',
    updated: '1.1.0',
  });
  assert.equal(denied.tries.get(err), 1);
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

function linuxArchive(
  root: string,
  version: string,
  versionFile = version,
  marker?: string,
): Buffer {
  const packed = join(root, `packed-${versionFile}`);
  const folder = join(packed, 'Circle-linux-x64');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'CIRCLE_VERSION'), `${versionFile}\n`);
  writeFileSync(
    join(folder, 'Circle'),
    marker ? `#!/bin/sh\necho "$@" > "${marker}"\n` : '#!/bin/sh\necho new\n',
    { mode: 0o755 },
  );
  writeFileSync(join(folder, 'chrome-sandbox'), '');
  const archive = join(root, `circle-desktop-${version}-linux-x64.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', packed, 'Circle-linux-x64']);
  return readFileSync(archive);
}

test("a checkout uses Circle's version, and an equal or newer local version is not offered", async (t) => {
  assert.equal(circleAppVersion(false, '0.1.0'), VERSION);
  assert.equal(circleAppVersion(true, '1.7.4'), '1.7.4');
  assert.equal(circleAppVersion(true, 'not-a-version'), VERSION);
  const root = scratch(t);
  const releases = await release(t, '1.7.4', {});
  const options = {
    home: join(root, 'home'),
    folder: join(root, 'updates'),
    releases,
    launch: () => {},
    quit: () => {},
  };
  assert.deepEqual(
    await new Updater({ ...options, version: '1.7.4' }).check(),
    {
      phase: 'current',
    },
  );
  assert.deepEqual(
    await new Updater({ ...options, version: '1.8.0' }).check(),
    {
      phase: 'current',
    },
  );
});

test('a writable Linux copy is checked, swapped, and does not restart while chrome-sandbox is setuid', async (t) => {
  const root = scratch(t);
  const version = '1.1.0';
  const asset = `circle-desktop-${version}-linux-x64.tar.gz`;
  const marker = join(root, 'started');
  const bytes = linuxArchive(root, version, version, marker);
  const releases = await release(t, version, {
    [asset]: bytes,
    [`${asset}.sha256`]: `${sha(bytes)}  ${asset}\n`,
  });
  const target = join(root, 'Circle-linux-x64');
  mkdirSync(target, { recursive: true });
  const executable = join(target, 'Circle');
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(target, 'chrome-sandbox'), '');
  chmodSync(join(target, 'chrome-sandbox'), 0o4755);
  // Windows does not store the setuid bit, so the flag below follows the real mode.
  const setuid = sandboxIsSetuid(target);
  if (!setuid) assert.equal(process.platform, 'win32');
  const folder = join(root, 'updates');
  const launched: [string, string[]][] = [];
  let quit = 0;
  const updater = new Updater({
    version: '1.0.0',
    home: join(root, 'home'),
    folder,
    installation: {
      kind: 'linux',
      target,
      executable,
      asset: (next) => `circle-desktop-${next}-linux-x64.tar.gz`,
    },
    releases,
    // The Linux installer is chosen from this, not from the machine running the test.
    platform: 'linux',
    launch: (command, args) => {
      launched.push([command, args]);
    },
    quit: () => quit++,
    pid: 1,
    args: ['--no-remote'],
  });
  const found = await updater.check();
  assert.equal(found.phase, 'available');
  assert.equal(found.phase === 'available' ? found.page : 'skipped', undefined);
  assert.deepEqual(found.phase === 'available' ? found.linux : undefined, {
    folder: target,
    sandbox: setuid,
  });
  assert.equal((await updater.download()).phase, 'ready');
  assert.equal(
    readFileSync(
      join(folder, version, 'app', 'Circle-linux-x64', 'CIRCLE_VERSION'),
      'utf8',
    ).trim(),
    version,
  );
  assert.equal((await updater.install()).phase, 'installing');
  assert.equal(quit, 1);
  const [command, args] = launched[0]!;
  assert.equal(command, '/bin/sh');
  assert.equal(args[6], setuid ? '1' : '0');
  assert.equal(readFileSync(args[0]!, 'utf8'), LINUX_INSTALLER);
  // The script needs a Unix shell and, for the setuid case, a mode bit Windows
  // does not keep. The launch command above is the decision either way.
  if (!setuid || !existsSync('/bin/sh')) return;
  args[1] = '999999';
  assert.equal(spawnSync(command, args, { stdio: 'inherit' }).status, 0);
  assert.equal(
    readFileSync(join(target, 'CIRCLE_VERSION'), 'utf8').trim(),
    version,
  );
  const log = readFileSync(join(folder, 'install.log'), 'utf8');
  assert.match(log, /installed/);
  assert.match(log, /sudo chmod 4755/);
  assert.equal(existsSync(marker), false);
  assert.equal(
    JSON.parse(readFileSync(join(folder, 'pending.json'), 'utf8')).sandbox,
    true,
  );
  const again = new Updater({
    version,
    home: join(root, 'home'),
    folder,
    installation: {
      kind: 'linux',
      target,
      executable,
      asset: (next) => `circle-desktop-${next}-linux-x64.tar.gz`,
    },
    releases,
    launch: () => {},
    quit: () => {},
  });
  const started = await again.start();
  assert.equal(started.phase, 'current');
  assert.equal(started.phase === 'current' ? started.updated : '', version);
  assert.deepEqual(started.phase === 'current' ? started.linux : undefined, {
    folder: target,
    sandbox: true,
  });
  assert.equal(
    JSON.parse(readFileSync(join(root, 'home', 'whats-new.json'), 'utf8')).seen,
    '1.0.0',
  );
});

test('a Linux update starts again when chrome-sandbox is not setuid', async (t) => {
  const root = scratch(t);
  const version = '1.1.0';
  const asset = `circle-desktop-${version}-linux-x64.tar.gz`;
  const marker = join(root, 'started');
  const bytes = linuxArchive(root, version, version, marker);
  const releases = await release(t, version, {
    [asset]: bytes,
    [`${asset}.sha256`]: `${sha(bytes)}  ${asset}\n`,
  });
  const target = join(root, 'opt', 'Circle-linux-x64');
  mkdirSync(target, { recursive: true });
  const executable = join(target, 'Circle');
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
  const folder = join(root, 'updates');
  let command = '';
  let args: string[] = [];
  const updater = new Updater({
    version: '1.0.0',
    home: join(root, 'home'),
    folder,
    installation: {
      kind: 'linux',
      target,
      executable,
      asset: (next) => `circle-desktop-${next}-linux-x64.tar.gz`,
    },
    releases,
    platform: 'linux',
    launch: (launchedCommand, launched) => {
      command = launchedCommand;
      args = launched;
    },
    quit: () => {},
    pid: 1,
  });
  await updater.check();
  await updater.download();
  await updater.install();
  assert.equal(command, '/bin/sh');
  assert.equal(args[6], '0');
  if (!existsSync('/bin/sh')) return;
  args[1] = '999999';
  spawn('/bin/sh', args, { stdio: 'inherit' });
  await until(() => existsSync(marker));
  assert.equal(existsSync(marker), true);
  assert.match(readFileSync(join(folder, 'install.log'), 'utf8'), /starting /);
  assert.equal(
    readFileSync(join(folder, 'install.log'), 'utf8').includes('sudo chmod'),
    false,
  );
});

test("a Linux archive with a path that leaves it, or without Circle's version, is not installed", async (t) => {
  const root = scratch(t);
  const evil = join(root, 'evil.tar.gz');
  execFileSync('python3', [
    '-c',
    `import tarfile, io
tar = tarfile.open(${JSON.stringify(evil)}, 'w:gz')
info = tarfile.TarInfo('../evil')
info.size = 1
tar.addfile(info, io.BytesIO(b'x'))
tar.close()`,
  ]);
  const asset = 'circle-desktop-1.1.0-linux-x64.tar.gz';
  const bad = readFileSync(evil);
  const plain = linuxArchive(root, '1.1.0', '9.9.9');
  const releases = await release(t, '1.1.0', {
    [asset]: bad,
    [`${asset}.sha256`]: `${sha(bad)}  ${asset}\n`,
  });
  const target = join(root, 'Circle-linux-x64');
  mkdirSync(target, { recursive: true });
  const options = {
    version: '1.0.0',
    home: join(root, 'home'),
    folder: join(root, 'updates'),
    installation: {
      kind: 'linux' as const,
      target,
      executable: join(target, 'Circle'),
      asset: (next: string) => `circle-desktop-${next}-linux-x64.tar.gz`,
    },
    releases,
    launch: () => assert.fail('nothing to install'),
    quit: () => assert.fail('nothing to install'),
  };
  const updater = new Updater(options);
  await updater.check();
  const failed = await updater.download();
  assert.equal(failed.phase, 'failed');
  assert.match((failed as { error: string }).error, /leaves the archive/);

  const again = await release(t, '1.1.0', {
    [asset]: plain,
    [`${asset}.sha256`]: `${sha(plain)}  ${asset}\n`,
  });
  const mismatch = new Updater({
    ...options,
    releases: again,
    home: join(root, 'home2'),
    folder: join(root, 'updates2'),
  });
  await mismatch.check();
  const wrong = await mismatch.download();
  assert.equal(wrong.phase, 'failed');
  assert.match(
    (wrong as { error: string }).error,
    /does not hold Circle 1\.1\.0/,
  );
});

test('a Linux folder that cannot be written keeps the release page and the steps', async (t) => {
  const root = scratch(t);
  const releases = await release(t, '2.0.0', {});
  const target = join(root, 'missing', 'Circle-linux-x64');
  const updater = new Updater({
    version: '1.0.0',
    home: join(root, 'home'),
    folder: join(root, 'updates'),
    installation: {
      kind: 'linux',
      target,
      executable: join(target, 'Circle'),
      asset: (version) => `circle-desktop-${version}-linux-x64.tar.gz`,
    },
    releases,
    launch: () => assert.fail('nothing to install'),
    quit: () => assert.fail('nothing to install'),
  });
  const state = await updater.check();
  assert.equal(state.phase, 'available');
  if (state.phase !== 'available') return;
  assert.equal(state.page, `${releases}/tag/v2.0.0`);
  assert.deepEqual(state.linux, { folder: target, sandbox: false });
  assert.equal(LINUX_INSTALLER.includes('sudo chmod 4755'), true);
});
