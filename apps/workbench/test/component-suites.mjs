import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const COMPONENT_SUITES = Object.freeze([
  'editor-ui.mjs',
  'resource-boundary-ui.mjs',
  'pending-operations-ui.mjs',
  'recovered-input-ui.mjs',
  'tasks-panel-ui.mjs',
  'git-continuity-ui.mjs',
  'debug-panel-ui.mjs',
  'browser-diagnostics-ui.mjs',
  'keyboard-navigation-ui.mjs',
  'windowed-mount-ui.mjs',
  'native-terminal-search-ui.mjs',
  'original-shell-ui.mjs',
  'debug-panel-embedded.mjs',
  'original-browser-shell-ui.mjs',
  'native-terminal-fit-ui.mjs',
  'runtime-failure-ui.mjs',
  'session-navigation-ui.mjs',
  'response-readability-ui.mjs',
  'inspector-width-ui.mjs',
]);

/** Explicit suites run serially; a failed suite prevents later execution. */
export async function runComponentSuites({
  suites = COMPONENT_SUITES.map((name) => join(root, 'test', name)),
  outputRoot = process.env.CIRCLE_COMPONENT_UI_OUTPUT ??
    join(root, '../desktop/artifacts/component-ui'),
  nodeArguments = [
    '--import',
    'tsx',
    '--import',
    new URL('./helpers/component-evidence.mjs', import.meta.url).href,
  ],
  environment = process.env,
  timeoutMs = 90_000,
} = {}) {
  await mkdir(outputRoot, { recursive: true });
  const output = await mkdtemp(join(outputRoot, 'attempt-'));
  const receipt = { output, startedAt: new Date().toISOString(), suites: [] };
  const save = () =>
    writeFile(
      join(output, 'receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n',
    );
  await save();
  for (const [index, file] of suites.entries()) {
    const name = `${index + 1}-${file
      .split(/[\\/]/)
      .at(-1)
      .replace(/\.mjs$/, '')}`;
    const directory = join(output, name);
    await mkdir(directory);
    const result = {
      file,
      directory,
      state: 'running',
      startedAt: new Date().toISOString(),
    };
    receipt.suites.push(result);
    await save();
    const log = createWriteStream(join(directory, 'output.log'));
    console.log(`component UI ${name}`);
    const env = {
      ...environment,
      CIRCLE_COMPONENT_UI_EVIDENCE: directory,
      CIRCLE_BROWSER_UI_EVIDENCE: join(directory, 'browser-diagnostics'),
      CIRCLE_WINDOWED_EVIDENCE_DIR: join(directory, 'windowed-mount'),
      CIRCLE_TERMINAL_SEARCH_EVIDENCE: join(directory, 'terminal-search'),
      CIRCLE_UI_EVIDENCE: join(directory, 'original-shell'),
      CIRCLE_DEBUG_EMBEDDED_EVIDENCE: join(directory, 'debug-embedded'),
      CIRCLE_BROWSER_SHELL_EVIDENCE: join(directory, 'browser-shell'),
      CIRCLE_TERMINAL_FIT_EVIDENCE: join(directory, 'terminal-fit'),
      CIRCLE_FAILURE_UI_EVIDENCE: join(directory, 'runtime-failure'),
      CIRCLE_SESSION_NAV_EVIDENCE: join(directory, 'session-navigation'),
      CIRCLE_RESPONSE_UI_EVIDENCE: join(directory, 'response-readability'),
      CIRCLE_INSPECTOR_WIDTH_EVIDENCE: join(directory, 'inspector-width'),
    };
    const child = spawn(process.execPath, [...nodeArguments, file], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        log.write(chunk);
        process.stdout.write(chunk);
      });
    const exit = await new Promise((resolveExit) => {
      child.once('error', (error) =>
        resolveExit({ code: null, signal: null, error: error.message }),
      );
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
    clearTimeout(timer);
    await new Promise((resolveLog) => log.end(resolveLog));
    Object.assign(result, exit, {
      state: !timedOut && exit.code === 0 ? 'passed' : 'failed',
      timedOut,
      finishedAt: new Date().toISOString(),
    });
    await save();
    if (result.state !== 'passed')
      throw Error(`component UI failed: ${name}; evidence: ${directory}`);
  }
  receipt.finishedAt = new Date().toISOString();
  await save();
  return receipt;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await runComponentSuites();
