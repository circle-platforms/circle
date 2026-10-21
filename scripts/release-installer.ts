import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Wait for the installer's exit, then let the smoke check verify its receipt.
 * Native file verification can take minutes on Windows; elapsed time is not
 * evidence that an installation failed. Output remains bounded.
 */
export async function runReleaseInstaller(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execute(command, args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
    maxBuffer: 16_000_000,
  });
  return stdout;
}
