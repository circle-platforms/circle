import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Executables cannot run inside asar. Never substitute PATH or a system Node. */
export function workspaceToolsForWorker(
  workerUrl: string,
  executable: string,
  platform = process.platform,
) {
  const directory = dirname(fileURLToPath(workerUrl)).replace(
    /([\\/])app\.asar([\\/])/,
    '$1app.asar.unpacked$2',
  );
  return {
    nodeExecutable: executable,
    runtimeExecutable: join(
      directory,
      'tools',
      'node',
      'bin',
      platform === 'win32' ? 'node.exe' : 'node',
    ),
    adapterPath: join(
      directory,
      'tools',
      'js-debug',
      'src',
      'dapDebugServer.js',
    ),
    ghPath: join(
      directory,
      'tools',
      'gh',
      'bin',
      platform === 'win32' ? 'gh.exe' : 'gh',
    ),
  };
}
