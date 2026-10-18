// Deterministic hooks: shell commands Circle runs at fixed points. A decision
// from a hook overrides the approval mode. A hard refusal from the approval
// policy (sudo, or a command that names a credential file) and read-only mode
// are decided before any hook runs, and a hook cannot undo them. A file tool
// still refuses a credential file when it runs, after the hooks.
import { spawn, execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { canonicalPath } from './paths.js';
import { isHostAbsolutePath, shellEnvironment } from './sandbox.js';
import { discoverSkills } from './skills.js';
import { isRecord } from './settings.js';

export const HOOK_EVENTS = [
  'before_tool',
  'after_tool',
  'before_stop',
  'session_start',
  'permission_request',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export type HookSource = 'user' | 'project' | 'skill';
export type HookDecision = 'allow' | 'deny' | 'ask';

/** Shown in the transcript. The hook's own reason is kept as it wrote it. */
export interface HookNotice {
  kind:
    | 'denied'
    | 'asked'
    | 'allowed'
    | 'output'
    | 'blocked'
    | 'limit'
    | 'failed'
    | 'active'
    | 'untrusted';
  tool?: string;
  name?: string;
  reason?: string;
  count?: number;
}

export interface HookDefinition {
  id: string;
  event: HookEvent;
  name: string;
  command: string;
  timeoutMs: number;
  loopLimit: number;
  /** '*' matches every tool. Tool events only; other events ignore it. */
  tools: '*' | string[];
  /** Empty matches every path. A tool call with no path does not match. */
  paths: string[];
  source: HookSource;
  sourceLabel: string;
  file: string;
}

export interface HookLoadError {
  file: string;
  message: string;
}

export interface LoadedHooks {
  hooks: HookDefinition[];
  errors: HookLoadError[];
  /** A project hooks file exists and this folder is not trusted, so it did not load. */
  projectIgnored: boolean;
}

export interface HookOutcome {
  hook: HookDefinition;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  decision: HookDecision | 'none';
  reason: string;
  context: string;
  durationMs: number;
  failed: boolean;
}

export interface HookBatch {
  decision: HookDecision | 'none';
  reason: string;
  context: string;
  outcomes: HookOutcome[];
  notices: HookNotice[];
}

export interface HookRunRequest {
  event: HookEvent;
  sessionId: string;
  cwd: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** Paths the tool named, before canonicalization. */
  paths?: string[];
  toolOutput?: string;
  toolStatus?: 'success' | 'error';
  permissionReason?: string;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_LOOP_LIMIT = 5;
const MAX_LOOP_LIMIT = 20;
const MAX_OUTPUT = 100_000;
const MAX_HOOKS = 100;

const GATING = new Set<HookEvent>([
  'before_tool',
  'permission_request',
  'before_stop',
]);

export function hookNoticeText(notice: HookNotice): string {
  const reason = notice.reason?.replace(/\s+/g, ' ').trim();
  const tail = reason ? ` · ${reason}` : '';
  switch (notice.kind) {
    case 'denied':
      return `hook denied ${notice.tool ?? 'tool'}${tail}`;
    case 'asked':
      return `hook asked ${notice.tool ?? 'tool'}${tail}`;
    case 'allowed':
      return `hook allowed ${notice.tool ?? 'tool'}${tail}`;
    case 'output':
      return `hook ${notice.name ?? 'hook'}${tail}`;
    case 'blocked':
      return `hook blocked stop${tail}`;
    case 'limit':
      return `hook stop limit${notice.name ? ` · ${notice.name}` : ''}`;
    case 'failed':
      return `hook failed${notice.name ? ` · ${notice.name}` : ''}${tail}`;
    case 'active':
      return `hooks active${notice.count !== undefined ? ` · ${notice.count}` : ''}${tail}`;
    case 'untrusted':
      return 'project hooks need trust';
  }
}

/** The line a tool result starts with when a hook decided. The model reads the English. */
export const HOOK_DENIED_LINE = 'Hook denied this call:';
export const HOOK_ASKED_LINE = 'Hook asked before this call:';
export const HOOK_ALLOWED_LINE = 'Hook allowed this call.';
export const HOOK_OUTPUT_LINE = 'Hook output';

export function hookDeniedMessage(reason: string): string {
  return `${HOOK_DENIED_LINE} ${reason}`;
}

/** Paths a tool call names. Unresolved; the matcher canonicalizes them. */
export function hookToolPaths(
  _tool: string,
  args: Record<string, unknown>,
): string[] {
  const raw: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) raw.push(value.trim());
  };
  push(args.file_path);
  push(args.path);
  push(args.file);
  if (Array.isArray(args.paths)) for (const path of args.paths) push(path);
  const patch = args.patchText ?? args.patch;
  if (typeof patch === 'string') {
    for (const line of patch.split(/\r?\n/)) {
      const match =
        /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(
          line,
        );
      if (match?.[1]) raw.push(match[1].trim());
    }
  }
  return [...new Set(raw)];
}

export interface HookPathOptions {
  workspace: string;
  platform?: NodeJS.Platform;
  /** Defaults to canonicalPath. Tests of Windows paths pass their own. */
  canonicalize?: (path: string) => string;
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

/** Forward slashes, no trailing slash. Windows paths are compared case-insensitively. */
export function normalizeHookPath(
  path: string,
  platform: NodeJS.Platform,
): string {
  const api = pathApi(platform);
  let text = api.normalize(path).replace(/\\/g, '/');
  if (platform === 'win32') text = text.toLowerCase();
  if (text.length > 1) text = text.replace(/\/+$/, '');
  return text;
}

function globRegExp(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
      continue;
    }
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function underWorkspace(file: string, workspace: string): string | undefined {
  if (file === workspace) return '';
  const prefix = workspace.endsWith('/') ? workspace : `${workspace}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : undefined;
}

/**
 * Whether a tool path matches a glob. The file and an absolute pattern are
 * canonicalized first, so a symlink and its target match the same glob.
 * Relative globs match the path relative to the workspace. `*` stays inside
 * one segment; `**` crosses segments. Matching is case-sensitive except on
 * Windows.
 */
export function matchHookPath(
  filePath: string,
  pattern: string,
  options: HookPathOptions,
): boolean {
  const platform = options.platform ?? process.platform;
  const canonicalize = options.canonicalize ?? canonicalPath;
  let file: string;
  try {
    const absolute = isHostAbsolutePath(filePath, platform)
      ? filePath
      : pathApi(platform).resolve(options.workspace, filePath);
    file = normalizeHookPath(canonicalize(absolute), platform);
  } catch {
    return false;
  }
  const workspace = normalizeHookPath(
    canonicalize(options.workspace),
    platform,
  );
  const rawPattern = pattern.trim().replace(/\\/g, '/');
  if (!rawPattern) return false;
  const absolutePattern = isHostAbsolutePath(rawPattern, platform);
  let target: string | undefined;
  let glob: string;
  if (absolutePattern) {
    const globAt = rawPattern.search(/[*?]/);
    if (globAt < 0) {
      try {
        glob = normalizeHookPath(canonicalize(rawPattern), platform);
      } catch {
        glob = normalizeHookPath(rawPattern, platform);
      }
    } else {
      const slash = rawPattern.lastIndexOf('/', globAt);
      const prefix = slash > 0 ? rawPattern.slice(0, slash) : '';
      const rest = slash > 0 ? rawPattern.slice(slash + 1) : rawPattern;
      let rooted = rawPattern;
      if (prefix) {
        try {
          rooted = `${normalizeHookPath(canonicalize(prefix), platform)}/${rest}`;
        } catch {
          rooted = normalizeHookPath(rawPattern, platform);
        }
      }
      glob = normalizeHookPath(rooted, platform);
    }
    target = file;
  } else {
    glob = normalizeHookPath(rawPattern, platform);
    target = underWorkspace(file, workspace);
  }
  if (target === undefined) return false;
  return globRegExp(glob).test(target);
}

function toolMatches(hook: HookDefinition, tool: string | undefined): boolean {
  if (hook.event === 'session_start' || hook.event === 'before_stop')
    return true;
  if (!tool) return hook.tools === '*';
  if (hook.tools === '*') return true;
  return hook.tools.includes(tool);
}

function pathsMatch(
  hook: HookDefinition,
  paths: string[] | undefined,
  options: HookPathOptions,
): boolean {
  if (hook.event === 'session_start' || hook.event === 'before_stop')
    return true;
  if (!hook.paths.length) return true;
  if (!paths?.length) return false;
  return paths.some((file) =>
    hook.paths.some((pattern) => matchHookPath(file, pattern, options)),
  );
}

function clampTimeout(value: unknown): number {
  const number = typeof value === 'number' ? value : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(number)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(number)));
}

function clampLoop(value: unknown): number {
  const number = typeof value === 'number' ? value : DEFAULT_LOOP_LIMIT;
  if (!Number.isFinite(number)) return DEFAULT_LOOP_LIMIT;
  return Math.min(MAX_LOOP_LIMIT, Math.max(1, Math.floor(number)));
}

function hookName(value: unknown, command: string): string {
  const named = typeof value === 'string' ? value.trim() : '';
  const text = (named || command.trim()).replace(/\s+/g, ' ');
  return text.slice(0, 80) || 'hook';
}

function toolMatcher(value: unknown): '*' | string[] {
  if (value === undefined || value === '*' || value === '') return '*';
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[|,]/)
      : [];
  const names = parts
    .map((part) => String(part).trim())
    .filter((part) => part && part !== '*');
  return names.length ? names : '*';
}

function pathMatcher(value: unknown): string[] {
  if (value === undefined) return [];
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim())
    .filter(Boolean);
}

function readHookFile(
  file: string,
  source: HookSource,
  sourceLabel: string,
): { hooks: HookDefinition[]; error?: HookLoadError } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      hooks: [],
      error: {
        file,
        message: `hooks could not be read: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (!isRecord(raw))
    return {
      hooks: [],
      error: { file, message: 'hooks file must be a JSON object' },
    };
  if (raw.version !== undefined && raw.version !== 1)
    return {
      hooks: [],
      error: {
        file,
        message: `hooks version ${String(raw.version)} is not supported`,
      },
    };
  const events = isRecord(raw.hooks) ? raw.hooks : {};
  const hooks: HookDefinition[] = [];
  const problems: string[] = [];
  let dropped = false;
  for (const event of HOOK_EVENTS) {
    const list = events[event];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      problems.push(`${event} must be a list`);
      continue;
    }
    list.forEach((entry, index) => {
      if (hooks.length >= MAX_HOOKS) {
        dropped = true;
        return;
      }
      if (
        !isRecord(entry) ||
        typeof entry.command !== 'string' ||
        !entry.command.trim()
      ) {
        problems.push(`${event}[${index}] needs a command`);
        return;
      }
      if (entry.command.length > 4000 || entry.command.includes('\0')) {
        problems.push(`${event}[${index}] command is not usable`);
        return;
      }
      hooks.push({
        id: `${source}:${file}:${event}:${index}`,
        event,
        name: hookName(entry.name, entry.command),
        command: entry.command,
        timeoutMs: clampTimeout(entry.timeout_ms),
        loopLimit: clampLoop(entry.loop_limit),
        tools: toolMatcher(entry.tools ?? entry.matcher),
        paths: pathMatcher(entry.paths),
        source,
        sourceLabel,
        file,
      });
    });
  }
  if (dropped) problems.push('at most 100 hooks are loaded');
  for (const key of Object.keys(events))
    if (!(HOOK_EVENTS as readonly string[]).includes(key))
      problems.push(`unknown hook event ${key}`);
  return {
    hooks,
    ...(problems.length
      ? { error: { file, message: problems.join('; ') } }
      : {}),
  };
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function loadHooks(options: {
  workspace: string;
  home: string;
  trusted: boolean;
  userHome?: string;
}): LoadedHooks {
  const hooks: HookDefinition[] = [];
  const errors: HookLoadError[] = [];
  const take = (file: string, source: HookSource, label: string) => {
    if (!fileExists(file)) return;
    const read = readHookFile(file, source, label);
    hooks.push(...read.hooks);
    if (read.error) errors.push(read.error);
  };
  take(join(options.home, 'hooks.json'), 'user', 'user');
  let projectIgnored = false;
  const projectFile = join(options.workspace, '.circle', 'hooks.json');
  if (!options.trusted && fileExists(projectFile)) projectIgnored = true;
  else if (options.trusted) take(projectFile, 'project', 'project');
  let skills: ReturnType<typeof discoverSkills> = [];
  try {
    skills = discoverSkills(options.workspace, options.home, options.userHome);
  } catch {
    skills = [];
  }
  for (const skill of skills) {
    const projectSkill = skill.source_label.startsWith('Project');
    const file = join(dirname(skill.path), 'hooks.json');
    if (!fileExists(file)) continue;
    if (projectSkill && !options.trusted) {
      projectIgnored = true;
      continue;
    }
    take(file, 'skill', `skill:${skill.name}`);
  }
  return { hooks, errors, projectIgnored };
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function interpretOutput(
  event: HookEvent,
  exitCode: number | null,
  stdout: string,
  stderr: string,
  timedOut: boolean,
  spawnError?: string,
): Pick<HookOutcome, 'decision' | 'reason' | 'context' | 'failed'> {
  const gating = GATING.has(event);
  const fail = (reason: string) =>
    gating
      ? { decision: 'deny' as const, reason, context: '', failed: true }
      : { decision: 'none' as const, reason, context: reason, failed: true };
  if (timedOut) return fail('hook timed out');
  if (spawnError) return fail(spawnError);
  let parsed: Record<string, unknown> | undefined;
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (isRecord(value)) parsed = value;
    } catch {
      parsed = undefined;
    }
  }
  const named = textField(parsed?.decision);
  const decision = (['allow', 'deny', 'ask'] as const).find(
    (item) => item === named,
  );
  const reason = textField(parsed?.reason) || stderr.trim().slice(0, 2000);
  const context =
    textField(parsed?.context) ||
    textField(parsed?.additional_context) ||
    (parsed ? '' : trimmed.slice(0, MAX_OUTPUT));
  if (exitCode === 2) {
    const block = reason || context || 'hook denied';
    return { decision: 'deny', reason: block, context, failed: false };
  }
  if (exitCode !== 0) {
    const problem = reason || context || `hook exited ${exitCode ?? 'unknown'}`;
    return fail(problem);
  }
  if (gating && decision) {
    if (event === 'before_stop' && decision === 'ask')
      return {
        decision: 'deny',
        reason: reason || context || 'hook blocked stop',
        context,
        failed: false,
      };
    return {
      decision,
      reason: reason || (decision === 'deny' ? 'hook denied' : ''),
      context,
      failed: false,
    };
  }
  return { decision: 'none', reason: '', context, failed: false };
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n… hook output truncated`;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

function runHookCommand(
  command: string,
  cwd: string,
  stdin: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, {
        cwd,
        env: shellEnvironment(),
        shell: true,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const take = (into: 'out' | 'err') => (chunk: Buffer) => {
      const next = chunk.toString('utf8');
      if (into === 'out') stdout = clip(stdout + next);
      else stderr = clip(stderr + next);
    };
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));
    try {
      child.stdin?.end(stdin);
    } catch {
      /* The command can ignore stdin. */
    }
    let escalation: NodeJS.Timeout | undefined;
    let windowsKill: Promise<void> | undefined;
    const kill = (force: boolean) => {
      if (!child.pid) return;
      if (process.platform === 'win32')
        windowsKill ??= new Promise((done) =>
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () =>
            done(),
          ),
        );
      else
        try {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          try {
            child.kill(force ? 'SIGKILL' : 'SIGTERM');
          } catch {
            /* Already gone. */
          }
        }
    };
    const stop = (timeout: boolean) => {
      timedOut = timedOut || timeout;
      kill(false);
      escalation = setTimeout(() => kill(true), 500);
    };
    const timer = setTimeout(() => stop(true), timeoutMs);
    const onAbort = () => stop(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener('abort', onAbort);
      finish({
        stdout,
        stderr,
        exitCode: null,
        timedOut,
        error: error.message,
      });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener('abort', onAbort);
      void Promise.resolve(windowsKill).finally(() =>
        finish({
          stdout,
          stderr,
          exitCode: code,
          timedOut,
          ...(signal?.aborted ? { error: 'hook stopped' } : {}),
        }),
      );
    });
  });
}

function noticeFor(
  outcome: HookOutcome,
  tool?: string,
): HookNotice | undefined {
  if (outcome.decision === 'deny' && outcome.hook.event !== 'before_stop')
    return {
      kind: 'denied',
      tool,
      name: outcome.hook.name,
      reason: outcome.reason,
    };
  if (outcome.decision === 'ask')
    return {
      kind: 'asked',
      tool,
      name: outcome.hook.name,
      reason: outcome.reason,
    };
  if (outcome.decision === 'allow')
    return {
      kind: 'allowed',
      tool,
      name: outcome.hook.name,
      reason: outcome.reason,
    };
  if (outcome.failed)
    return {
      kind: 'failed',
      tool,
      name: outcome.hook.name,
      reason: outcome.reason,
    };
  if (outcome.context && outcome.hook.event !== 'before_tool')
    return {
      kind: 'output',
      tool,
      name: outcome.hook.name,
      reason: outcome.context.split('\n')[0]?.slice(0, 200),
    };
  return undefined;
}

function strictest(outcomes: HookOutcome[]): {
  decision: HookDecision | 'none';
  reason: string;
} {
  const denies = outcomes.filter((item) => item.decision === 'deny');
  if (denies.length)
    return {
      decision: 'deny',
      reason: denies
        .map((item) => item.reason)
        .filter(Boolean)
        .join('\n'),
    };
  const asks = outcomes.filter((item) => item.decision === 'ask');
  if (asks.length)
    return {
      decision: 'ask',
      reason: asks
        .map((item) => item.reason)
        .filter(Boolean)
        .join('\n'),
    };
  const allows = outcomes.filter((item) => item.decision === 'allow');
  if (allows.length)
    return {
      decision: 'allow',
      reason: allows
        .map((item) => item.reason)
        .filter(Boolean)
        .join('\n'),
    };
  return { decision: 'none', reason: '' };
}

export class HookRunner {
  /** How many times each before_stop hook has blocked this session. */
  private blocks = new Map<string, number>();
  private limited = new Set<string>();
  constructor(
    readonly loaded: LoadedHooks,
    private readonly options: {
      workspace: string;
      home: string;
      platform?: NodeJS.Platform;
      canonicalize?: (path: string) => string;
      /** Tests can run a command without a shell. */
      run?: typeof runHookCommand;
    },
  ) {}

  active(): HookDefinition[] {
    return this.loaded.hooks;
  }

  async run(request: HookRunRequest): Promise<HookBatch> {
    const pathOptions: HookPathOptions = {
      workspace: this.options.workspace,
      platform: this.options.platform,
      canonicalize: this.options.canonicalize,
    };
    const outcomes: HookOutcome[] = [];
    const notices: HookNotice[] = [];
    for (const hook of this.loaded.hooks) {
      if (hook.event !== request.event) continue;
      if (!toolMatches(hook, request.toolName)) continue;
      if (!pathsMatch(hook, request.paths, pathOptions)) continue;
      if (request.event === 'before_stop') {
        const blocked = this.blocks.get(hook.id) ?? 0;
        if (blocked >= hook.loopLimit) {
          if (!this.limited.has(hook.id)) {
            this.limited.add(hook.id);
            notices.push({ kind: 'limit', name: hook.name });
          }
          continue;
        }
      }
      const started = Date.now();
      const canonicalPaths = (request.paths ?? []).map((file) => {
        try {
          const absolute = isHostAbsolutePath(
            file,
            this.options.platform ?? process.platform,
          )
            ? file
            : pathApi(this.options.platform ?? process.platform).resolve(
                request.cwd,
                file,
              );
          return (this.options.canonicalize ?? canonicalPath)(absolute);
        } catch {
          return file;
        }
      });
      const stdin = JSON.stringify({
        event: request.event,
        session_id: request.sessionId,
        cwd: request.cwd,
        hook: hook.name,
        source: hook.source,
        source_label: hook.sourceLabel,
        tool_name: request.toolName,
        tool_input: request.toolInput,
        paths: canonicalPaths,
        tool_output: request.toolOutput,
        tool_status: request.toolStatus,
        permission_reason: request.permissionReason,
        ...(request.event === 'before_stop'
          ? { stop_attempt: (this.blocks.get(hook.id) ?? 0) + 1 }
          : {}),
      });
      const run = this.options.run ?? runHookCommand;
      let command: CommandResult;
      try {
        command = await run(
          hook.command,
          request.cwd,
          stdin,
          hook.timeoutMs,
          request.signal ?? new AbortController().signal,
        );
      } catch (error) {
        command = {
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (request.signal?.aborted && !command.timedOut) {
        outcomes.push({
          hook,
          exitCode: command.exitCode,
          timedOut: false,
          stdout: command.stdout,
          stderr: command.stderr,
          decision: 'none',
          reason: 'hook stopped',
          context: '',
          durationMs: Date.now() - started,
          failed: false,
        });
        break;
      }
      const interpreted = interpretOutput(
        request.event,
        command.exitCode,
        command.stdout,
        command.stderr,
        command.timedOut,
        command.error,
      );
      const outcome: HookOutcome = {
        hook,
        exitCode: command.exitCode,
        timedOut: command.timedOut,
        stdout: command.stdout,
        stderr: command.stderr,
        ...interpreted,
        durationMs: Date.now() - started,
      };
      outcomes.push(outcome);
      this.log(request, outcome);
      if (
        request.event === 'before_stop' &&
        outcome.decision === 'deny' &&
        !request.signal?.aborted
      )
        this.blocks.set(hook.id, (this.blocks.get(hook.id) ?? 0) + 1);
      const notice = noticeFor(outcome, request.toolName);
      if (notice) notices.push(notice);
    }
    const decision = strictest(
      request.event === 'after_tool' || request.event === 'session_start'
        ? []
        : outcomes,
    );
    const context = outcomes
      .map((item) => item.context)
      .filter(Boolean)
      .join('\n\n');
    return { ...decision, context, outcomes, notices };
  }

  private log(request: HookRunRequest, outcome: HookOutcome): void {
    const line = {
      ts: new Date().toISOString(),
      session_id: request.sessionId,
      event: request.event,
      source: outcome.hook.source,
      source_label: outcome.hook.sourceLabel,
      name: outcome.hook.name,
      command: outcome.hook.command,
      tool: request.toolName,
      exit_code: outcome.exitCode,
      decision: outcome.decision,
      timed_out: outcome.timedOut,
      failed: outcome.failed,
      duration_ms: outcome.durationMs,
      reason: outcome.reason.slice(0, 500),
    };
    try {
      if (!existsSync(this.options.home)) return;
      appendFileSync(
        join(this.options.home, 'hooks.log'),
        `${JSON.stringify(line)}\n`,
      );
    } catch {
      /* A log line cannot stop the hook. */
    }
  }
}

export function activeHookSummary(hooks: HookDefinition[]): string {
  return hooks
    .map((hook) => `${hook.name} (${hook.event}, ${hook.sourceLabel})`)
    .join(', ');
}

/** Basename for a notice, without turning the whole path into the label. */
export function hookFileLabel(file: string): string {
  return basename(file);
}
