// A write by another program, as the native journeys simulate one. When the system refuses
// it, the error says what was refused, and on Windows which processes have the file open
// at that moment, so a refusal that happens only now and then can be read from the run's
// evidence. The write itself is never repeated.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export async function writeOutside(
  path,
  content,
  {
    write = writeFile,
    platform = process.platform,
    holders = fileHolders,
  } = {},
) {
  try {
    await write(path, content);
  } catch (error) {
    const refusedAt = performance.now();
    const held =
      platform === 'win32'
        ? {
            holders: await holders(path),
            // How long after the refusal the holders' answer was in: they were read
            // no later than this.
            holdersWithinMs: Math.round(performance.now() - refusedAt),
          }
        : {};
    const refused = {
      path,
      code: error?.code,
      errno: error?.errno,
      syscall: error?.syscall,
      message: String(error?.message ?? error),
      ...held,
    };
    throw Object.assign(
      Error(`the outside write was refused: ${JSON.stringify(refused)}`, {
        cause: error,
      }),
      { refused },
    );
  }
}

// Restart Manager names the processes that have a file open, as Windows itself asks
// before it replaces a file in use.
const restartManager = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CircleFileHolders {
  [StructLayout(LayoutKind.Sequential)]
  struct UniqueProcess {
    public int ProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint session, int flags, string key);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint session);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint session, uint files, string[] names,
    uint applications, UniqueProcess[] processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint session, out uint needed, ref uint count,
    [In, Out] ProcessInfo[] infos, ref uint reasons);
  public static string[] Holders(string path) {
    uint session;
    int result = RmStartSession(out session, 0, Guid.NewGuid().ToString());
    if (result != 0) throw new Exception("RmStartSession failed: " + result);
    try {
      result = RmRegisterResources(session, 1, new string[] { path }, 0, null, 0, null);
      if (result != 0) throw new Exception("RmRegisterResources failed: " + result);
      uint needed = 0, count = 0, reasons = 0;
      ProcessInfo[] infos = null;
      // ERROR_MORE_DATA: the list grew between the two calls.
      for (int attempt = 0; attempt < 5; attempt++) {
        result = RmGetList(session, out needed, ref count, infos, ref reasons);
        if (result != 234) break;
        infos = new ProcessInfo[needed];
        count = needed;
      }
      if (result != 0) throw new Exception("RmGetList failed: " + result);
      var rows = new List<string>();
      for (int i = 0; i < count; i++)
        rows.Add(infos[i].Process.ProcessId + "\t" + infos[i].ApplicationType + "\t" + infos[i].AppName);
      return rows.ToArray();
    } finally {
      RmEndSession(session);
    }
  }
}`;

// Kept running and asked one path per line, so the answer needs no new PowerShell and no
// compiler: started before a write, it reads the holders at the moment of a refusal rather
// than the seconds later a fresh start takes. Paths and answers are base64 UTF-8 lines,
// whatever the console's code page.
const serveHolders = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition $env:CIRCLE_FILE_HOLDERS_SOURCE
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Answer($value) {
  $json = ConvertTo-Json -InputObject $value -Compress -Depth 4
  [Console]::Out.WriteLine([Convert]::ToBase64String($utf8.GetBytes($json)))
  [Console]::Out.Flush()
}
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $path = $utf8.GetString([Convert]::FromBase64String($line))
    $rows = @()
    foreach ($row in [CircleFileHolders]::Holders($path)) {
      $parts = $row -split "\`t", 3
      $process = Get-Process -Id ([int]$parts[0]) -ErrorAction SilentlyContinue
      $rows += [pscustomobject]@{
        pid = [int]$parts[0]
        type = [int]$parts[1]
        name = $parts[2]
        image = $process.Path
      }
    }
    Answer @($rows)
  } catch {
    Answer ([pscustomobject]@{ error = [string]$_ })
  }
}
`;

const powershell = () =>
  join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

/** The running lookup, shared by every outside write of this process. */
let shared;

function startLookup({ startMs = 60_000 } = {}) {
  const child = spawn(
    powershell(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(serveHolders, 'utf16le').toString('base64'),
    ],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CIRCLE_FILE_HOLDERS_SOURCE: restartManager },
    },
  );
  const waiting = [];
  let failure,
    started,
    markReady,
    buffered = '',
    stderr = '';
  const ready = new Promise((resolve) => (markReady = resolve));
  const lookup = {
    ready,
    ask(path, timeoutMs) {
      if (failure) return Promise.resolve({ error: failure });
      return new Promise((resolve) => {
        // Also what keeps this process running until the answer is in.
        const timer = setTimeout(() => {
          fail(`no answer within ${timeoutMs} ms`);
          child.kill();
        }, timeoutMs);
        waiting.push({ resolve, timer });
        child.stdin.write(Buffer.from(path, 'utf8').toString('base64') + '\n');
      });
    },
    close() {
      fail('the lookup was closed');
      child.stdin.end();
      child.kill();
    },
  };
  const starting = setTimeout(() => {
    fail(`the lookup did not start within ${startMs} ms`);
    child.kill();
  }, startMs);
  function fail(why) {
    failure ??= why;
    clearTimeout(starting);
    markReady();
    for (const entry of waiting.splice(0)) {
      clearTimeout(entry.timer);
      entry.resolve({ error: failure });
    }
    // A later write starts a new one.
    if (shared === lookup) shared = undefined;
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    for (let end; (end = buffered.indexOf('\n')) >= 0;) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      if (!started) {
        if (line === 'ready') {
          started = true;
          clearTimeout(starting);
          markReady();
        }
        continue;
      }
      const next = waiting.shift();
      if (!next) continue;
      clearTimeout(next.timer);
      try {
        next.resolve(JSON.parse(Buffer.from(line, 'base64').toString('utf8')));
      } catch {
        next.resolve({ error: `unreadable answer: ${line}` });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdin.on('error', () => {});
  child.on('error', (error) => fail(String(error.message)));
  child.on('exit', (code, signal) =>
    fail(stderr.trim() || `the lookup ended (${signal ?? code})`),
  );
  // Idle, the lookup keeps nothing running: only a question or its start does.
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr])
    stream.unref?.();
  return lookup;
}

/**
 * Starts the Windows lookup of file holders ahead of the outside writes, so a refusal is
 * answered at once. Settles when it can answer, or when it could not start (a later
 * question then says why). Elsewhere it does nothing.
 */
export function prepareFileHolders({ platform = process.platform } = {}) {
  if (platform !== 'win32') return Promise.resolve();
  shared ??= startLookup();
  return shared.ready;
}

/** Stops the lookup prepareFileHolders started, if any. */
export function closeFileHolders() {
  shared?.close();
}

/**
 * The processes that have the file open, on Windows: their id, Restart Manager's kind of
 * application, its name and the program's path. For evidence only: it never throws, and
 * a failure to ask comes back as `{ error }`.
 */
export function fileHolders(path, { timeoutMs = 60_000 } = {}) {
  if (process.platform !== 'win32')
    return Promise.resolve({ error: 'only Windows is asked' });
  // The file's own long name: a temporary folder can be named in its short 8.3 form.
  let file = path;
  try {
    file = realpathSync.native(path);
  } catch {}
  shared ??= startLookup();
  return shared.ask(file, timeoutMs);
}
