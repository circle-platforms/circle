import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeFileHolders,
  prepareFileHolders,
  writeOutside,
  type OutsideWriteRefusal,
} from './helpers/outside-write.mjs';

type Refused = Error & { refused: OutsideWriteRefusal };
const refusedBy = (write: Promise<void>) =>
  write.then(
    () => assert.fail('the outside write was not refused'),
    (error: Refused) => error,
  );

test('a refused outside write says what the system refused, and on Windows who has the file open', async () => {
  const path = 'C:\\workspace\\editor-main.ts';
  // What Node reports for a Windows error it has no name for.
  const refusal = Object.assign(
    Error(`UNKNOWN: unknown error, open '${path}'`),
    { errno: -4094, code: 'UNKNOWN', syscall: 'open', path },
  );
  const write = async () => {
    throw refusal;
  };
  const holder = {
    pid: 4242,
    type: 3,
    name: 'scanner',
    image: 'C:\\scanner.exe',
  };
  const asked: string[] = [];
  const windows = await refusedBy(
    writeOutside(path, 'outside\n', {
      write,
      platform: 'win32',
      holders: async (file) => {
        asked.push(file);
        return [holder];
      },
    }),
  );
  assert.equal(windows.cause, refusal);
  assert.deepEqual(asked, [path]);
  const { holdersWithinMs, ...refused } = windows.refused;
  assert.equal(typeof holdersWithinMs, 'number');
  assert.deepEqual(refused, {
    path,
    code: 'UNKNOWN',
    errno: -4094,
    syscall: 'open',
    message: refusal.message,
    holders: [holder],
  });
  // The run's evidence keeps the message: it carries the same record.
  assert.deepEqual(
    JSON.parse(windows.message.slice('the outside write was refused: '.length)),
    windows.refused,
  );
  // Elsewhere the refusal is recorded without asking for holders.
  const other = await refusedBy(
    writeOutside(path, 'outside\n', {
      write,
      platform: 'linux',
      holders: async () => assert.fail('only Windows is asked'),
    }),
  );
  assert.equal(other.refused.code, 'UNKNOWN');
  assert.equal(other.refused.syscall, 'open');
  assert.equal('holders' in other.refused, false);
  assert.equal('holdersWithinMs' in other.refused, false);
});

test('preparing the holder lookup starts nothing off Windows', async () => {
  // Settles at once: no PowerShell exists to start here.
  await prepareFileHolders({ platform: 'linux' });
  await prepareFileHolders({ platform: 'darwin' });
});

test('an outside write nobody refuses lands on disk', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-outside-write-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeOutside(join(folder, 'main.ts'), 'outside\n');
  assert.equal(await readFile(join(folder, 'main.ts'), 'utf8'), 'outside\n');
});

test('an outside write keeps the file where it stands and leaves nothing of longer content', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-outside-write-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'main.ts');
  await writeFile(file, 'a longer original content\n');
  const { ino } = await stat(file);
  await writeOutside(file, 'outside\n');
  assert.equal(await readFile(file, 'utf8'), 'outside\n');
  assert.equal((await stat(file)).ino, ino);
});

/** A real program that runs `open` on the file, then stays until the test ends. */
async function holdFile(
  t: test.TestContext,
  folder: string,
  file: string,
  open: string,
) {
  const holder = spawn(
    join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // Stops at the first error: it says it holds the file only once it does.
      `$ErrorActionPreference = 'Stop'; ${open}; [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 300`,
    ],
    {
      env: { ...process.env, CIRCLE_HELD_FILE: file },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    },
  );
  const exited = once(holder, 'exit');
  t.after(async () => {
    holder.kill();
    await exited;
    await rm(folder, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  await new Promise<void>((resolve, reject) => {
    let said = '';
    holder.stdout!.on('data', (chunk) => {
      said += String(chunk);
      if (said.includes('held')) resolve();
    });
    void exited.then(() => reject(Error('the holder ended before it held')));
  });
  return holder;
}

test(
  'on Windows an outside write lands while another program has the file mapped, where truncating is refused',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'circle-outside-write-'));
    const file = join(folder, 'main.ts');
    await writeFile(file, 'original\n');
    // Maps the file to read it and shares it with everyone, as Git does to hash a file.
    await holdFile(
      t,
      folder,
      file,
      "$file = [System.IO.File]::Open($env:CIRCLE_HELD_FILE, 'Open', 'Read', 'ReadWrite, Delete'); $map = [System.IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($file, ('circle-held-' + $PID), 0, 'Read', $null, 'None', $false); $view = $map.CreateViewAccessor(0, 0, 'Read')",
    );
    // What the editor journey met (#331): the same code, errno and system call.
    await assert.rejects(writeFile(file, 'truncating\n'), {
      code: 'UNKNOWN',
      errno: -4094,
      syscall: 'open',
    });
    const outside = 'outside, and longer than the original\n';
    await writeOutside(file, outside);
    assert.equal(await readFile(file, 'utf8'), outside);
  },
);

test(
  'on Windows a refused outside write names the process that has the file open',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'circle-outside-write-'));
    const file = join(folder, 'main.ts');
    await writeFile(file, 'original\n');
    // A program that has the file open and shares it with nobody.
    const holder = await holdFile(
      t,
      folder,
      file,
      "$file = [System.IO.File]::Open($env:CIRCLE_HELD_FILE, 'Open', 'ReadWrite', 'None')",
    );
    // As the journey does: the lookup runs before the write, and answers the refusal.
    t.after(closeFileHolders);
    await prepareFileHolders();
    const refused = await refusedBy(writeOutside(file, 'outside\n'));
    assert.equal(refused.refused.code, 'EBUSY');
    assert.equal(typeof refused.refused.holdersWithinMs, 'number');
    assert.equal(refused.refused.syscall, 'open');
    const holders = refused.refused.holders;
    assert.ok(Array.isArray(holders), JSON.stringify(holders));
    assert.ok(
      holders.some((row) => row.pid === holder.pid),
      JSON.stringify(holders),
    );
  },
);
