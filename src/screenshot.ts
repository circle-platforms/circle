import { existsSync, rmSync, statSync } from 'node:fs';
import { runOutput, type OutputRunner } from './ink/clipboard.js';

export interface ScreenshotOptions {
  /** Take the front window of the application with this name instead of the main screen. */
  app?: string;
  /** Where the PNG goes. */
  target: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: OutputRunner;
  /** esc: the capture stops and leaves no file. */
  signal?: AbortSignal;
}

/** Whether a screenshot can be taken here: a desktop on this machine, not one over ssh. */
export function canScreenshot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return platform === 'linux' && Boolean(env.WAYLAND_DISPLAY || env.DISPLAY);
}

// The on-screen windows, front to back: the number of the app's front window (`app` matched
// whole, else in part, case aside), the apps that have one, and whether the terminal seems
// allowed to record the screen. Without that permission macOS hides every other app's window
// titles, and a capture shows the desktop only; untitled windows can look the same.
const MAC_WINDOWS = `function run(argv) {
  ObjC.import('CoreGraphics');
  const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(
    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
    $.kCGNullWindowID))).filter((w) => w.kCGWindowLayer === 0);
  const owner = (w) => String(w.kCGWindowOwnerName || '');
  const want = String(argv[0] || '').toLowerCase();
  const terminal = String(argv[1] || '').toLowerCase().replace(/\\.app$/, '');
  const found = want
    ? windows.find((w) => owner(w).toLowerCase() === want) ||
      windows.find((w) => owner(w).toLowerCase().includes(want))
    : undefined;
  const others = windows.filter((w) => !owner(w).toLowerCase().includes(terminal || '\\u0000'));
  return JSON.stringify({
    window: found ? found.kCGWindowNumber : null,
    apps: [...new Set(windows.map(owner))].filter(Boolean),
    allowed: !others.length || others.some((w) => typeof w.kCGWindowName === 'string' && w.kCGWindowName !== ''),
  });
}`;

// One line, as Circle's other PowerShell commands: run with -Command, not as a script file.
// A named window draws itself into the picture (PrintWindow), so a window over it is not in
// it; the main screen is copied as it shows.
const WINDOWS_SHOT = [
  "$ErrorActionPreference = 'Stop'",
  // Window and app names reach Circle in UTF-8, not in the console's code page.
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class CircleWindow { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags); public struct Rect { public int Left, Top, Right, Bottom; } }\'',
  '[CircleWindow]::SetProcessDPIAware() | Out-Null',
  '$app = $env:CIRCLE_SCREENSHOT_APP',
  "if ($app) { $windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }); $found = (@($windows | Where-Object { $_.ProcessName -eq $app }) + @($windows | Where-Object { $_.ProcessName -like \"*$app*\" }) + @($windows | Where-Object { $_.MainWindowTitle -like \"*$app*\" })) | Select-Object -First 1; if (-not $found) { 'apps:' + (($windows | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join ', '); exit }; if ([CircleWindow]::IsIconic($found.MainWindowHandle)) { 'minimized'; exit }; $rect = New-Object CircleWindow+Rect; [CircleWindow]::GetWindowRect($found.MainWindowHandle, [ref]$rect) | Out-Null; $bitmap = New-Object Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top); $graphics = [Drawing.Graphics]::FromImage($bitmap); $dc = $graphics.GetHdc(); $drawn = [CircleWindow]::PrintWindow($found.MainWindowHandle, $dc, 2); $graphics.ReleaseHdc($dc); if (-not $drawn) { throw 'the window did not draw itself' } } else { $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height; $graphics = [Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size) }",
  '$bitmap.Save($env:CIRCLE_SCREENSHOT, [Drawing.Imaging.ImageFormat]::Png)',
  "'png'",
].join('; ');
const WINDOWS_TIMEOUT = 60_000;

// The first of these that is installed takes the screen
const LINUX_TOOLS = (wayland: boolean, target: string): [string, string[]][] =>
  wayland
    ? [
        ['grim', [target]],
        ['gnome-screenshot', ['-f', target]],
        ['spectacle', ['-b', '-n', '-f', '-o', target]],
      ]
    : [
        ['import', ['-window', 'root', target]],
        ['scrot', [target]],
        ['gnome-screenshot', ['-f', target]],
        ['spectacle', ['-b', '-n', '-f', '-o', target]],
      ];

const wrote = (target: string): boolean =>
  existsSync(target) && statSync(target).size > 0;

const MAC_PERMISSION =
  'If the picture shows only the desktop, the terminal may not record the screen: allow it in System Settings → Privacy & Security → Screen Recording, then quit and reopen the terminal.';

/**
 * Take a screenshot as a PNG at `target`; throws with what to do when it cannot, and leaves
 * no file then. Resolves to a hint for the model when the picture may not show what was asked.
 */
export async function takeScreenshot(
  options: ScreenshotOptions,
): Promise<string> {
  try {
    const hint = await capture(options);
    options.signal?.throwIfAborted();
    return hint;
  } catch (error) {
    rmSync(options.target, { force: true });
    options.signal?.throwIfAborted();
    throw error;
  }
}
async function capture(options: ScreenshotOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run: OutputRunner = (command, args, settings) => {
    options.signal?.throwIfAborted();
    return (options.run ?? runOutput)(command, args, {
      ...settings,
      signal: options.signal,
    });
  };
  const app = options.app?.trim() ?? '';
  const { target } = options;
  if (platform === 'darwin') {
    const listed = await run(
      'osascript',
      ['-l', 'JavaScript', '-e', MAC_WINDOWS, app, env.TERM_PROGRAM ?? ''],
      { timeout: 10_000 },
    );
    let windows: { window: number | null; apps: string[]; allowed: boolean };
    try {
      windows = JSON.parse(listed.stdout.toString('utf8'));
    } catch {
      throw new Error('could not list the windows on the screen');
    }
    if (app && windows.window === null)
      throw new Error(
        `no window of "${app}" is on screen. Apps with windows: ${windows.apps.join(', ')}`,
      );
    const shot = await run(
      'screencapture',
      [
        '-x',
        '-t',
        'png',
        ...(windows.window === null
          ? []
          : ['-o', '-l', String(windows.window)]),
        target,
      ],
      { timeout: 20_000 },
    );
    if (shot.code !== 0 || !wrote(target))
      throw new Error(
        'screencapture did not take the screenshot. ' + MAC_PERMISSION,
      );
    return windows.allowed ? '' : MAC_PERMISSION;
  }
  if (platform === 'win32') {
    // PowerShell builds the window helper each time, which has taken over 20 seconds on a
    // busy machine
    const shot = await run(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SHOT],
      {
        timeout: WINDOWS_TIMEOUT,
        env: {
          ...env,
          CIRCLE_SCREENSHOT: target,
          CIRCLE_SCREENSHOT_APP: app,
        },
      },
    );
    if (shot.timedOut)
      throw new Error(
        `PowerShell did not finish the screenshot in ${WINDOWS_TIMEOUT / 1000} seconds`,
      );
    const said = shot.stdout.toString('utf8').trim();
    if (said.startsWith('apps:'))
      throw new Error(
        `no window of "${app}" is open. Apps with windows: ${said.slice(5).trim()}`,
      );
    if (said === 'minimized')
      throw new Error(
        `the window of "${app}" is minimized; ask the user to restore it`,
      );
    if (shot.code !== 0 || !wrote(target))
      throw new Error('PowerShell did not take the screenshot');
    return '';
  }
  if (app)
    throw new Error(
      'on Linux only the whole screen can be taken; leave out the app',
    );
  const tools = LINUX_TOOLS(Boolean(env.WAYLAND_DISPLAY), target);
  for (const [command, args] of tools) {
    const shot = await run(command, args, { timeout: 20_000 });
    if (shot.code === 0 && wrote(target)) return '';
  }
  throw new Error(
    `no screenshot tool worked; install one of ${[...new Set(tools.map(([command]) => command))].join(', ')}`,
  );
}
