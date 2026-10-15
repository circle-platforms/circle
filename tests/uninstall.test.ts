import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { UsageError } from '../src/cli.js';
import { activateRelease } from '../src/install_layout.js';
import type { Run } from '../src/legacy_install.js';
import { uninstallInstalled } from '../src/uninstall.js';
import { VERSION } from '../src/version.js';
import { cleanup, scratch } from './helpers.js';
import { fixture } from './release-fixture.js';

// A real installation of this version through the real layout code, with a home and a data
// folder of its own: nothing here touches the machine's ~/.circle or its startup files.
function installed(t: Parameters<typeof scratch>[0]) {
  const base = scratch(t);
  const root = fixture(base, VERSION);
  const prefix = join(base, 'install');
  const bin = join(base, 'bin');
  activateRelease(root, prefix, bin, 'example/circle');
  const home = join(base, 'home');
  const data = join(base, 'data');
  mkdirSync(home);
  mkdirSync(data);
  writeFileSync(join(data, 'settings.json'), '{}');
  const real = realpathSync(prefix);
  const receiptPath = join(real, 'installation.json');
  const binDir = JSON.parse(readFileSync(receiptPath, 'utf8')).binDir as string;
  return {
    base,
    prefix: real,
    bin,
    binDir,
    home,
    data,
    receiptPath,
    versionRoot: join(real, 'versions', VERSION),
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: '',
      CIRCLE_HOME: data,
      CIRCLE_INSTALL_PREFIX: real,
    },
  };
}
// A hand-built Windows installation: `circle uninstall` does not check the release, so the
// version folder only has to exist. The scratch name carries an apostrophe to pin the
// PowerShell quoting.
function windowsInstalled(t: Parameters<typeof scratch>[0]) {
  const base = scratch(t, "circle-'win-");
  const prefix = join(base, 'install');
  const bin = join(base, 'bin');
  const home = join(base, 'home');
  const data = join(base, 'data');
  const versionRoot = join(prefix, 'versions', VERSION);
  mkdirSync(join(versionRoot, 'app'), { recursive: true });
  mkdirSync(join(prefix, 'versions', '0.9.0'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(data);
  writeFileSync(join(data, 'settings.json'), '{}');
  writeFileSync(
    join(prefix, 'installation.json'),
    JSON.stringify({
      schema: 'circle-install/v1',
      repo: 'example/circle',
      binDir: bin,
      prefix,
    }) + '\n',
  );
  writeFileSync(join(prefix, 'current.ref'), VERSION + '\n');
  writeFileSync(join(bin, 'circle.cmd'), '@echo off\r\n');
  return {
    base,
    prefix,
    bin,
    home,
    data,
    versionRoot,
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: '',
      CIRCLE_HOME: data,
      CIRCLE_INSTALL_PREFIX: prefix,
    },
  };
}
function screen(isTTY = true) {
  const writes: string[] = [];
  return {
    writes,
    out: { isTTY, write: (text: string) => writes.push(text) },
  };
}
function asker(answer: string | undefined) {
  const questions: string[] = [];
  return {
    questions,
    ask: async (question: string) => {
      questions.push(question);
      return answer;
    },
  };
}
const okRun = () => ({ status: 0, stdout: '', stderr: '' });

test('circle uninstall stops without an installer-managed installation', async () => {
  const shown = screen();
  const prompted = asker('y');
  let runs = 0;
  await assert.rejects(
    uninstallInstalled([], {
      env: {},
      out: shown.out,
      ask: prompted.ask,
      run: (command, args) => {
        runs++;
        return okRun();
      },
    }),
    /circle uninstall requires an installer-managed installation/,
  );
  assert.equal(prompted.questions.length, 0);
  assert.equal(runs, 0);
  assert.deepEqual(shown.writes, []);
});

test('circle uninstall stops at an installation receipt it cannot trust', async (t) => {
  const inst = installed(t);
  const good = readFileSync(inst.receiptPath, 'utf8');
  const parsed = JSON.parse(good) as Record<string, unknown>;
  for (const body of [
    'garbage',
    JSON.stringify({ ...parsed, schema: 'circle-install/v9' }),
    JSON.stringify({ ...parsed, repo: 'not a repo' }),
    JSON.stringify({ ...parsed, prefix: join(inst.base, 'elsewhere') }),
    JSON.stringify({ ...parsed, binDir: 42 }),
  ]) {
    writeFileSync(inst.receiptPath, body);
    await assert.rejects(
      uninstallInstalled(['--yes'], {
        root: inst.versionRoot,
        env: inst.env,
        out: screen().out,
        run: okRun,
      }),
      /invalid installation receipt/,
      `receipt ${body}`,
    );
  }
  assert.equal(existsSync(inst.versionRoot), true);
  assert.equal(existsSync(join(inst.bin, 'circle')), true);
  writeFileSync(inst.receiptPath, good);
});

test('circle uninstall stops when the program does not run from the installation', async (t) => {
  const inst = installed(t);
  await assert.rejects(
    uninstallInstalled(['--yes'], {
      root: inst.base,
      env: inst.env,
      out: screen().out,
      run: okRun,
    }),
    /this program does not run from that installation/,
  );
  assert.equal(existsSync(join(inst.prefix, 'installation.json')), true);
});

test('circle uninstall rejects an unknown option before anything else', async () => {
  await assert.rejects(
    uninstallInstalled(['--force'], { env: {} }),
    (error: unknown) =>
      error instanceof UsageError &&
      /usage: circle uninstall \[--purge\] \[--yes\]/.test(error.message),
  );
});

test('circle uninstall needs --yes without a terminal', async (t) => {
  const inst = installed(t);
  await assert.rejects(
    uninstallInstalled([], {
      root: inst.versionRoot,
      env: inst.env,
      out: screen(false).out,
      run: okRun,
    }),
    (error: unknown) =>
      error instanceof UsageError && /needs --yes/.test(error.message),
  );
  assert.equal(existsSync(join(inst.prefix, 'installation.json')), true);
  assert.equal(existsSync(join(inst.bin, 'circle')), true);
});

test('a declined question on a terminal keeps the installation', async (t) => {
  const inst = installed(t);
  for (const answer of ['n', '', undefined]) {
    const shown = screen();
    const prompted = asker(answer);
    const code = await uninstallInstalled([], {
      root: inst.versionRoot,
      env: inst.env,
      out: shown.out,
      ask: prompted.ask,
      run: okRun,
    });
    assert.equal(code, 1);
    const listed = shown.writes.join('');
    assert.ok(listed.includes(inst.bin), 'the listing names the launcher');
    assert.ok(listed.includes(inst.prefix), 'the listing names the prefix');
    assert.ok(listed.includes(inst.data), 'the listing names the data folder');
    assert.match(prompted.questions[0]!, /uninstall circle \S\S+ \[y\/N\] $/);
    assert.equal(existsSync(join(inst.prefix, 'installation.json')), true);
    assert.equal(existsSync(join(inst.bin, 'circle')), true);
  }
});

test('yes on a terminal removes the installation', async (t) => {
  const inst = installed(t);
  const shown = screen();
  const prompted = asker('yes');
  const code = await uninstallInstalled([], {
    root: inst.versionRoot,
    env: inst.env,
    out: shown.out,
    ask: prompted.ask,
    run: okRun,
  });
  assert.equal(code, 0);
  assert.equal(existsSync(inst.prefix), false);
  assert.equal(existsSync(join(inst.bin, 'circle')), false);
  assert.equal(readFileSync(join(inst.data, 'settings.json'), 'utf8'), '{}');
});

test('circle uninstall --yes removes the launcher, every version and the receipt, and keeps the data folder', async (t) => {
  const inst = installed(t);
  mkdirSync(join(inst.prefix, 'versions', '0.9.0'));
  const shown = screen();
  const prompted = asker('y');
  const code = await uninstallInstalled(['--yes'], {
    root: inst.versionRoot,
    env: inst.env,
    out: shown.out,
    ask: prompted.ask,
    run: okRun,
  });
  assert.equal(code, 0);
  assert.equal(prompted.questions.length, 0);
  assert.equal(existsSync(join(inst.bin, 'circle')), false);
  assert.equal(existsSync(inst.prefix), false);
  assert.equal(readFileSync(join(inst.data, 'settings.json'), 'utf8'), '{}');
  const text = shown.writes.join('');
  assert.match(text, new RegExp(`removed circle ${VERSION}`));
  assert.match(text, /kept the data folder/);
  assert.ok(text.includes(inst.data));
});

test('circle uninstall --purge also deletes the data folder', async (t) => {
  const inst = installed(t);
  const shown = screen();
  const code = await uninstallInstalled(['--purge', '--yes'], {
    root: inst.versionRoot,
    env: inst.env,
    out: shown.out,
    run: okRun,
  });
  assert.equal(code, 0);
  assert.equal(existsSync(inst.prefix), false);
  assert.equal(existsSync(inst.data), false);
  assert.match(shown.writes.join(''), /removed the data folder/);
});

test('circle uninstall --purge refuses to delete a home folder', async (t) => {
  const inst = installed(t);
  await assert.rejects(
    uninstallInstalled(['--purge', '--yes'], {
      root: inst.versionRoot,
      env: inst.env,
      out: screen().out,
      run: okRun,
      dataHome: homedir(),
    }),
    /--purge would delete your home folder/,
  );
  assert.equal(existsSync(join(inst.prefix, 'installation.json')), true);
  assert.equal(existsSync(inst.data), true);
});

test('circle uninstall removes the marked PATH block from the startup file', async (t) => {
  const inst = installed(t);
  const userContent = 'alias ll="ls -l"\n';
  const block = (dir: string): string =>
    `\n# circle path\nexport PATH="${dir.replaceAll('"', '\\"')}:$PATH"\n`;
  writeFileSync(join(inst.home, '.zshrc'), userContent + block(inst.binDir));
  writeFileSync(join(inst.home, '.bashrc'), block('/somewhere/else'));
  const shown = screen();
  const prompted = asker('y');
  const code = await uninstallInstalled([], {
    root: inst.versionRoot,
    env: inst.env,
    out: shown.out,
    ask: prompted.ask,
    run: okRun,
  });
  assert.equal(code, 0);
  assert.equal(readFileSync(join(inst.home, '.zshrc'), 'utf8'), userContent);
  assert.equal(
    readFileSync(join(inst.home, '.bashrc'), 'utf8'),
    block('/somewhere/else'),
  );
  // The listing names the startup file the block comes out of, and only that one.
  const listed = shown.writes.join('');
  assert.ok(
    listed.includes(`the # circle path lines in ${join(inst.home, '.zshrc')}`),
  );
  assert.ok(!listed.includes('.bashrc'));
});

test('circle uninstall removes a PATH block whose folder contains quotes', async (t) => {
  const inst = installed(t);
  const quoted = join(inst.base, 'b"n');
  const receipt = JSON.parse(readFileSync(inst.receiptPath, 'utf8'));
  writeFileSync(
    inst.receiptPath,
    JSON.stringify({ ...receipt, binDir: quoted }) + '\n',
  );
  const escaped = quoted.replaceAll('"', '\\"');
  writeFileSync(
    join(inst.home, '.zshrc'),
    `x\n\n# circle path\nexport PATH="${escaped}:$PATH"\n`,
  );
  const code = await uninstallInstalled(['--yes'], {
    root: inst.versionRoot,
    env: inst.env,
    out: screen().out,
    run: okRun,
  });
  assert.equal(code, 0);
  assert.equal(readFileSync(join(inst.home, '.zshrc'), 'utf8'), 'x\n');
});

test('circle uninstall leaves other files in the prefix alone', async (t) => {
  const inst = installed(t);
  writeFileSync(join(inst.prefix, 'notes.txt'), 'mine\n');
  const code = await uninstallInstalled(['--yes'], {
    root: inst.versionRoot,
    env: inst.env,
    out: screen().out,
    run: okRun,
  });
  assert.equal(code, 0);
  assert.equal(existsSync(join(inst.prefix, 'versions')), false);
  assert.equal(existsSync(join(inst.prefix, 'current.ref')), false);
  assert.equal(existsSync(join(inst.prefix, 'installation.json')), false);
  assert.equal(readFileSync(join(inst.prefix, 'notes.txt'), 'utf8'), 'mine\n');
});

test('circle uninstall stops while another session runs from the installation', async (t) => {
  const inst = installed(t);
  const child = spawn(join(inst.versionRoot, 'runtime', 'node'), [
    '-e',
    'setTimeout(() => {}, 30000)',
  ]);
  cleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  await once(child, 'spawn');
  await assert.rejects(
    uninstallInstalled(['--yes'], {
      root: inst.versionRoot,
      env: inst.env,
      out: screen().out,
      run: okRun,
    }),
    new RegExp(
      `still running from this installation \\(process ${child.pid}\\)`,
    ),
  );
  assert.equal(existsSync(join(inst.prefix, 'installation.json')), true);
  assert.equal(existsSync(join(inst.bin, 'circle')), true);
});

test('circle uninstall on Windows removes the launcher, the PATH entry and every version but the running one', async (t) => {
  const inst = windowsInstalled(t);
  const calls: [string, string[]][] = [];
  const run: Run = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const detached: [string, string[]][] = [];
  const shown = screen();
  const code = await uninstallInstalled(['--yes'], {
    root: inst.versionRoot,
    env: inst.env,
    out: shown.out,
    platform: 'win32',
    run,
    spawnDetached: (command, args) => {
      detached.push([command, args]);
    },
  });
  assert.equal(code, 0);
  assert.equal(existsSync(join(inst.bin, 'circle.cmd')), false);
  // The user PATH is edited the way install.ps1 wrote it: read unexpanded, written back
  // as ExpandString, broadcast to running programs.
  const registry = calls.find(([, args]) =>
    args.some((arg) => arg.includes('DoNotExpandEnvironmentNames')),
  );
  assert.ok(registry, 'the registry script ran');
  const script = registry[1].at(-1)!;
  assert.ok(
    script.includes(`$binDir = '${inst.bin.replaceAll("'", "''")}'`),
    'the bin folder is a single-quoted literal',
  );
  assert.match(script, /RegistryValueOptions\]::DoNotExpandEnvironmentNames/);
  assert.match(script, /RegistryValueKind\]::ExpandString/);
  assert.match(script, /CIRCLE_PATH_TOUCH/);
  // The running version stays for the deferred helper; everything else is gone.
  assert.equal(existsSync(inst.versionRoot), true);
  assert.equal(existsSync(join(inst.prefix, 'versions', '0.9.0')), false);
  assert.equal(existsSync(join(inst.prefix, 'current.ref')), false);
  assert.equal(existsSync(join(inst.prefix, 'installation.json')), false);
  assert.equal(detached.length, 1);
  assert.ok(detached[0]![0].endsWith('powershell.exe'));
  const deferred = detached[0]![1].at(-1)!;
  assert.ok(deferred.includes(`Get-Process -Id ${process.pid}`));
  assert.ok(
    deferred.includes(
      `Remove-Item -LiteralPath '${inst.versionRoot.replaceAll("'", "''")}' -Recurse -Force`,
    ),
  );
  assert.ok(
    deferred.includes(
      `Remove-Item -LiteralPath '${join(inst.prefix, 'versions').replaceAll("'", "''")}' -Force`,
    ),
  );
  assert.match(
    shown.writes.join(''),
    /the last files go when this session ends/,
  );
});

test('a user PATH entry that cannot be removed on Windows is a warning, not a failure', async (t) => {
  const inst = windowsInstalled(t);
  const run: Run = (_command, args) =>
    args.some((arg) => arg.includes('Get-Process | Where-Object'))
      ? { status: 0, stdout: '', stderr: '' }
      : { status: 1, stdout: '', stderr: 'denied' };
  const shown = screen();
  const code = await uninstallInstalled(['--yes'], {
    root: inst.versionRoot,
    env: inst.env,
    out: shown.out,
    platform: 'win32',
    run,
    spawnDetached: () => {},
  });
  assert.equal(code, 0);
  assert.equal(existsSync(join(inst.bin, 'circle.cmd')), false);
  assert.equal(existsSync(join(inst.prefix, 'versions', '0.9.0')), false);
  assert.match(
    shown.writes.join(''),
    /warning: could not remove .* from your PATH/,
  );
});
