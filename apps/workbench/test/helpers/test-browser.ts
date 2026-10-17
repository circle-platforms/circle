import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LaunchOptions } from 'playwright';

/** Match the component tests' explicit channel, then find an installed browser. */
export function testBrowserOptions(
  bundledExecutable: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): LaunchOptions | undefined {
  if (environment.CIRCLE_TEST_BROWSER_CHANNEL)
    return { channel: environment.CIRCLE_TEST_BROWSER_CHANNEL };
  if (exists(bundledExecutable)) return {};
  if (
    platform === 'darwin' &&
    exists('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  )
    return { channel: 'chrome' };
  if (platform === 'win32') {
    for (const base of [
      environment.PROGRAMFILES,
      environment['PROGRAMFILES(X86)'],
      environment.LOCALAPPDATA,
    ])
      if (
        base &&
        exists(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      )
        return { channel: 'chrome' };
  }
  const executablePath = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/local/bin/google-chrome',
  ].find(exists);
  return executablePath ? { executablePath } : undefined;
}
