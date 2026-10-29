// A write by another program, as the native journeys simulate one. When the system refuses
// it, the error says what was refused, and on Windows which processes have the file open
// just after, so a refusal that happens only now and then can be read from the run's
// evidence. The write itself is never repeated.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
    const refused = {
      path,
      code: error?.code,
      errno: error?.errno,
      syscall: error?.syscall,
      message: String(error?.message ?? error),
      ...(platform === 'win32' ? { holders: await holders(path) } : {}),
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

const listHolders = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition $env:CIRCLE_FILE_HOLDERS_SOURCE
$rows = @()
foreach ($row in [CircleFileHolders]::Holders($env:CIRCLE_FILE_HOLDERS_PATH)) {
  $parts = $row -split "\`t", 3
  $process = Get-Process -Id ([int]$parts[0]) -ErrorAction SilentlyContinue
  $rows += [pscustomobject]@{
    pid = [int]$parts[0]
    type = [int]$parts[1]
    name = $parts[2]
    image = $process.Path
  }
}
ConvertTo-Json -InputObject @($rows) -Compress
`;

/**
 * The processes that have the file open, on Windows: their id, Restart Manager's kind of
 * application, its name and the program's path. For evidence only: it never throws, and
 * a failure to ask comes back as `{ error }`.
 */
export function fileHolders(path, { timeoutMs = 60_000 } = {}) {
  if (process.platform !== 'win32')
    return Promise.resolve({ error: 'only Windows is asked' });
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  // The file's own long name: a temporary folder can be named in its short 8.3 form.
  let file = path;
  try {
    file = realpathSync.native(path);
  } catch {}
  return new Promise((resolve) => {
    execFile(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(listHolders, 'utf16le').toString('base64'),
      ],
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          CIRCLE_FILE_HOLDERS_SOURCE: restartManager,
          CIRCLE_FILE_HOLDERS_PATH: file,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ error: String(stderr || error.message).trim() });
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ error: `unreadable answer: ${stdout.trim()}` });
        }
      },
    );
  });
}
