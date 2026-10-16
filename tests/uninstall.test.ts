import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { UsageError } from '../src/cli.js';
import { activateRelease } from '../src/install_layout.js';
import type { Run } from '../src/install_processes.js';
import {
  uninstallInstalled,
  windowsDeferredRemoval,
} from '../src/uninstall.js';
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
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
    binDir: string;
    prefix: string;
  };
  const binDir = receipt.binDir;
  return {
    base,
    prefix: real,
    bin,
    binDir,
    launcher: join(
      binDir,
      process.platform === 'win32' ? 'circle.cmd' : 'circle',
    ),
    home,
    data,
    receiptPath,
    versionRoot: join(real, 'versions', VERSION),
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: '',
      CIRCLE_HOME: data,
      // What the launcher sets: the prefix as the receipt names it, which may pass through
      // a link (macOS temporary folders do), not its real path.
      CIRCLE_INSTALL_PREFIX: receipt.prefix,
    },
  };
}
// The detached helper that removes the running version on Windows, recorded instead of
// started: no test leaves a real PowerShell behind.
function deferral() {
  const detached: [string, string[]][] = [];
  return {
    detached,
    spawnDetached: (command: string, args: string[]) => {
      detached.push([command, args]);
    },
  };
}
// Everything the installer wrote is gone; on Windows the running version's folder stays for
// the detached helper, which is the only one scheduled.
function assertRemoved(
  inst: ReturnType<typeof installed>,
  detached: [string, string[]][],
) {
  assert.equal(existsSync(join(inst.prefix, 'current.ref')), false);
  assert.equal(existsSync(join(inst.prefix, 'installation.json')), false);
  if (process.platform === 'win32') {
    // cmd.exe still reads the launcher: it goes with the helper, after this process.
    assert.equal(existsSync(inst.launcher), true);
    assert.deepEqual(readdirSync(join(inst.prefix, 'versions')), [VERSION]);
    assert.equal(detached.length, 1);
    assert.ok(
      detached[0]![1]
        .at(-1)!
        .includes(
          `Remove-Item -LiteralPath '${inst.launcher.replaceAll("'", "''")}' -Force`,
        ),
    );
  } else {
    assert.equal(existsSync(inst.launcher), false);
    assert.equal(existsSync(join(inst.prefix, 'versions')), false);
    assert.equal(detached.length, 0);
  }
}
// A hand-built Windows installation: `circle uninstall` does not check the release, so the
// version folder only has to exist. The scratch name carries an apostrophe to pin the
// PowerShell quoting.
function windowsInstalled(t: Parameters<typeof scratch>[0]) {
  // Its real path, as uninstall resolves the prefix: macOS temporary folders pass through a link.
  const base = realpathSync(scratch(t, "circle-'win-"));
  const prefix = join(base, 'install');
  // install.ps1's default launcher folder, inside the prefix.
  const bin = join(prefix, 'bin');
  const home = join(base, 'home');
  const data = join(base, 'data');
  const versionRoot = join(prefix, 'versions', VERSION);
  mkdirSync(join(versionRoot, 'app'), { recursive: true });
  mkdirSync(join(prefix, 'versions', '0.9.0'), { recursive: true });
  mkdirSync(bin, { recursive: true });
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
  assert.equal(existsSync(inst.launcher), true);
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

test('circle uninstall --help explains what is removed and exits 0', async () => {
  let text = '';
  const code = await uninstallInstalled(['--help'], {
    env: {},
    out: {
      write: (chunk: string) => {
        text += chunk;
      },
      isTTY: false,
    } as NodeJS.WriteStream,
  });
  assert.equal(code, 0);
  assert.match(text, /usage: circle uninstall/);
  assert.match(text, /data folder/);
  assert.match(text, /--purge/);
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
  assert.equal(existsSync(inst.launcher), true);
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
    assert.equal(existsSync(inst.launcher), true);
  }
});

test('yes on a terminal removes the installation', async (t) => {
  const inst = installed(t);
  const shown = screen();
  const prompted = asker('yes');
  const deferred = deferral();
  const code = await uninstallInstalled([], {
    root: inst.versionRoot,
    env: inst.env,
    out: shown.out,
    ask: prompted.ask,
    run: okRun,
    spawnDetached: deferred.spawnDetached,
  });
  assert.equal(code, 0);
  assertRemoved(inst, deferred.detached);
  if (process.platform !== 'win32')
    assert.equal(existsSync(inst.prefix), false);
  assert.equal(readFileSync(join(inst.data, 'settings.json'), 'utf8'), '{}');
});

test('circle uninstall --yes removes the launcher, every version and the receipt, and keeps the data folder', async (t) => {
  const inst = installed(t);
  mkdirSync(join(inst.prefix, 'versions', '0.9.0'));
  const shown = screen();
  const prompted = asker('y');
  const deferred = deferral();
  const code = await uninstallInstalled(['--yes'], {
    root: inst.versionRoot,
    env: inst.env,
    out: shown.out,
    ask: prompted.ask,
    run: okRun,
    spawnDetached: deferred.spawnDetached,
  });
  assert.equal(code, 0);
  assert.equal(prompted.questions.length, 0);
  assertRemoved(inst, deferred.detached);
  if (process.platform !== 'win32')
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
  const deferred = deferral();
  const code = await uninstallInstalled(['--purge', '--yes'], {
    root: inst.versionRoot,
    env: inst.env,
    out: shown.out,
    run: okRun,
    spawnDetached: deferred.spawnDetached,
  });
  assert.equal(code, 0);
  assertRemoved(inst, deferred.detached);
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
    // Only the POSIX installer writes startup files; the edit is checked on every system.
    platform: 'linux',
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
    platform: 'linux',
  });
  assert.equal(code, 0);
  assert.equal(readFileSync(join(inst.home, '.zshrc'), 'utf8'), 'x\n');
});

test('circle uninstall leaves other files in the prefix alone', async (t) => {
  const inst = installed(t);
  writeFileSync(join(inst.prefix, 'notes.txt'), 'mine\n');
  const deferred = deferral();
  const code = await uninstallInstalled(['--yes'], {
    root: inst.versionRoot,
    env: inst.env,
    out: screen().out,
    run: okRun,
    spawnDetached: deferred.spawnDetached,
  });
  assert.equal(code, 0);
  assertRemoved(inst, deferred.detached);
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
  // The real process lookup of this system (/proc, lsof or the native Windows query) finds it.
  await assert.rejects(
    uninstallInstalled(['--yes'], {
      root: inst.versionRoot,
      env: inst.env,
      out: screen().out,
      spawnDetached: deferral().spawnDetached,
    }),
    new RegExp(
      `still running from this installation \\(process ${child.pid}\\)`,
    ),
  );
  assert.equal(existsSync(join(inst.prefix, 'installation.json')), true);
  assert.equal(existsSync(inst.launcher), true);
});

test('circle uninstall on Windows removes the PATH entry and the other versions, and leaves the launcher and the running version to a helper', async (t) => {
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
  // cmd.exe reads circle.cmd line by line while circle runs: deleting it now would end the
  // launcher with "The batch file cannot be found."
  assert.equal(existsSync(join(inst.bin, 'circle.cmd')), true);
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
  const quoted = (path: string) => path.replaceAll("'", "''");
  // It waits for this process and the launcher's cmd.exe, its parent.
  assert.ok(deferred.includes(`$holders = @(${process.pid}, ${process.ppid})`));
  assert.deepEqual(deferred.split('\n').slice(3), [
    `Remove-Item -LiteralPath '${quoted(join(inst.bin, 'circle.cmd'))}' -Force`,
    `Remove-Item -LiteralPath '${quoted(inst.versionRoot)}' -Recurse -Force`,
    `try { [System.IO.Directory]::Delete('${quoted(join(inst.prefix, 'versions'))}') } catch {}`,
    `try { [System.IO.Directory]::Delete('${quoted(inst.bin)}') } catch {}`,
    `try { [System.IO.Directory]::Delete('${quoted(inst.prefix)}') } catch {}`,
  ]);
  assert.match(
    shown.writes.join(''),
    /the last files go when this session ends/,
  );
});

test('a user PATH entry that cannot be removed on Windows is a warning, not a failure', async (t) => {
  const inst = windowsInstalled(t);
  const run: Run = (command) =>
    command === process.execPath
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
  assert.equal(existsSync(join(inst.prefix, 'versions', '0.9.0')), false);
  assert.equal(existsSync(join(inst.prefix, 'installation.json')), false);
  assert.match(
    shown.writes.join(''),
    /warning: could not remove .* from your PATH/,
  );
});

test(
  'the Windows helper removes the launcher and the running version once their processes end, and keeps a folder that is not empty',
  {
    skip:
      process.platform !== 'win32' && 'runs the script in Windows PowerShell',
  },
  (t) => {
    const ended = spawnSync(process.execPath, ['-e', '']).pid!;
    const quoted = (text: string) => text.replaceAll("'", "''");
    for (const stranger of [false, true]) {
      const base = realpathSync(scratch(t, "circle-'helper-"));
      const prefix = join(base, 'install');
      const bin = join(prefix, 'bin');
      const launcher = join(bin, 'circle.cmd');
      const running = join(prefix, 'versions', VERSION);
      mkdirSync(join(running, 'runtime'), { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(running, 'runtime', 'node.exe'), 'synthetic');
      writeFileSync(launcher, '@echo off\r\n');
      if (stranger) writeFileSync(join(prefix, 'notes.txt'), 'mine\n');
      const script = windowsDeferredRemoval({
        wait: [ended],
        files: [launcher],
        trees: [running],
        emptyFolders: [join(prefix, 'versions'), bin, prefix],
      });
      assert.ok(script.includes(`'${quoted(launcher)}'`));
      const result = spawnSync(
        join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 60_000, windowsHide: true },
      );
      assert.ifError(result.error);
      // The effects are the result: the helper's own exit code is never read.
      const output = result.stderr + result.stdout;
      assert.equal(existsSync(launcher), false, output);
      assert.equal(existsSync(join(prefix, 'versions')), false, output);
      assert.equal(existsSync(bin), false, output);
      if (stranger)
        assert.equal(readFileSync(join(prefix, 'notes.txt'), 'utf8'), 'mine\n');
      else assert.equal(existsSync(prefix), false, output);
    }
  },
);
