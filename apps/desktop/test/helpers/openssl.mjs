import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function works(file) {
  try {
    await run(file, ['version'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The OpenSSL program a live fixture makes its synthetic certificates with:
 * `openssl` on PATH, or on Windows the one Git for Windows ships next to Git
 * (its usr\bin, which holds openssl, is usually not on PATH).
 */
export async function findOpenssl() {
  if (await works('openssl')) return 'openssl';
  if (process.platform === 'win32') {
    const roots = [];
    try {
      // <git>\mingw64\libexec\git-core
      const { stdout } = await run('git', ['--exec-path'], { timeout: 15000 });
      roots.push(join(stdout.trim(), '..', '..', '..'));
    } catch {
      /* Git is not on PATH either. */
    }
    for (const base of [process.env.ProgramFiles, process.env.ProgramW6432])
      if (base) roots.push(join(base, 'Git'));
    for (const root of roots)
      for (const file of [
        join(root, 'mingw64', 'bin', 'openssl.exe'),
        join(root, 'usr', 'bin', 'openssl.exe'),
      ])
        if (existsSync(file) && (await works(file))) return file;
  }
  throw new Error(
    'this live check makes its HTTPS certificates with OpenSSL: put openssl on PATH' +
      (process.platform === 'win32'
        ? ', or install Git for Windows, whose usr\\bin has one'
        : ''),
  );
}
