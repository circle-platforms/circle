import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Called only inside the desktop utility process, never by the CLI or host. */
export function workspaceRuntimePath(runtimeExecutable: string, previous = '') {
  const directory = dirname(runtimeExecutable);
  return previous.split(delimiter)[0] === directory
    ? previous
    : directory + (previous ? delimiter + previous : '');
}

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
    // Windows runs the same supervisor inside a Job object (windows-command-job.ts).
    commandSupervisorPath: join(directory, 'tools', 'command-supervisor.mjs'),
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
