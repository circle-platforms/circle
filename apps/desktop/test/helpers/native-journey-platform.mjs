import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
export function journeyShellInput(platform = process.platform) {
  return platform === 'win32'
    ? [
        'set /p answer=JOURNEY_INPUT? \r',
        'native-input\r',
        'echo JOURNEY_ECHO:%answer%\r',
      ]
    : [
        "printf 'JOURNEY_INPUT? '; read answer; printf '\\nJOURNEY_ECHO:%s\\n' \"$answer\"\n",
        'native-input\n',
      ];
}
export async function isolatedJourneyPath({
  platform = process.platform,
  environment = process.env,
  findGit = async () => (await exec('where.exe', ['git.exe'])).stdout,
} = {}) {
  if (platform !== 'win32') return '/usr/bin:/bin:/usr/sbin:/sbin';
  const git = (await findGit())
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => win32.isAbsolute(value) && /\\git\.exe$/i.test(value));
  if (
    !git ||
    !environment.SystemRoot ||
    !win32.isAbsolute(environment.SystemRoot)
  )
    throw Error(
      'Windows native journey requires the runner Git executable and SystemRoot',
    );
  return [
    win32.join(environment.SystemRoot, 'System32'),
    win32.dirname(git),
  ].join(';');
}
export async function assertBundledJourneyNode(executable) {
  const result = await exec(
    executable,
    ['-p', 'JSON.stringify({path:process.execPath,version:process.version})'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } },
  );
  const value = JSON.parse(result.stdout);
  assert.equal(value.version, 'v24.21.0');
  assert.equal(await realpath(value.path), await realpath(executable));
  return value;
}

export function journeyBundledNodePath({
  desktopRoot,
  applicationPath,
  platform = process.platform,
}) {
  const paths = platform === 'win32' ? win32 : { join };
  const dist = applicationPath
    ? paths.join(
        applicationPath,
        platform === 'darwin'
          ? 'Contents/Resources/app.asar.unpacked/dist'
          : 'resources/app.asar.unpacked/dist',
      )
    : paths.join(desktopRoot, 'dist');
  return paths.join(
    dist,
    'tools',
    'node',
    'bin',
    platform === 'win32' ? 'node.exe' : 'node',
  );
}
export function journeyNodeCommand(
  executable,
  script,
  platform = process.platform,
) {
  if (platform === 'win32') {
    if ([executable, script].some((value) => /[%!^"\r\n]/.test(value)))
      throw Error('Windows fixture path contains command expansion characters');
    return `"${executable}" "${script}"\r`;
  }
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `${quote(executable)} ${quote(script)}\r`;
}

export function journeyBundledNodeFromApp(
  { isPackaged, resourcesPath, appPath },
  platform = process.platform,
) {
  const paths = platform === 'win32' ? win32 : { join };
  const dist = isPackaged
    ? paths.join(resourcesPath, 'app.asar.unpacked/dist')
    : paths.join(appPath, 'dist');
  return paths.join(
    dist,
    'tools/node/bin',
    platform === 'win32' ? 'node.exe' : 'node',
  );
}
