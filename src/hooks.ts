// Hooks: commands Circle runs at fixed points of a session. The matching hooks of an event run side by side; each gets
// the event as JSON on standard input and answers with its exit code and standard output. A hook that fails lets the
// action go ahead unless it says `onFailure: "block"`. A hard refusal from the approval policy and read-only mode are
// decided before any hook runs, and no hook can undo them.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  isAbsolute,
  join,
  posix,
  relative,
  sep,
  win32,
} from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { commandSegments } from './approvals.js';
import { matchPattern } from './file_patterns.js';
import { verifyInstalled } from './local_skills.js';
import { canonicalPath } from './paths.js';
import { killProcessTree } from './process_group.js';
import { redactSecrets } from './secrets.js';
import {
  identityEnvironment,
  isHostAbsolutePath,
  shellEnvironment,
} from './sandbox.js';
import { isRecord } from './settings.js';
import {
  NO_MATCHER,
  TOOL_EVENTS,
  matcherMatches,
  type HookDefinition,
  type HookEvent,
  type LoadedHooks,
} from './hook_config.js';

export {
  HOOK_EVENTS,
  TOOL_EVENTS,
  compileMatcher,
  loadHooks,
  parseCondition,
  parseHooks,
  skillFrontmatterHooks,
  type HookDefinition,
  type HookEvent,
  type HookLoadError,
  type HookSource,
  type LoadedHooks,
} from './hook_config.js';
export { HOOK_ALLOWED_LINE, HOOK_CHANGED_LINE } from './hook_display.js';

/** Shown in the transcript. The hook's own words are kept as it wrote them. */
export interface HookNotice {
  kind:
    | 'denied'
    | 'asked'
    | 'allowed'
    | 'output'
    | 'message'
    | 'blocked'
    | 'stopped'
    | 'limit'
    | 'failed'
    | 'active'
    | 'untrusted';
  tool?: string;
  name?: string;
  reason?: string;
  /** What the person reads in place of `reason`: the hook's `systemMessage`. It never reaches the model. */
  message?: string;
  count?: number;
}

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
    case 'message':
      return `hook ${notice.name ?? 'hook'}${tail}`;
    case 'blocked':
      return `hook blocked ${notice.tool ?? 'stop'}${tail}`;
    case 'stopped':
      return `hook stopped the turn${tail}`;
    case 'limit':
      return `hook stop limit${notice.name ? ` · ${notice.name}` : ''}`;
    case 'failed':
      return `hook failed${notice.name ? ` · ${notice.name}` : ''}${tail}`;
    case 'active':
      return `hooks active${notice.count !== undefined ? ` · ${notice.count}` : ''}${tail}`;
    case 'untrusted':
      return 'project hooks need a trusted folder';
  }
}

/** The line a tool result starts with when a hook decided. The model reads the English. */
export const HOOK_DENIED_LINE = 'Hook denied this call:';
export const HOOK_ASKED_LINE = 'Hook asked before this call:';
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
 * Whether a tool path matches a glob. The file and an absolute pattern are canonicalized first, so a symlink and its
 * target match the same glob. Relative globs match the path relative to the workspace. `*` stays inside one
 * segment; `**` crosses segments. Matching is case-sensitive except on Windows.
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

/** JSON with every object's keys in order: two values that differ only in key order are the same input. */
export function canonicalJson(value: unknown): string {
  const sorted = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sorted)
      : isRecord(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sorted(item[key])]),
          )
        : item;
  return JSON.stringify(sorted(value)) ?? '';
}

/** A value as a hook sees it: each saved secret's value written back as `%NAME%`. */
export function redactHookValue(
  value: unknown,
  secrets: Record<string, string>,
): unknown {
  if (!Object.keys(secrets).length) return value;
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value))
    return value.map((item) => redactHookValue(item, secrets));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactHookValue(item, secrets),
      ]),
    );
  return value;
}

/** The variables a hook finds its project, and a pack's or a skill's hook its folders, by. */
export const PROJECT_DIR_VARIABLE = 'CIRCLE_PROJECT_DIR';
export const SKILL_DIR_VARIABLE = 'CIRCLE_SKILL_DIR';
export const SKILL_DATA_VARIABLE = 'CIRCLE_SKILL_DATA';
const PLACEHOLDERS = [
  PROJECT_DIR_VARIABLE,
  SKILL_DIR_VARIABLE,
  SKILL_DATA_VARIABLE,
] as const;

/** The permission mode a hook is told, in the words hooks elsewhere use. */
export function hookPermissionMode(
  mode: string | undefined,
  readOnly = false,
): string | undefined {
  if (readOnly || mode === 'plan') return 'plan';
  if (mode === 'manual') return 'default';
  if (mode === 'accept-edits') return 'acceptEdits';
  if (mode === 'auto') return 'bypassPermissions';
  return undefined;
}

/** How many times in a row Stop hooks can send a turn back to work. */
export function stopHookCap(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.CIRCLE_STOP_HOOK_BLOCK_CAP);
  return Number.isInteger(value) && value > 0 ? value : 8;
}

function defaultTimeoutMs(event: HookEvent): number {
  if (event === 'UserPromptSubmit') return 30_000;
  if (event === 'SessionEnd') {
    const value = Number(process.env.CIRCLE_SESSIONEND_HOOKS_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : 1_500;
  }
  return 600_000;
}

const MAX_OUTPUT = 100_000;
/** A hook's text for the model or the person, each string on its own. */
const MAX_TEXT = 10_000;

function clip(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… hook output truncated`;
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  ).slice(0, 500);
}

/** A file a hook gets beside its JSON, named in the JSON's `files`. */
export interface HookFile {
  kind: 'screenshot';
  path: string;
  mime_type: 'image/png';
  sha256: string;
  size: number;
}

export interface HookRunRequest {
  event: HookEvent;
  /** The conversation's session. In a subagent, `agent` names the agent the call came from. */
  sessionId: string;
  agent?: { id: string; type: string };
  cwd: string;
  /** `default`, `acceptEdits`, `plan` or `bypassPermissions`. */
  permissionMode?: string;
  /** What the matcher of an event that is not about a tool is tested against: a source, a reason, a type. */
  matchValue?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  /** Paths the tool named, before canonicalization. */
  paths?: string[];
  /** The event's own fields, under the names hooks get them. */
  fields?: Record<string, unknown>;
  /** Saved secrets. Their values are written as %NAME% before the hook sees them. */
  secrets?: Record<string, string>;
  /** Run only these hook ids. Used when a skill is loaded after the session started. */
  onlyIds?: string[];
  /** A PNG of the page the conversation's browser shows, taken once, when a hook that runs asks for one. */
  screenshot?: (signal: AbortSignal) => Promise<Buffer | undefined>;
  signal?: AbortSignal;
}

/** What a hook's JSON said, in one shape for every event. */
export interface HookAnswer {
  continue?: boolean;
  stopReason?: string;
  systemMessage?: string;
  /** Top-level `decision: "block"`. */
  block?: boolean;
  reason?: string;
  permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer';
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  /** PermissionRequest's `decision`. */
  permission?: {
    behavior: 'allow' | 'deny';
    updatedInput?: Record<string, unknown>;
    message?: string;
    interrupt?: boolean;
  };
  updatedToolOutput?: unknown;
  sessionTitle?: string;
  suppressOriginalPrompt?: boolean;
}

export interface HookOutcome {
  hook: HookDefinition;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Did not start, timed out, exited other than 0 or 2 without a JSON answer, or answered with unreadable output. */
  failed: boolean;
  /** Why it failed, in a line. */
  cause: string;
  /** Exit 2, or a failure of a hook that blocks on failure. */
  blocking: boolean;
  /** What a blocking exit says: its standard error. */
  blockText: string;
  answer?: HookAnswer;
  /** Exit 0 with text that is not a JSON object. */
  plain: string;
  /** It answered with fields of the format before this one. */
  legacy: boolean;
  /** Stopped with the turn (esc), before it answered. */
  stopped: boolean;
}

export interface HookBatch {
  outcomes: HookOutcome[];
  notices: HookNotice[];
  /** PreToolUse and PermissionRequest: what the hooks decided about the call. */
  decision: 'allow' | 'deny' | 'ask' | 'none';
  /** The reasons of the hooks that decided or blocked, one per line. */
  reason: string;
  /** What the hooks said to the person (`systemMessage`), one per line. */
  userMessage: string;
  /** UserPromptSubmit, Stop, SubagentStop, PreCompact and the tool results: a hook blocked. */
  blocked: boolean;
  /** The input the call runs with instead. */
  updatedInput?: Record<string, unknown>;
  /** The hooks whose rewrite that is. */
  changedBy: string[];
  /** Hooks that each rewrote the call differently: it does not run in any of their forms. */
  conflict: string[];
  /** For the model: every `additionalContext`, and the plain output of the events whose plain output it reads. */
  context: string;
  /** A hook said `continue: false`: the turn ends. */
  stop?: { reason: string };
  updatedToolOutput?: string;
  sessionTitle?: string;
  suppressOriginalPrompt: boolean;
  /** PermissionRequest: a deny that also ends the turn. */
  interrupt: boolean;
}

/** Events whose plain standard output reaches the model. */
const PLAIN_FOR_MODEL = new Set<HookEvent>([
  'UserPromptSubmit',
  'SessionStart',
  'PreCompact',
]);
/** Whether a hook's plain output reaches the model: the format before this one fed it back after a tool too. */
function plainForModel(event: HookEvent, hook: HookDefinition): boolean {
  return (
    PLAIN_FOR_MODEL.has(event) ||
    (hook.legacy === true &&
      (event === 'PostToolUse' || event === 'SubagentStart'))
  );
}
/** Events whose `systemMessage` and `continue` are not used. */
const QUIET = new Set<HookEvent>([
  'Notification',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
]);
/** Events a blocking exit stops. */
const CAN_BLOCK = new Set<HookEvent>([
  'PreToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
]);
/** Events that read a top-level `decision: "block"`. */
const BLOCK_FIELD = new Set<HookEvent>([
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStop',
  'PreCompact',
]);

type Reading =
  | { answer?: HookAnswer; plain: string; legacy: boolean; invalid?: never }
  | { invalid: string };

function readText(
  value: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const item = value[key];
  if (item === undefined || item === null) return undefined;
  return typeof item === 'string' ? item : null;
}

/** A hook's JSON, checked: a field of the wrong type makes the whole answer unreadable. */
export function readHookAnswer(
  event: HookEvent,
  value: Record<string, unknown>,
): { answer: HookAnswer; legacy: boolean } | { invalid: string } {
  const answer: HookAnswer = {};
  let legacy = false;
  const text = (
    from: Record<string, unknown>,
    key: string,
    where = key,
  ): string | undefined => {
    const read = readText(from, key);
    if (read === null) throw new Error(`${where} must be text`);
    return read;
  };
  try {
    if (value.continue != null) {
      if (typeof value.continue !== 'boolean')
        throw new Error('continue must be true or false');
      answer.continue = value.continue;
    }
    answer.stopReason = text(value, 'stopReason');
    answer.systemMessage = text(value, 'systemMessage');
    if (
      value.suppressOutput != null &&
      typeof value.suppressOutput !== 'boolean'
    )
      throw new Error('suppressOutput must be true or false');
    text(value, 'terminalSequence');
    answer.reason = text(value, 'reason');
    const specific = value.hookSpecificOutput;
    if (specific != null) {
      if (!isRecord(specific))
        throw new Error('hookSpecificOutput must be an object');
      if (specific.hookEventName !== event)
        throw new Error(`hookSpecificOutput.hookEventName must be "${event}"`);
      answer.additionalContext = text(
        specific,
        'additionalContext',
        'hookSpecificOutput.additionalContext',
      );
      if (event === 'PreToolUse') {
        const decision = specific.permissionDecision;
        if (decision != null) {
          if (
            decision !== 'allow' &&
            decision !== 'deny' &&
            decision !== 'ask' &&
            decision !== 'defer'
          )
            throw new Error(
              'permissionDecision must be "allow", "deny", "ask" or "defer"',
            );
          answer.permissionDecision = decision;
        }
        answer.permissionDecisionReason = text(
          specific,
          'permissionDecisionReason',
          'hookSpecificOutput.permissionDecisionReason',
        );
        if (specific.updatedInput != null) {
          if (!isRecord(specific.updatedInput))
            throw new Error('updatedInput must be an object');
          answer.updatedInput = specific.updatedInput;
        }
      }
      if (event === 'PermissionRequest' && specific.decision != null) {
        const decision = specific.decision;
        if (
          !isRecord(decision) ||
          (decision.behavior !== 'allow' && decision.behavior !== 'deny')
        )
          throw new Error(
            'decision must be an object whose behavior is "allow" or "deny"',
          );
        if (
          decision.updatedInput !== undefined &&
          !isRecord(decision.updatedInput)
        )
          throw new Error('decision.updatedInput must be an object');
        if (
          decision.interrupt !== undefined &&
          typeof decision.interrupt !== 'boolean'
        )
          throw new Error('decision.interrupt must be true or false');
        const message = text(decision, 'message', 'decision.message');
        answer.permission = {
          behavior: decision.behavior,
          ...(isRecord(decision.updatedInput)
            ? { updatedInput: decision.updatedInput }
            : {}),
          ...(message ? { message } : {}),
          ...(decision.interrupt === true ? { interrupt: true } : {}),
        };
      }
      if (event === 'PostToolUse') {
        if (specific.updatedToolOutput !== undefined)
          answer.updatedToolOutput = specific.updatedToolOutput;
        else if (specific.updatedMCPToolOutput !== undefined)
          answer.updatedToolOutput = specific.updatedMCPToolOutput;
      }
      if (event === 'UserPromptSubmit' || event === 'SessionStart')
        answer.sessionTitle = text(
          specific,
          'sessionTitle',
          'hookSpecificOutput.sessionTitle',
        );
      if (event === 'UserPromptSubmit') {
        if (
          specific.suppressOriginalPrompt !== undefined &&
          typeof specific.suppressOriginalPrompt !== 'boolean'
        )
          throw new Error('suppressOriginalPrompt must be true or false');
        answer.suppressOriginalPrompt =
          specific.suppressOriginalPrompt === true;
      }
    }
    const decision = value.decision;
    if (decision != null) {
      if (typeof decision !== 'string')
        throw new Error('decision must be text');
      if (event === 'PreToolUse' || event === 'PermissionRequest') {
        // The top-level form these events used before `hookSpecificOutput`
        const mapped =
          decision === 'allow' || decision === 'approve'
            ? 'allow'
            : decision === 'deny' || decision === 'block'
              ? 'deny'
              : decision === 'ask'
                ? 'ask'
                : undefined;
        if (!mapped)
          throw new Error('decision must be "allow", "deny" or "ask"');
        legacy = true;
        if (event === 'PreToolUse') {
          answer.permissionDecision ??= mapped;
          answer.permissionDecisionReason ??= answer.reason;
        } else if (!answer.permission && mapped !== 'ask')
          answer.permission = {
            behavior: mapped,
            ...(answer.reason ? { message: answer.reason } : {}),
          };
      } else if (decision === 'block') answer.block = true;
      else if (decision === 'deny' || decision === 'ask') {
        legacy = true;
        if (event === 'Stop' || event === 'SubagentStop') answer.block = true;
      } else if (decision === 'allow') legacy = true;
      else throw new Error('decision must be "block"');
    }
    // Fields of the format before this one, read so a hook not yet rewritten does not lose its effect
    if (value.updated_input !== undefined) {
      legacy = true;
      if (!isRecord(value.updated_input))
        throw new Error('updated_input must be an object');
      if (event === 'PreToolUse') answer.updatedInput ??= value.updated_input;
    }
    for (const key of ['context', 'additional_context']) {
      const old = text(value, key);
      if (old === undefined) continue;
      legacy = true;
      answer.additionalContext ??= old;
    }
    const message = text(value, 'user_message');
    if (message !== undefined) {
      legacy = true;
      answer.systemMessage ??= message;
    }
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error) };
  }
  for (const key of Object.keys(answer) as (keyof HookAnswer)[])
    if (answer[key] === undefined) delete answer[key];
  return { answer, legacy };
}

function readOutput(event: HookEvent, stdout: string): Reading {
  const text = stdout.trim();
  if (!text) return { plain: '', legacy: false };
  if (!text.startsWith('{')) return { plain: text, legacy: false };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      invalid: `output is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(value)) return { invalid: 'output is not a JSON object' };
  const read = readHookAnswer(event, value);
  if ('invalid' in read) return { invalid: read.invalid };
  return { answer: read.answer, plain: '', legacy: read.legacy };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  /** The hook's process ended and something it started kept its output open: what was read may be cut. */
  suspect?: boolean;
}

/** How long a hook's output is read after its own process ends. */
const CLOSE_GRACE_MS = 10_000;
/** The longest a timer can wait. */
const MAX_TIMER_MS = 2_147_483_647;

/** The program a hook starts and its arguments. */
export interface HookLaunch {
  file: string;
  args: string[];
  /** PowerShell runs a hook written for a shell because Git Bash was not found. */
  fallback?: boolean;
  /** cmd.exe takes its command line as written. */
  verbatim?: boolean;
}

/** Git Bash on Windows: never the bash.exe in System32, which is WSL's. */
function gitBash(env: NodeJS.ProcessEnv): string | undefined {
  const named = env.CIRCLE_GIT_BASH_PATH;
  if (named && existsSync(named)) return named;
  const folders = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const folder of folders) {
    if (!existsSync(win32.join(folder, 'git.exe'))) continue;
    for (const candidate of [
      win32.join(folder, '..', 'bin', 'bash.exe'),
      win32.join(folder, '..', '..', 'bin', 'bash.exe'),
      win32.join(folder, 'bash.exe'),
    ])
      if (existsSync(candidate) && !/\\system32\\/i.test(candidate))
        return candidate;
  }
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (!base) continue;
    const candidate = win32.join(base, 'Git', 'bin', 'bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function powershell(env: NodeJS.ProcessEnv): string {
  const folders = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  return folders.some((folder) => existsSync(win32.join(folder, 'pwsh.exe')))
    ? 'pwsh.exe'
    : 'powershell.exe';
}

/**
 * How a hook starts. With `args`, its command is the program, run without a shell, and the placeholders are put in
 * as plain text. Without, its command goes to a shell: `sh -c` on macOS and Linux, Git Bash on Windows, or PowerShell
 * when Git Bash is not there or the hook asks for it. PowerShell reads a placeholder from the environment as
 * `${env:NAME}`; the other shells read `${NAME}` from the environment as it is.
 */
export function hookLaunch(
  hook: Pick<HookDefinition, 'command' | 'args' | 'shell' | 'legacy'>,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): HookLaunch {
  if (hook.args) {
    const put = (text: string) =>
      PLACEHOLDERS.reduce(
        (result, name) => result.replaceAll(`\${${name}}`, env[name] ?? ''),
        text,
      );
    return { file: put(hook.command), args: hook.args.map(put) };
  }
  if (platform !== 'win32')
    return { file: '/bin/sh', args: ['-c', hook.command] };
  // A hook moved from the format before this one keeps the shell it was written for: cmd.exe
  if (hook.legacy && !hook.shell) {
    const line = PLACEHOLDERS.reduce(
      (result, name) => result.replaceAll(`\${${name}}`, `%${name}%`),
      hook.command,
    );
    return {
      file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      verbatim: true,
    };
  }
  const bash = hook.shell === 'powershell' ? undefined : gitBash(env);
  if (bash) return { file: bash, args: ['-c', hook.command] };
  // A program's exit code is the hook's: PowerShell would otherwise give 1 for any failure
  const script =
    PLACEHOLDERS.reduce(
      (result, name) => result.replaceAll(`\${${name}}`, `\${env:${name}}`),
      hook.command,
    ) + '\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }';
  return {
    file: powershell(env),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    ...(hook.shell === 'powershell' ? {} : { fallback: true }),
  };
}

function runHookCommand(
  launch: HookLaunch,
  cwd: string,
  stdin: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv,
  /** A background hook: its process is kept so the session can end it. */
  track?: (child: ChildProcess, done: boolean) => void,
  closeGraceMs = CLOSE_GRACE_MS,
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
    let child: ChildProcess;
    try {
      child = spawn(launch.file, launch.args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
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
    track?.(child, false);
    const decoders = {
      out: new StringDecoder('utf8'),
      err: new StringDecoder('utf8'),
    };
    const take = (into: 'out' | 'err') => (chunk: Buffer) => {
      const next = decoders[into].write(chunk);
      if (into === 'out') stdout = clip(stdout + next);
      else stderr = clip(stderr + next);
    };
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));
    // A command that exits without reading its input closes the pipe. The write then fails asynchronously with
    // EPIPE, which must not crash Circle.
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.end(stdin);
    } catch {
      /* The command can ignore stdin. */
    }
    let escalation: NodeJS.Timeout | undefined;
    // Windows ends the whole tree at once; the hook finishes after that has run
    let windowsKill: Promise<void> | undefined;
    const kill = (force: boolean) => {
      if (process.platform === 'win32')
        windowsKill ??= killProcessTree(child, true);
      else void killProcessTree(child, force);
    };
    const stop = (timeout: boolean) => {
      timedOut = timedOut || timeout;
      kill(false);
      escalation ??= setTimeout(() => kill(true), 500);
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => stop(true), Math.min(timeoutMs, MAX_TIMER_MS))
        : undefined;
    let quiet: NodeJS.Timeout | undefined;
    const onAbort = () => stop(false);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (quiet) clearTimeout(quiet);
      signal?.removeEventListener('abort', onAbort);
      track?.(child, true);
    };
    // Something the hook started in the background can hold its output open after it has ended: read a little
    // longer, then stop waiting, and say the output may be cut
    child.once('exit', (code) => {
      quiet = setTimeout(() => {
        done();
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({
          stdout: clip(stdout + decoders.out.end()),
          stderr: clip(stderr + decoders.err.end()),
          exitCode: code,
          timedOut,
          suspect: true,
          error:
            'stdio went quiet after the hook exited, refusing to honor the suspect capture',
        });
      }, closeGraceMs);
      quiet.unref?.();
    });
    child.once('error', (error) => {
      done();
      finish({
        stdout,
        stderr,
        exitCode: null,
        timedOut,
        error: error.message,
      });
    });
    child.once('close', (code) => {
      done();
      stdout = clip(stdout + decoders.out.end());
      stderr = clip(stderr + decoders.err.end());
      void Promise.resolve(windowsKill).finally(() =>
        finish({
          stdout,
          stderr,
          exitCode: code,
          timedOut,
          ...(signal?.aborted && !timedOut ? { error: 'hook stopped' } : {}),
        }),
      );
    });
  });
}

/** Events that judged a call, or the end of a turn, in the format before this one: a failure there stopped it. */
const LEGACY_GATING = new Set<HookEvent>([
  'PreToolUse',
  'PermissionRequest',
  'Stop',
]);

/** What one run of a hook comes to. Exported for tests of the rules no other system here can show. */
export function interpretHookRun(
  hook: HookDefinition,
  event: HookEvent,
  result: CommandResult,
  aborted: boolean,
  /** PowerShell stood in for a missing Git Bash. */
  fallback = false,
): Omit<
  HookOutcome,
  'hook' | 'exitCode' | 'timedOut' | 'stdout' | 'stderr' | 'durationMs'
> {
  const none = {
    failed: false,
    cause: '',
    blocking: false,
    blockText: '',
    plain: '',
    legacy: false,
    stopped: false,
  };
  if (aborted && !result.timedOut) return { ...none, stopped: true };
  const gate = event === 'PreToolUse' || event === 'PermissionRequest';
  // Without Git Bash, a guard written for a shell runs in PowerShell: only 0 and 2 are its verdicts, and anything
  // else blocks unless the hook says the call goes on
  const strict = fallback && gate && hook.onFailure !== 'continue';
  const legacy = hook.legacy === true && LEGACY_GATING.has(event);
  // A failure lets the action go ahead, unless the hook says it blocks on failure. Stop hooks and background hooks
  // cannot: Circle would only send the model back to work on a hook it cannot repair.
  const failure = (cause: string, suspect = false) => {
    const why =
      hook.onFailure === 'block'
        ? 'onFailure is "block"'
        : strict
          ? "Git Bash wasn't found, so only exit code 0 or 2 counts as this hook's verdict"
          : legacy
            ? 'it was a gating hook in the format before this one'
            : 'its output cannot be trusted';
    const blocks =
      !hook.async &&
      ((hook.onFailure === 'block' &&
        event !== 'Stop' &&
        event !== 'SubagentStop') ||
        strict ||
        legacy ||
        (suspect && gate));
    return {
      ...none,
      failed: true,
      cause,
      blocking: blocks,
      blockText: blocks
        ? `hook ${hook.name} ${result.timedOut ? 'timed out' : 'failed'}; blocking because ${why}: ${cause}`
        : '',
    };
  };
  if (result.suspect) return failure(result.error ?? 'output was cut', true);
  if (result.timedOut)
    return failure(
      `timed out after ${Math.round((hook.timeout ?? defaultTimeoutMs(event) / 1000) * 10) / 10}s`,
    );
  if (result.error) return failure(result.error);
  const reading = readOutput(event, result.stdout);
  if (result.exitCode === 2)
    return {
      ...none,
      blocking: true,
      blockText: result.stderr.trim() || 'hook exited 2',
      ...(reading.invalid === undefined && reading.answer
        ? { answer: reading.answer, legacy: reading.legacy }
        : {}),
    };
  if (result.exitCode === 0) {
    if (reading.invalid !== undefined) return failure(reading.invalid);
    // A gating hook of the format before this one that printed text and no JSON refused
    if (legacy && reading.plain)
      return {
        ...none,
        blocking: true,
        blockText: 'hook output is not JSON',
      };
    return {
      ...none,
      ...(reading.answer ? { answer: reading.answer } : {}),
      plain: reading.plain,
      legacy: reading.legacy,
    };
  }
  // Another exit with a JSON answer: the answer decides, unless the hook blocks on failure
  if (
    reading.invalid === undefined &&
    reading.answer &&
    hook.onFailure !== 'block' &&
    !strict &&
    !legacy
  )
    return { ...none, answer: reading.answer, legacy: reading.legacy };
  const why = firstLine(result.stderr);
  return failure(
    `exited ${result.exitCode ?? 'unknown'}${why ? `: ${why}` : ''}`,
  );
}

function capText(text: string | undefined): string {
  if (!text) return '';
  return text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}\n… hook output truncated`
    : text;
}

/** What the hooks of one event come to together. */
export function combineOutcomes(
  event: HookEvent,
  outcomes: HookOutcome[],
  input: Record<string, unknown> | undefined,
  secrets: Record<string, string>,
  toolName?: string,
): HookBatch {
  const ran = outcomes.filter((item) => !item.stopped);
  const notices: HookNotice[] = [];
  const reasons: string[] = [];
  const messages: string[] = [];
  const contexts: string[] = [];
  let blocked = false;
  let stop: HookBatch['stop'];
  let interrupt = false;
  let suppressOriginalPrompt = false;
  let sessionTitle: string | undefined;
  let updatedToolOutput: string | undefined;
  type Decided = {
    decision: 'allow' | 'deny' | 'ask';
    reason: string;
    message: string;
    outcome: HookOutcome;
  };
  const decided: Decided[] = [];
  for (const outcome of ran) {
    const { hook, answer } = outcome;
    if (outcome.failed && !outcome.blocking)
      notices.push({
        kind: 'failed',
        ...(toolName ? { tool: toolName } : {}),
        name: hook.name,
        reason: outcome.cause,
      });
    const message = QUIET.has(event) ? '' : capText(answer?.systemMessage);
    if (event === 'PreToolUse') {
      if (outcome.blocking)
        decided.push({
          decision: 'deny',
          reason:
            answer?.permissionDecision === 'deny'
              ? answer.permissionDecisionReason || outcome.blockText
              : outcome.blockText,
          message,
          outcome,
        });
      else if (answer?.permissionDecision === 'defer')
        notices.push({
          kind: 'message',
          name: hook.name,
          reason:
            'asked to defer this call; Circle cannot defer a call, so it goes on as usual',
        });
      else if (answer?.permissionDecision)
        decided.push({
          decision: answer.permissionDecision,
          reason:
            answer.permissionDecisionReason ||
            (answer.permissionDecision === 'deny' ? 'hook denied' : ''),
          message,
          outcome,
        });
    } else if (event === 'PermissionRequest') {
      // A blocking exit does not answer a permission request; a failure of a hook that blocks on failure denies it
      if (outcome.blocking && (outcome.failed || outcome.hook.legacy))
        decided.push({
          decision: 'deny',
          reason: outcome.blockText,
          message,
          outcome,
        });
      else if (answer?.permission) {
        decided.push({
          decision: answer.permission.behavior,
          reason:
            answer.permission.message ||
            (answer.permission.behavior === 'deny' ? 'hook denied' : ''),
          message,
          outcome,
        });
        if (
          answer.permission.behavior === 'deny' &&
          answer.permission.interrupt
        )
          interrupt = true;
      }
    } else {
      const blocks =
        (outcome.blocking && CAN_BLOCK.has(event)) ||
        (answer?.block === true && BLOCK_FIELD.has(event));
      if (blocks) {
        blocked = true;
        reasons.push(
          capText(
            answer?.block && answer.reason
              ? answer.reason
              : outcome.blockText || answer?.reason || 'hook blocked',
          ),
        );
        if (answer?.suppressOriginalPrompt) suppressOriginalPrompt = true;
      } else if (
        outcome.blocking &&
        (event === 'PostToolUse' || event === 'PostToolUseFailure')
      ) {
        // The tool already ran: what the hook wrote to standard error is shown to the model beside the result
        blocked = true;
        reasons.push(capText(outcome.blockText));
      } else if (outcome.blocking)
        // An event nothing can stop: the person sees what the hook said
        notices.push({
          kind: 'message',
          name: hook.name,
          reason: firstLine(outcome.blockText),
        });
    }
    if (answer?.additionalContext && answer.permissionDecision !== 'defer')
      contexts.push(capText(answer.additionalContext));
    if (outcome.plain && plainForModel(event, hook))
      contexts.push(capText(outcome.plain));
    if (message) {
      messages.push(message);
      notices.push({ kind: 'message', name: hook.name, reason: message });
    }
    if (!QUIET.has(event) && answer?.continue === false && !stop)
      stop = { reason: capText(answer.stopReason) };
    if (answer?.sessionTitle?.trim()) sessionTitle = answer.sessionTitle.trim();
    if (event === 'PostToolUse' && answer?.updatedToolOutput !== undefined) {
      if (typeof answer.updatedToolOutput !== 'string')
        notices.push({
          kind: 'failed',
          name: hook.name,
          reason: 'updatedToolOutput must be text here; the result is kept',
        });
      else updatedToolOutput ??= answer.updatedToolOutput;
    }
  }
  let decision: HookBatch['decision'] = 'none';
  let reason = reasons.filter(Boolean).join('\n');
  let userMessage = messages.join('\n');
  for (const candidate of ['deny', 'ask', 'allow'] as const) {
    const these = decided.filter((item) => item.decision === candidate);
    if (!these.length) continue;
    decision = candidate;
    reason = these
      .map((item) => item.reason)
      .filter(Boolean)
      .join('\n');
    const said = these.map((item) => item.message).filter(Boolean);
    if (said.length) userMessage = said.join('\n');
    break;
  }
  for (const item of decided) {
    const base = {
      ...(toolName ? { tool: toolName } : {}),
      name: item.outcome.hook.name,
      reason: item.reason,
      ...(item.message ? { message: item.message } : {}),
    };
    if (item.decision === 'deny') notices.push({ kind: 'denied', ...base });
    else if (item.decision === 'ask') notices.push({ kind: 'asked', ...base });
    else notices.push({ kind: 'allowed', ...base });
  }
  // A rewrite stands only beside a decision that lets the call run. Hooks that rewrite it differently leave no form
  // the call can run in.
  const changedBy: string[] = [];
  const conflict: string[] = [];
  let updatedInput: Record<string, unknown> | undefined;
  if (
    (event === 'PreToolUse' && decision !== 'deny') ||
    (event === 'PermissionRequest' && decision === 'allow')
  ) {
    const given = canonicalJson(redactHookValue(input, secrets));
    const rewrites = new Map<
      string,
      { value: Record<string, unknown>; names: string[] }
    >();
    for (const outcome of ran) {
      const value =
        event === 'PreToolUse'
          ? outcome.answer?.permissionDecision === 'deny' ||
            outcome.answer?.permissionDecision === 'defer'
            ? undefined
            : outcome.answer?.updatedInput
          : outcome.answer?.permission?.behavior === 'allow'
            ? outcome.answer.permission.updatedInput
            : undefined;
      if (!value) continue;
      const key = canonicalJson(value);
      // Handing back the input it was given, in any key order, is no rewrite
      if (key === given) continue;
      const entry = rewrites.get(key) ?? { value, names: [] };
      entry.names.push(outcome.hook.name);
      rewrites.set(key, entry);
    }
    if (rewrites.size > 1)
      conflict.push(...[...rewrites.values()].flatMap((item) => item.names));
    else if (rewrites.size === 1) {
      const [only] = rewrites.values();
      updatedInput = only!.value;
      changedBy.push(...only!.names);
    }
  }
  // The screen names each hook whose words went to the model, with their first line
  for (const outcome of ran) {
    const context =
      (outcome.answer?.permissionDecision !== 'defer' &&
        outcome.answer?.additionalContext) ||
      (plainForModel(event, outcome.hook) ? outcome.plain : '');
    if (context)
      notices.push({
        kind: 'output',
        name: outcome.hook.name,
        reason: context.split('\n')[0]?.slice(0, 200),
      });
  }
  if (stop) notices.push({ kind: 'stopped', reason: stop.reason });
  return {
    outcomes,
    notices,
    decision,
    reason,
    userMessage,
    blocked,
    ...(updatedInput ? { updatedInput } : {}),
    changedBy,
    conflict,
    context: contexts.filter(Boolean).join('\n\n'),
    ...(stop ? { stop } : {}),
    ...(updatedToolOutput !== undefined ? { updatedToolOutput } : {}),
    ...(sessionTitle ? { sessionTitle } : {}),
    suppressOriginalPrompt,
    interrupt,
  };
}

/** Whether a hook's `if` lets it run for this call. */
function conditionMatches(
  hook: HookDefinition,
  request: HookRunRequest,
  pathOptions: HookPathOptions,
): boolean {
  const condition = hook.condition;
  if (!condition) return true;
  // Only tool events read `if`: elsewhere a hook that has one never runs
  if (!TOOL_EVENTS.has(request.event)) return false;
  if (condition.tool !== request.toolName) return false;
  const pattern = condition.pattern;
  if (!pattern) return true;
  const platform = pathOptions.platform ?? process.platform;
  if (request.toolName === 'execute') {
    const command =
      typeof request.toolInput?.command === 'string'
        ? request.toolInput.command
        : '';
    // What runs inside a substitution cannot be told: the hook runs
    if (/\$\(|`/.test(command)) return true;
    const read = commandSegments(command, platform);
    if (!read?.segments.length || read.uncertain) return true;
    return read.segments.some((segment) =>
      matchPattern(pattern, segment, platform === 'win32'),
    );
  }
  if (request.paths?.length)
    return request.paths.some((file) =>
      matchHookPath(file, pattern, pathOptions),
    );
  // Nothing in the call to hold the pattern against: the hook runs
  return true;
}

/** The same handler from several settings files runs once. A pack's or a skill's copy stays its own. */
function dedupeKey(hook: HookDefinition): string {
  const what = JSON.stringify([hook.command, hook.args ?? null, hook.shell]);
  return hook.source === 'pack' || hook.source === 'skill'
    ? `${hook.sourceLabel}:${what}`
    : `settings:${what}`;
}

export interface HookRunnerOptions {
  workspace: string;
  home: string;
  platform?: NodeJS.Platform;
  canonicalize?: (path: string) => string;
  /** Tests run a command their own way. */
  run?: typeof runHookCommand;
  /** Checks an installed pack's files before its hooks first run; a problem keeps them off. */
  verifyPack?: (directory: string) => Promise<string | undefined>;
  /** How long a hook's output is read after its own process ends. Tests shorten it. */
  closeGraceMs?: number;
}

/** The names the format before this one gave the events. */
const OLD_NAMES: Partial<Record<HookEvent, string>> = {
  PreToolUse: 'before_tool',
  PostToolUse: 'after_tool',
  Stop: 'before_stop',
  SessionStart: 'session_start',
  PermissionRequest: 'permission_request',
  UserPromptSubmit: 'user_prompt',
  SubagentStart: 'subagent_start',
};

export class HookRunner {
  /** Skills loaded in this session. Their hooks stay off until then. */
  private armed = new Set<string>();
  /** `once` hooks that have run. */
  private spent = new Set<string>();
  /** Each pack's check, run once. */
  private packChecks = new Map<string, Promise<string | undefined>>();
  /** Hooks already told of for answering in the old format. */
  private toldLegacy = new Set<string>();
  /** How many times each Stop hook of the format before this one has blocked, and those past their limit. */
  private stopBlocks = new Map<string, number>();
  private limited = new Set<string>();
  /** Background hooks still running, ended with the session. */
  private background = new Set<ChildProcess>();
  /** What background hooks said, for the next request of the conversation or subagent that started them. */
  private delivered: {
    name: string;
    context: string;
    message: string;
    sessionId: string;
    agentId?: string;
  }[] = [];
  constructor(
    readonly loaded: LoadedHooks,
    private readonly options: HookRunnerOptions,
  ) {}

  private armedHook(hook: HookDefinition): boolean {
    return (
      (hook.source !== 'skill' || this.armed.has(hook.skill ?? '')) &&
      !this.spent.has(hook.id)
    );
  }

  /** Hooks that can run now. A skill hook is absent until that skill is loaded. */
  active(): HookDefinition[] {
    return this.loaded.hooks.filter((hook) => this.armedHook(hook));
  }

  /** Whether any hook of the event can run now. */
  has(event: HookEvent): boolean {
    return this.active().some((hook) => hook.event === event);
  }

  /** Every configured hook, including a skill hook this session has not loaded. */
  listing(): { hook: HookDefinition; active: boolean; spent: boolean }[] {
    return this.loaded.hooks.map((hook) => ({
      hook,
      active: this.armedHook(hook),
      spent: this.spent.has(hook.id),
    }));
  }

  /** Arm one skill's hooks for this session. The first call returns those hooks; loading it again does not. */
  activateSkill(name: string): HookDefinition[] {
    const key = name.trim().toLowerCase();
    if (!key || this.armed.has(key)) return [];
    this.armed.add(key);
    return this.loaded.hooks.filter(
      (hook) => hook.source === 'skill' && hook.skill === key,
    );
  }

  /** What background hooks started by this conversation (or this subagent of it) said since the last call. */
  takeDelivered(
    sessionId: string,
    agentId?: string,
  ): { name: string; context: string; message: string }[] {
    const mine = (item: (typeof this.delivered)[number]) =>
      item.sessionId === sessionId && item.agentId === agentId;
    const taken = this.delivered.filter(mine);
    this.delivered = this.delivered.filter((item) => !mine(item));
    return taken;
  }

  /** Ends the background hooks still running. */
  close(): void {
    for (const child of this.background) void killProcessTree(child, true);
    this.background.clear();
  }

  private checkPack(hook: HookDefinition): Promise<string | undefined> {
    const directory = hook.skillDir!;
    let check = this.packChecks.get(directory);
    if (!check) {
      const verify =
        this.options.verifyPack ??
        (async (folder: string) => {
          try {
            await verifyInstalled(folder);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        });
      check = verify(directory);
      this.packChecks.set(directory, check);
    }
    return check;
  }

  async run(request: HookRunRequest): Promise<HookBatch> {
    const pathOptions: HookPathOptions = {
      workspace: this.options.workspace,
      platform: this.options.platform,
      canonicalize: this.options.canonicalize,
    };
    const value = TOOL_EVENTS.has(request.event)
      ? request.toolName
      : request.matchValue;
    const seen = new Set<string>();
    let chosen = this.loaded.hooks.filter((hook) => {
      if (request.onlyIds && !request.onlyIds.includes(hook.id)) return false;
      if (!this.armedHook(hook) || hook.event !== request.event) return false;
      if (
        !NO_MATCHER.has(request.event) &&
        !matcherMatches(hook.matcher, value)
      )
        return false;
      if (!conditionMatches(hook, request, pathOptions)) return false;
      const key = dedupeKey(hook);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const notices: HookNotice[] = [];
    // A pack whose files do not check out runs none of its hooks
    const packs = [
      ...new Set(chosen.filter((hook) => hook.pack).map((hook) => hook.pack!)),
    ];
    const unchecked: HookOutcome[] = [];
    for (const pack of packs) {
      const problem = await this.checkPack(
        chosen.find((hook) => hook.pack === pack)!,
      );
      if (!problem) continue;
      // A guard that blocks on failure blocks: a pack that does not check out has failed it
      for (const hook of chosen.filter((item) => item.pack === pack))
        if (
          hook.onFailure === 'block' &&
          !hook.async &&
          request.event !== 'Stop' &&
          request.event !== 'SubagentStop'
        )
          unchecked.push({
            hook,
            exitCode: null,
            timedOut: false,
            stdout: '',
            stderr: '',
            durationMs: 0,
            failed: true,
            cause: problem,
            blocking: true,
            blockText: `hook ${hook.name} failed; blocking because onFailure is "block": pack ${pack}: ${problem}`,
            plain: '',
            legacy: false,
            stopped: false,
          });
      chosen = chosen.filter((hook) => hook.pack !== pack);
      notices.push({ kind: 'failed', name: `pack ${pack}`, reason: problem });
    }
    // A Stop hook of the format before this one stops blocking after its limit for the session
    if (request.event === 'Stop' || request.event === 'SubagentStop')
      chosen = chosen.filter((hook) => {
        if (!hook.legacy) return true;
        const limit = hook.loopLimit ?? 5;
        if ((this.stopBlocks.get(hook.id) ?? 0) < limit) return true;
        if (!this.limited.has(hook.id)) {
          this.limited.add(hook.id);
          notices.push({ kind: 'limit', name: hook.name });
        }
        return false;
      });
    if (!chosen.length) {
      const batch = combineOutcomes(
        request.event,
        unchecked,
        request.toolInput,
        request.secrets ?? {},
        request.toolName,
      );
      batch.notices.unshift(...notices);
      return batch;
    }
    let folder: string | undefined;
    let taken: Promise<HookFile | undefined> | undefined;
    const screenshot = () =>
      (taken ??= (async (): Promise<HookFile | undefined> => {
        let bytes: Buffer | undefined;
        let path: string;
        // A picture that cannot be taken or kept is no file: the hooks still run, without `files`
        try {
          bytes = await request.screenshot?.(
            request.signal ?? new AbortController().signal,
          );
          if (!bytes?.length) return undefined;
          folder = mkdtempSync(join(tmpdir(), 'circle-hook-'));
          path = join(folder, 'screenshot.png');
          writeFileSync(path, bytes, { mode: 0o600 });
        } catch {
          return undefined;
        }
        return {
          kind: 'screenshot',
          path,
          mime_type: 'image/png',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        };
      })());
    try {
      const outcomes = [
        ...unchecked,
        ...(await this.runChosen(request, chosen, screenshot, pathOptions)),
      ];
      for (const outcome of outcomes)
        if (
          outcome.hook.legacy &&
          (request.event === 'Stop' || request.event === 'SubagentStop') &&
          (outcome.blocking || outcome.answer?.block)
        )
          this.stopBlocks.set(
            outcome.hook.id,
            (this.stopBlocks.get(outcome.hook.id) ?? 0) + 1,
          );
      const batch = combineOutcomes(
        request.event,
        outcomes,
        request.toolInput,
        request.secrets ?? {},
        request.toolName,
      );
      batch.notices.unshift(...notices);
      for (const outcome of outcomes)
        if (outcome.legacy && !this.toldLegacy.has(outcome.hook.id)) {
          this.toldLegacy.add(outcome.hook.id);
          batch.notices.push({
            kind: 'message',
            name: outcome.hook.name,
            reason:
              'answers in the hook format before this one; it still counts, and the hooks docs show the current fields',
          });
        }
      return batch;
    } finally {
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  }

  private async runChosen(
    request: HookRunRequest,
    chosen: HookDefinition[],
    screenshot: () => Promise<HookFile | undefined>,
    pathOptions: HookPathOptions,
  ): Promise<HookOutcome[]> {
    const platform = this.options.platform ?? process.platform;
    const secrets = request.secrets ?? {};
    const canonicalPaths = (request.paths ?? []).map((file) => {
      try {
        const absolute = isHostAbsolutePath(file, platform)
          ? file
          : pathApi(platform).resolve(request.cwd, file);
        return (pathOptions.canonicalize ?? canonicalPath)(absolute);
      } catch {
        return file;
      }
    });
    // SessionEnd hooks share a short budget, which a hook's own longer timeout raises up to a minute
    const budget =
      request.event === 'SessionEnd'
        ? Math.min(
            60_000,
            Math.max(
              defaultTimeoutMs('SessionEnd'),
              ...chosen.map((hook) => (hook.timeout ?? 0) * 1000),
            ),
          )
        : undefined;
    const deadline = budget ? new AbortController() : undefined;
    const budgetTimer = deadline
      ? setTimeout(() => deadline.abort(), budget)
      : undefined;
    const signal =
      deadline && request.signal
        ? AbortSignal.any([deadline.signal, request.signal])
        : (deadline?.signal ?? request.signal);
    const base = {
      session_id: request.sessionId,
      cwd: request.cwd,
      ...(request.permissionMode
        ? { permission_mode: request.permissionMode }
        : {}),
      hook_event_name: request.event,
      ...(request.agent
        ? { agent_id: request.agent.id, agent_type: request.agent.type }
        : {}),
    };
    const eventFields = redactHookValue(
      {
        ...(TOOL_EVENTS.has(request.event)
          ? {
              tool_name: request.toolName,
              tool_input: request.toolInput ?? {},
              ...(request.toolUseId && request.event !== 'PermissionRequest'
                ? { tool_use_id: request.toolUseId }
                : {}),
              paths: canonicalPaths,
            }
          : {}),
        ...(request.fields ?? {}),
      },
      secrets,
    ) as Record<string, unknown>;
    const start = async (hook: HookDefinition): Promise<HookOutcome> => {
      const started = Date.now();
      const file =
        hook.screenshot && request.event === 'PostToolUse'
          ? await screenshot()
          : undefined;
      const stdin = JSON.stringify({
        ...base,
        ...eventFields,
        ...(hook.skillDir ? { skill_dir: hook.skillDir } : {}),
        ...(file ? { files: [file] } : {}),
        ...(hook.legacy ? this.legacyFields(hook, request, eventFields) : {}),
      });
      const env = this.environment(hook, request, secrets);
      const timeoutMs = hook.async
        ? 0
        : hook.timeout !== undefined
          ? Math.min(hook.timeout * 1000, MAX_TIMER_MS)
          : defaultTimeoutMs(request.event);
      const launch = hookLaunch(hook, env, platform);
      const run = this.options.run ?? runHookCommand;
      let result: CommandResult;
      try {
        result = await run(
          launch,
          request.cwd,
          stdin,
          timeoutMs,
          hook.async ? undefined : signal,
          env,
          hook.async
            ? (child, done) => {
                if (done) this.background.delete(child);
                else this.background.add(child);
              }
            : undefined,
          this.options.closeGraceMs,
        );
      } catch (error) {
        result = {
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const outcome: HookOutcome = {
        hook,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
        ...interpretHookRun(
          hook,
          request.event,
          result,
          !hook.async && !!signal?.aborted,
          launch.fallback === true,
        ),
      };
      this.log(request, outcome, secrets);
      // `once`: gone after a run that did not fail, block or time out
      if (hook.once && !outcome.failed && !outcome.blocking && !outcome.stopped)
        this.spent.add(hook.id);
      return outcome;
    };
    try {
      const background = chosen.filter((hook) => hook.async);
      for (const hook of background)
        void start(hook).then((outcome) => {
          const context = outcome.answer?.additionalContext ?? '';
          const message = outcome.answer?.systemMessage ?? '';
          if (context || message)
            this.delivered.push({
              name: hook.name,
              context: capText(context),
              message: capText(message),
              sessionId: request.sessionId,
              ...(request.agent ? { agentId: request.agent.id } : {}),
            });
        });
      return await Promise.all(
        chosen.filter((hook) => !hook.async).map((hook) => start(hook)),
      );
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
    }
  }

  /** The input fields a hook moved from the format before this one was written for. */
  private legacyFields(
    hook: HookDefinition,
    request: HookRunRequest,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      event: OLD_NAMES[request.event] ?? request.event,
      hook: hook.name,
      source: hook.source === 'local' ? 'project' : hook.source,
      source_label: hook.source === 'local' ? 'project' : hook.sourceLabel,
      ...(request.event === 'PostToolUse'
        ? { tool_output: fields.tool_response, tool_status: 'success' }
        : {}),
      ...(request.event === 'Stop' || request.event === 'SubagentStop'
        ? { stop_attempt: (this.stopBlocks.get(hook.id) ?? 0) + 1 }
        : {}),
    };
  }

  private environment(
    hook: HookDefinition,
    request: HookRunRequest,
    secrets: Record<string, string>,
  ): NodeJS.ProcessEnv {
    const env = shellEnvironment();
    const shown = Object.keys(secrets).length
      ? Object.fromEntries(
          Object.entries(env).map(([name, value]) => [
            name,
            value === undefined ? undefined : redactSecrets(value, secrets),
          ]),
        )
      : env;
    // Only a pack's or a skill's hook has their folders; no other hook inherits one from Circle's own environment.
    // Every hook knows whose call it judges, as the call's own processes do.
    const extra: Record<string, string | undefined> = {
      [PROJECT_DIR_VARIABLE]: this.options.workspace,
      [SKILL_DIR_VARIABLE]: hook.skillDir,
      [SKILL_DATA_VARIABLE]: hook.skillData,
      ...identityEnvironment({
        sessionId: request.sessionId,
        ...(request.agent ? { agentId: request.agent.id } : {}),
      }),
    };
    const result: NodeJS.ProcessEnv = { ...shown };
    for (const [name, value] of Object.entries(extra))
      if (value === undefined) delete result[name];
      else result[name] = value;
    return result;
  }

  private log(
    request: HookRunRequest,
    outcome: HookOutcome,
    secrets: Record<string, string>,
  ): void {
    const answer = outcome.answer;
    const decision = outcome.blocking
      ? 'block'
      : (answer?.permissionDecision ??
        answer?.permission?.behavior ??
        (answer?.block ? 'block' : 'none'));
    const line = {
      ts: new Date().toISOString(),
      session_id: request.sessionId,
      ...(request.agent ? { agent_id: request.agent.id } : {}),
      event: request.event,
      source: outcome.hook.source,
      source_label: outcome.hook.sourceLabel,
      name: outcome.hook.name,
      command: [outcome.hook.command, ...(outcome.hook.args ?? [])].join(' '),
      tool: request.toolName,
      exit_code: outcome.exitCode,
      decision,
      timed_out: outcome.timedOut,
      failed: outcome.failed,
      duration_ms: outcome.durationMs,
      reason: (
        outcome.cause ||
        outcome.blockText ||
        answer?.reason ||
        ''
      ).slice(0, 500),
      // Plain output that no one else reads is kept here
      ...(outcome.plain && !PLAIN_FOR_MODEL.has(request.event)
        ? { output: outcome.plain.slice(0, 2000) }
        : {}),
    };
    try {
      if (!existsSync(this.options.home)) return;
      appendFileSync(
        join(this.options.home, 'hooks.log'),
        `${redactSecrets(JSON.stringify(line), secrets)}\n`,
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

/** A hooks file as a notice names it: from the workspace when it is inside, else whole. */
export function hookFileShown(file: string, workspace: string): string {
  const inside = relative(workspace, file);
  return inside && !inside.startsWith('..') && !isAbsolute(inside)
    ? inside.split(sep).join('/')
    : file;
}
