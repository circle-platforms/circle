#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  circleHome,
  expandUser,
  newTaskName,
  normalizeWorkspace,
  taskWorkspace,
  tasksFolder,
} from './paths.js';
import {
  isFolderTrusted,
  isReady,
  loadCredentials,
  loadSettings,
  saveSettings,
  trustFolder,
  applyProjectSettings,
  type CircleSettings,
} from './settings.js';
import {
  defaultRunOptions,
  promptText,
  toolNames,
  type RunOptions,
} from './run_options.js';
import { resolveEndpoint } from './probe.js';
import { mediaType } from './media.js';
import { mention } from './mentions.js';
import { EFFORT_LEVELS } from './model.js';
import { installExitGuard } from './exit_guard.js';
import { initializeNetwork } from './network_bootstrap.js';
import { hangingWrap, pad, stringWidth } from './ink/string_width.js';
import { t } from './locale.js';
import { networkSummary } from './net.js';
import { VERSION } from './version.js';
import { UsageError } from './usage_error.js';
export { VERSION } from './version.js';
export { UsageError };
export interface CliOptions {
  version: boolean;
  help: boolean;
  printHome: boolean;
  print: boolean;
  line: boolean;
  init: boolean;
  mode: string;
  yolo: boolean;
  /** Trust this folder for this run and remember it, including when nobody is at a terminal. */
  trust: boolean;
  /** Approve the folder's project hooks files as they are now, without a card. */
  approveHooks: boolean;
  extensions: boolean;
  verbose: boolean;
  continue: boolean;
  resume: boolean;
  session: string;
  sessionId: string;
  fork: string;
  model: string;
  thinking: string;
  listModels: string | null;
  export: string[] | null;
  workspace: string;
  /** Set by --task: work in a folder of Circle's own, named this or made up. */
  task?: string;
  prompts: string[];
  // The @files from the command line, as written, without the @
  files: string[];
  run: RunOptions;
}
const FLAGS: Record<
  string,
  keyof CliOptions | 'no-session' | 'no-context-files' | 'no-tools'
> = {
  '-v': 'version',
  '--version': 'version',
  '-h': 'help',
  '--help': 'help',
  '--print-home': 'printHome',
  '-c': 'continue',
  '--continue': 'continue',
  '-r': 'resume',
  '--resume': 'resume',
  '--line': 'line',
  '--init': 'init',
  '--yolo': 'yolo',
  '--trust': 'trust',
  '--approve-hooks': 'approveHooks',
  '--extensions': 'extensions',
  '--verbose': 'verbose',
  '--no-session': 'no-session',
  '-nc': 'no-context-files',
  '--no-context-files': 'no-context-files',
  '-nt': 'no-tools',
  '--no-tools': 'no-tools',
};
const VALUES: Record<string, string> = {
  '--mode': 'mode',
  '--session': 'session',
  '--session-id': 'sessionId',
  '--fork': 'fork',
  '-m': 'model',
  '--model': 'model',
  '--thinking': 'thinking',
  '-n': 'name',
  '--name': 'name',
  '--models': 'models',
  '--system-prompt': 'system',
  '--append-system-prompt': 'append',
  '-t': 'tools',
  '--tools': 'tools',
  '-xt': 'exclude',
  '--exclude-tools': 'exclude',
};
export function parseCli(argv: string[], cwd = process.cwd()): CliOptions {
  const options: CliOptions = {
    version: false,
    help: false,
    printHome: false,
    print: false,
    line: false,
    init: false,
    mode: 'text',
    yolo: false,
    trust: false,
    approveHooks: false,
    extensions: false,
    verbose: false,
    continue: false,
    resume: false,
    session: '',
    sessionId: '',
    fork: '',
    model: '',
    thinking: '',
    listModels: null,
    export: null,
    workspace: normalizeWorkspace(cwd),
    prompts: [],
    files: [],
    run: defaultRunOptions(),
  };
  const words: string[] = [];
  // undefined: no -p; '': -p given as a flag, so the first word may be the prompt
  let printPrompt: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    const equal = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = equal >= 0 ? raw.slice(0, equal) : raw;
    const inline = equal >= 0 ? raw.slice(equal + 1) : undefined;
    if (flag === '-p' || flag === '--print') {
      options.print = true;
      if (inline !== undefined) printPrompt = inline;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('-'))
        printPrompt = argv[++i];
      else printPrompt ??= '';
      continue;
    }
    if (flag === '--task') {
      // A task with no project: a folder under the task folder, named or not.
      options.task =
        inline ??
        (argv[i + 1] && !argv[i + 1]!.startsWith('-') ? argv[++i]! : '');
      continue;
    }
    if (flag === '--list-models') {
      options.listModels =
        inline ??
        (argv[i + 1] && !argv[i + 1]!.startsWith('-') ? argv[++i]! : '');
      continue;
    }
    if (flag === '--export') {
      const id = inline ?? argv[++i];
      if (!id || id.startsWith('-'))
        throw new UsageError('--export requires a session ID');
      options.export = [id];
      if (argv[i + 1] && !argv[i + 1]!.startsWith('-'))
        options.export.push(argv[++i]!);
      continue;
    }
    const boolean = FLAGS[flag];
    if (boolean) {
      if (inline !== undefined)
        throw new UsageError(`${flag} does not take a value`);
      if (boolean === 'no-session') options.run.no_session = true;
      else if (boolean === 'no-context-files')
        options.run.no_context_files = true;
      else if (boolean === 'no-tools') options.run.tools = [];
      else (options as unknown as Record<string, unknown>)[boolean] = true;
      continue;
    }
    const valueKey = VALUES[flag];
    if (valueKey) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`${flag} requires a value`);
      if (valueKey === 'name') options.run.session_name = sessionName(value);
      else if (valueKey === 'models')
        options.run.models = value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
      else if (valueKey === 'system')
        options.run.system_prompt = promptText(value);
      else if (valueKey === 'append')
        options.run.append_system_prompt.push(promptText(value));
      else if (valueKey === 'tools') options.run.tools = toolNames(value);
      else if (valueKey === 'exclude')
        options.run.exclude_tools = toolNames(value);
      else (options as unknown as Record<string, unknown>)[valueKey] = value;
      continue;
    }
    if (raw.startsWith('-')) throw new UsageError(`unknown option: ${raw}`);
    words.push(raw);
  }
  if (!['text', 'json', 'rpc'].includes(options.mode))
    throw new UsageError('--mode must be text, json or rpc');
  if (
    options.thinking &&
    !(EFFORT_LEVELS as readonly string[]).includes(options.thinking)
  )
    throw new UsageError('unknown thinking depth');
  // The words are a folder, @files and messages. The first word
  // is the folder when it is one, or when it has no spaces, so a mistyped folder is an
  // error and not a message; a folder may also come last, after a message.
  const path = (word: string): string => resolve(cwd, expandUser(word));
  const isDir = (word: string): boolean => {
    try {
      return statSync(path(word)).isDirectory();
    } catch {
      return false;
    }
  };
  const isFile = (word: string): boolean =>
    word.startsWith('@') && word.length > 1;
  if (printPrompt && (isDir(printPrompt) || isFile(printPrompt))) {
    // `circle -p ~/code/app` with the prompt piped in, `circle -p @notes.md "summarize"`
    words.unshift(printPrompt);
    printPrompt = '';
  }
  if (options.mode === 'json' && printPrompt === undefined) printPrompt = '';
  options.files = words.filter(isFile).map((word) => word.slice(1));
  const messages = words.filter((word) => !isFile(word));
  if (printPrompt === '' && messages.length && !isDir(messages[0]!))
    printPrompt = messages.shift();
  if (messages.length && (isDir(messages[0]!) || !/\s/.test(messages[0]!)))
    options.workspace = normalizeWorkspace(path(messages.shift()!));
  else if (messages.length > 1 && isDir(messages.at(-1)!))
    options.workspace = normalizeWorkspace(path(messages.pop()!));
  options.prompts = printPrompt ? [printPrompt, ...messages] : messages;
  const problem = conflict(options, printPrompt !== undefined, messages);
  if (problem) throw new UsageError(problem);
  return options;
}
// `-n`: spaces collapsed and cut to 80 characters, as /name does.
function sessionName(value: string): string {
  return Array.from(value.split(/\s+/).filter(Boolean).join(' '))
    .slice(0, 80)
    .join('');
}
// Options that cannot go together, as a message, or ''.
function conflict(
  options: CliOptions,
  prompt: boolean,
  messages: string[],
): string {
  const opening = (
    [
      ['-c', options.continue],
      ['-r', options.resume],
      ['--session', Boolean(options.session)],
    ] as const
  )
    .filter(([, on]) => on)
    .map(([flag]) => flag);
  const words = messages.length > 0 || options.files.length > 0;
  if (options.fork && (opening.length || options.run.no_session))
    return `--fork starts a new conversation; it cannot go with ${opening[0] ?? '--no-session'}`;
  if (options.sessionId && opening.length)
    return `--session-id chooses the conversation; it cannot go with ${opening[0]}`;
  if (options.run.no_session && (opening.length || options.sessionId))
    return '--no-session keeps nothing, so there is nothing to open';
  if (
    options.sessionId &&
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(options.sessionId)
  )
    return "--session-id takes letters, digits, '.', '_' and '-', starting and ending with a letter or digit";
  if (options.line && options.mode !== 'text')
    return `--mode ${options.mode} and --line cannot go together`;
  if (options.mode === 'rpc' && (prompt || words))
    return '--mode rpc takes its prompts as commands on standard input, not as words';
  if (options.mode === 'rpc' && options.resume)
    return '-r opens a list to choose from, so it needs the full-screen interface';
  if (options.resume && (prompt || options.line || options.mode === 'json'))
    return '-r opens a list to choose from, so it needs the full-screen interface; use -c or --session ID with -p and --line.';
  if (options.line && words)
    return '--line reads its messages from standard input, one per line';
  if (options.resume && words)
    return '-r opens a list to choose from; send the message once the session is open';
  return '';
}
const HELP_ROWS: [string, string][] = [
  ['-p, --print [PROMPT]', 'Print the answer and exit'],
  ['--mode text|json|rpc', 'Output mode'],
  ['-c, --continue', 'Continue the last session'],
  ['-r, --resume', 'Choose a saved session'],
  ['--session ID', 'Resume by ID'],
  ['--session-id ID', 'Open or create this ID'],
  ['--fork ID', 'Copy a saved session'],
  ['--no-session', 'In-memory conversation'],
  ['-m, --model ID', 'Model for this run'],
  ['--thinking LEVEL', 'Thinking depth'],
  ['--list-models [TEXT]', 'List endpoint models'],
  ['--export ID [OUT]', 'Export a saved session'],
  ['--system-prompt TEXT|FILE', 'Replace the system prompt'],
  ['--append-system-prompt TEXT|FILE', 'Append to the system prompt'],
  ['--no-context-files', 'Skip instruction files'],
  ['--tools LIST', 'Limit tools'],
  ['--exclude-tools LIST', 'Exclude tools'],
  ['--no-tools', 'No tools except compaction'],
  ['--yolo', 'Auto mode for print or line'],
  ['--trust', 'Trust this folder and remember it'],
  ['--approve-hooks', "Approve this folder's hooks files as they are now"],
  [
    '--extensions',
    'Load extensions and MCP servers in print, line or rpc mode',
  ],
  ['--line', 'Plain line mode'],
  ['--init', 'Model setup'],
  [
    '--task [NAME]',
    "Work in a folder of Circle's own for this task, under the task folder",
  ],
  ['--print-home', 'Print the data directory'],
  ['-v, --version', 'Print version'],
  ['-h, --help', 'Show help'],
];
// Options this wide or narrower share the description column. A longer one has a line of
// its own and its description under that column, so a few long options do not push every
// description to the right.
const HELP_FLAG_WIDTH = 20;
export function helpText(width = process.stdout.columns || 80): string {
  const columns = Math.max(40, width);
  const flagWidth = HELP_FLAG_WIDTH + 2;
  const indent = ' '.repeat(2 + flagWidth);
  const lines = [
    t('usage: circle [options] [folder] [@file ...] [message ...]'),
    '',
    t('A terminal coding agent for your own model endpoint.'),
    '',
  ];
  for (const [flag, description] of HELP_ROWS) {
    if (stringWidth(flag) > HELP_FLAG_WIDTH) {
      lines.push('  ' + flag, ...hangingWrap(indent, t(description), columns));
      continue;
    }
    const prefix = '  ' + pad(flag, flagWidth);
    lines.push(...hangingWrap(prefix, t(description), columns));
  }
  return lines.join('\n') + '\n';
}
// How long `-p PROMPT` waits for piped input to start before going on without it.
const STDIN_WAIT_MS = 3000;
// Piped standard input, or '' when it is a terminal. With `waitMs` the read only starts if
// input (or its end) arrives within that time: a caller that leaves standard input open and
// never writes to it, as some scripts and CI runners do, would otherwise keep `circle -p`
// waiting forever. Without it, the read waits for the end of the input.
export async function pipedText(
  waitMs?: number,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  warn: (text: string) => void = (text) => process.stderr.write(text),
): Promise<string> {
  if (input.isTTY) return '';
  return new Promise((resolveInput, reject) => {
    const chunks: Buffer[] = [];
    const timer =
      waitMs === undefined
        ? undefined
        : setTimeout(() => {
            warn(
              t(
                'circle: nothing arrived on stdin within {seconds}s; going on without it (use </dev/null to skip the wait)\n',
                { seconds: waitMs / 1000 },
              ),
            );
            done(false);
          }, waitMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      input.off('data', data);
      input.off('end', ended);
      input.off('error', fail);
      input.pause();
    };
    const done = (keep: boolean): void => {
      cleanup();
      resolveInput(keep ? Buffer.concat(chunks).toString('utf8') : '');
    };
    const ended = (): void => done(true);
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const data = (chunk: Buffer | string): void => {
      clearTimeout(timer);
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    };
    input.on('data', data);
    input.once('end', ended);
    input.once('error', fail);
    input.resume();
  });
}
// The @files from the command line as text for the first message. A path is looked for in
// the current folder, then in the folder Circle works in. A file that is missing or not text
// is a usage error.
export function fileBlocks(
  names: string[],
  workspace: string,
  cwd = process.cwd(),
): string {
  const blocks: string[] = [];
  for (const name of names) {
    let path = resolve(cwd, expandUser(name));
    if (!existsSync(path)) {
      const inside = resolve(workspace, expandUser(name));
      if (existsSync(inside)) path = inside;
    }
    if (mediaType(path) && existsSync(path)) {
      // An image goes as an attachment, which the harness adds for its mention: a path
      // inside the folder Circle works in, the full path for one elsewhere.
      const full = realpathSync(path);
      const rel = relative(realpathSync(workspace), full);
      blocks.push(
        mention(
          rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
            ? full
            : rel.split(sep).join('/'),
        ),
      );
      continue;
    }
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(readFileSync(path))
        .replace(/\r\n?/g, '\n');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new UsageError(`no such file: ${name}`);
      if (error instanceof TypeError)
        throw new UsageError(`${name} is not a text file`);
      throw new UsageError(
        `cannot read ${name}: ${code === 'EISDIR' ? 'Is a directory' : error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (body.trim())
      blocks.push(`<file path="${name}">\n${body.trimEnd()}\n</file>`);
  }
  return blocks.join('\n\n');
}
// --list-models: the models that contain every word of the search, the current one marked.
async function listModels(search: string, home: string): Promise<number> {
  const settings = loadSettings(home);
  if (!isReady(settings))
    throw new UsageError(
      'Circle is not set up yet. Run `circle` in a terminal first.',
    );
  const credentials = loadCredentials(home);
  const key =
    credentials[settings.auth.api_key_ref] || credentials.api_key || '';
  const found = key
    ? await resolveEndpoint(settings.auth.base_url, key, {
        protocol: settings.auth.protocol,
      })
    : undefined;
  const models = found?.models ?? [];
  if (!models.length)
    throw new Error(`${settings.auth.base_url} did not list its models`);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = models.filter((model) =>
    words.every((word) => model.toLowerCase().includes(word)),
  );
  for (const model of shown)
    process.stdout.write(
      model + (model === settings.auth.model ? '  (current)' : '') + '\n',
    );
  if (!shown.length) throw new Error(`no model matches '${search}'`);
  return 0;
}
// Setup was left unfinished, or the folder was not trusted: exit 1.
class Declined extends Error {}
// Settings for a run without the full-screen interface. When standard input is a terminal,
// setup and the trust question are asked line by line.
async function headlessSettings(
  options: CliOptions,
  home: string,
): Promise<CircleSettings> {
  let settings: CircleSettings;
  try {
    settings = loadSettings(home);
  } catch (error) {
    throw new UsageError(`settings could not be read: ${error}`);
  }
  if (options.init || !isReady(settings)) {
    if (!process.stdin.isTTY)
      throw new UsageError(
        'Circle is not set up yet. Run `circle` in a terminal first.',
      );
    const { runLineInit } = await import('./line_setup.js');
    const done = await runLineInit(home);
    if (!done) throw new Declined();
    settings = done;
  }
  if (
    !existsSync(options.workspace) ||
    !statSync(options.workspace).isDirectory()
  )
    throw new UsageError(`No such folder: ${options.workspace}`);
  if (!isFolderTrusted(settings, options.workspace)) {
    if (options.trust) {
      settings = trustFolder(settings, options.workspace);
      saveSettings(settings, home);
    } else if (!process.stdin.isTTY)
      throw new UsageError(
        t(
          'This folder is not trusted yet: {folder}\nRun `circle` there once in a terminal and trust it, or pass --trust to trust it and remember it.',
          { folder: options.workspace },
        ),
      );
    else {
      const { runLineTrust } = await import('./line_setup.js');
      const trusted = await runLineTrust(settings, options.workspace, home);
      if (!trusted) throw new Declined();
      settings = trusted;
    }
  }
  const { problems } = applyProjectSettings(settings, options.workspace, home);
  for (const problem of problems) process.stderr.write(problem + '\n');
  if (options.model) settings.auth.model = options.model;
  return settings;
}
/**
 * Print, line and rpc mode cannot show the hooks card. `--approve-hooks` approves
 * the waiting files and lists what it approved; otherwise those hooks do not run,
 * and standard error says so once, naming each file and how to approve it.
 */
export function reportProjectHooks(
  runtime: import('./runtime.js').AgentRuntime,
  approve: boolean,
  write: (text: string) => void = (text) => process.stderr.write(text),
): void {
  if (approve)
    for (const change of runtime.pendingHooks()) {
      if (!runtime.approveHooks(change)) continue;
      write(
        t('circle: approved the hooks in {file}', { file: change.file }) + '\n',
      );
      for (const hook of change.hooks)
        if (hook.mark !== 'removed')
          write(`  ${hook.name} · ${hook.event} · ${hook.command}\n`);
    }
  for (const change of runtime.pendingHooks())
    write(
      t(
        'circle: the hooks in {file} were not run: this version of the file is not approved. Approve it with circle in a terminal in this folder, or pass --approve-hooks.',
        { file: change.file },
      ) + '\n',
    );
}
let networkConfigured = false;
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let runtime: import('./runtime.js').AgentRuntime | undefined;
  let offSignals: (() => void) | undefined;
  try {
    // HTTPS_PROXY, NO_PROXY, SSL_CERT_FILE and SSL_CERT_DIR, and trust_cert_files from
    // settings, before the first request (the update check and `circle update` need them too)
    if (!networkConfigured) {
      networkConfigured = true;
      const network = initializeNetwork(circleHome());
      for (const problem of network.problems)
        process.stderr.write(problem + '\n');
      if (network.bundle || network.proxy)
        process.stderr.write(networkSummary(network) + '\n');
    }
    if (argv[0] === 'update') {
      const { updateInstalled } = await import('./update.js');
      return await updateInstalled(argv.slice(1));
    }
    if (argv[0] === 'uninstall') {
      const { uninstallInstalled } = await import('./uninstall.js');
      return await uninstallInstalled(argv.slice(1));
    }
    const options = parseCli(argv);
    if (options.version) {
      process.stdout.write(VERSION + '\n');
      return 0;
    }
    if (options.help) {
      process.stdout.write(helpText());
      return 0;
    }
    const home = circleHome();
    if (options.printHome) {
      process.stdout.write(home + '\n');
      return 0;
    }
    if (options.listModels !== null)
      return await listModels(options.listModels, home);
    if (options.export) {
      const { CheckpointStore } = await import('./checkpoint_store.js');
      const { toHtml, toSessionBundle } = await import('./session_export.js');
      const store = new CheckpointStore(home);
      try {
        const session = store.find(options.export[0]!);
        if (!session) throw new UsageError('unknown session');
        const path = options.export[1] || session.id + '.html';
        const meta = {
          thread_id: session.id,
          title: session.title,
          workspace: session.workspace,
          model: session.model,
        };
        writeFileSync(
          path,
          path.endsWith('.jsonl')
            ? toSessionBundle(store, session.id)
            : toHtml(store.messages(session.id), meta),
        );
        process.stdout.write(path + '\n');
        return 0;
      } finally {
        store.close();
      }
    }

    // --task: work that belongs to no project gets a folder of Circle's own under the
    // task folder, trusted as Circle's own scratch folder is, so nothing has to be
    // answered to start. It never changes where circle works without the flag.
    if (options.task !== undefined) {
      let chosen;
      try {
        chosen = loadSettings(home);
      } catch (error) {
        throw new UsageError(`settings could not be read: ${error}`);
      }
      const folder = taskWorkspace(
        options.task || newTaskName(),
        tasksFolder(chosen.task_folder, home),
      );
      mkdirSync(folder, { recursive: true });
      if (!isFolderTrusted(chosen, folder))
        saveSettings(trustFolder(chosen, folder), home);
      options.workspace = normalizeWorkspace(folder);
    }
    // The flag beats the variable and is never saved.
    if (options.thinking)
      process.env.CIRCLE_REASONING_EFFORT = options.thinking;
    const attached = fileBlocks(options.files, options.workspace);
    const interactive = Boolean(
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      !options.print &&
      !options.line &&
      options.mode === 'text' &&
      !['1', 'true', 'yes'].includes(process.env.CIRCLE_NO_TUI || ''),
    );
    // -p and --mode json print; so do messages or @files given without a terminal.
    const printing =
      options.mode !== 'rpc' &&
      (options.print ||
        options.mode === 'json' ||
        (!interactive &&
          (options.prompts.length > 0 || options.files.length > 0)));
    if (printing) {
      // The prompt, then piped input before it and the @files after it.
      const prompts = [...options.prompts];
      const piped = await pipedText(prompts.length ? STDIN_WAIT_MS : undefined);
      let prompt = prompts.shift() ?? '';
      if (piped.trim())
        prompt = prompt
          ? `${piped.trimEnd()}\n\n${prompt}`.trim()
          : piped.trim();
      if (attached) prompt = `${prompt}\n\n${attached}`.trim();
      if (!prompt.trim())
        throw new UsageError(
          'Nothing to do: give a prompt after -p or pipe one in.',
        );
      options.prompts = [prompt, ...prompts];
    }
    const runtimeOptions = {
      workspace: options.workspace,
      home,
      run: options.run,
      session: options.session || undefined,
      sessionId: options.sessionId || undefined,
      continue: options.continue,
      fork: options.fork || undefined,
      modelOverride: options.model || undefined,
    };
    if (interactive) {
      if (
        !existsSync(options.workspace) ||
        !statSync(options.workspace).isDirectory()
      )
        throw new UsageError(`No such folder: ${options.workspace}`);
      let settings;
      try {
        settings = loadSettings(home);
      } catch (error) {
        throw new UsageError(`settings could not be read: ${error}`);
      }
      // The model gets the @files' text with the first message; the screen shows @path.
      const [first = '', ...rest] = options.prompts;
      const prompts =
        first || attached
          ? [[first, attached].filter(Boolean).join('\n\n'), ...rest]
          : [];
      const shown = [
        [first, ...options.files.map((name) => '@' + name)].join(' ').trim(),
      ];
      const { runTui } = await import('./tui/session_app.js');
      return await runTui({
        ...runtimeOptions,
        settings,
        init: options.init,
        trust: options.trust,
        approveProjectHooks: options.approveHooks,
        pickSession: options.resume,
        prompts,
        shown,
      });
    }
    const settings = await headlessSettings(options, home);
    const { AgentRuntime } = await import('./runtime.js');
    runtime = new AgentRuntime({
      ...runtimeOptions,
      settings,
      headless: true,
      integrations: options.extensions,
    });
    // Asked for: extensions and MCP servers load before the first prompt, as in the
    // full-screen interface; their tools reach the model from the first turn.
    if (options.extensions) await runtime.initialize();
    offSignals = installExitGuard(runtime);
    reportProjectHooks(runtime, options.approveHooks);
    // Only --yolo turns auto on here; without it a saved default_mode stays.
    if (options.yolo) runtime.policy.setYolo(runtime.session.id, true);
    if (options.mode === 'rpc') {
      const { runRpc } = await import('./rpc.js');
      return await runRpc(runtime);
    }
    const { runPrint, runLine } = await import('./headless.js');
    if (printing)
      return await runPrint(runtime, options.prompts, {
        json: options.mode === 'json',
        verbose: options.verbose,
        yolo: options.yolo,
      });
    return await runLine(runtime, {
      verbose: options.verbose,
      yolo: options.yolo,
    });
  } catch (error) {
    // Setup and the trust question have said why already.
    if (!(error instanceof Declined))
      process.stderr.write(
        `✖ ${error instanceof Error ? error.message : String(error)}\n`,
      );
    return error instanceof UsageError ? 2 : 1;
  } finally {
    offSignals?.();
    await runtime?.close();
  }
}
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  process.exitCode = await main();
