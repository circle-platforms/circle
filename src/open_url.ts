// Opening a web address in the system's browser, for an extension that asks (api.openUrl).
// Only http and https, with no user name or password in the address, and never through a
// shell: the address is one argument to the platform's opener.
import { execFile } from 'node:child_process';

export class OpenUrlError extends Error {}
export function checkedUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 4096)
    throw new OpenUrlError('a link must be a web address');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpenUrlError('a link must be a web address');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new OpenUrlError('only http and https links can be opened');
  if (url.username || url.password)
    throw new OpenUrlError('a link may not carry a user name or password');
  return url.href;
}
export type Runner = (command: string, args: string[]) => Promise<void>;
const run: Runner = (command, args) =>
  new Promise((resolve, reject) =>
    execFile(command, args, { timeout: 10_000 }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
export async function openInBrowser(
  raw: string,
  runner: Runner = run,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const url = checkedUrl(raw);
  if (platform === 'darwin') return runner('open', [url]);
  if (platform === 'win32')
    return runner('rundll32', ['url.dll,FileProtocolHandler', url]);
  return runner('xdg-open', [url]);
}
