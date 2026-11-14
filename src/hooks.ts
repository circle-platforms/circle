// Deterministic hooks: shell commands Circle runs at fixed points. A decision
// from a hook overrides the approval mode. A hard refusal from the approval
// policy (sudo, or a command that names a credential file) and read-only mode
// are decided before any hook runs, and a hook cannot undo them. A file tool
// still refuses a credential file when it runs, after the hooks.
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  sep,
  win32,
} from 'node:path';
import { canonicalPath, ensureHome } from './paths.js';
import { redactSecrets } from './secrets.js';
import { isHostAbsolutePath, shellEnvironment } from './sandbox.js';
import { discoverSkills } from './skills.js';
import { isRecord, withPrivateJsonLock, writePrivateJson } from './settings.js';

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
    | 'rewrote'
    | 'output'
    | 'blocked'
    | 'limit'
    | 'failed'
    | 'active'
    | 'untrusted'
    | 'changed';
  tool?: string;
  name?: string;
  reason?: string;
  /** What the person reads in place of `reason`: the hook's `user_message`. It never reaches the model. */
  message?: string;
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
  /** Set when the hook ships with a skill. It runs only after that skill is loaded. */
  skill?: string;
  /**
   * The folder of that skill, which holds its `hooks.json` beside `SKILL.md`, symlinks resolved: the folder the
   * model is told when the skill loads. The hook gets it as `CIRCLE_SKILL_DIR` and `skill_dir` (#540).
   */
  skillDir?: string;
  /**
   * after_tool only: the hook also gets a PNG of the page the conversation's browser shows, as a file, which never
   * reaches the model (#502). Off unless the hooks file says `"screenshot": true`.
   */
  screenshot?: boolean;
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
  /**
   * Project hook files that did not load because these bytes were never approved:
   * a new file, or one that changed since you approved it.
   */
  projectChanged: HookChange[];
}

/** A hook as an approval card lists it, against the version approved last. */
export interface HookPreview {
  name: string;
  event: HookEvent;
  command: string;
  /** The hook also gets a screenshot of the browser's page. */
  screenshot?: boolean;
  mark: 'new' | 'changed' | 'unchanged' | 'removed';
}

/**
 * A project hooks file waiting for approval. Everything here comes from one read of
 * the file: the digest that an approval records, the rows a card lists and the
 * hooks that load once it is approved.
 */
export interface HookChange {
  file: string;
  /** SHA-256 of the bytes that were read. */
  digest: string;
  hooks: HookPreview[];
  definitions: HookDefinition[];
  /** A problem in those bytes, reported once they load. */
  error?: HookLoadError;
}

export interface HookOutcome {
  hook: HookDefinition;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  decision: HookDecision | 'none';
  reason: string;
  /** `user_message`: for the person, in place of the reason. Empty when the hook gave none. */
  userMessage: string;
  /** before_tool only: the input the call runs with instead (`updated_input`). Never set with a deny. */
  updatedInput?: Record<string, unknown>;
  context: string;
  durationMs: number;
  failed: boolean;
}

export interface HookBatch {
  decision: HookDecision | 'none';
  reason: string;
  /** The `user_message` of the hooks that decided, joined as their reasons are. */
  userMessage: string;
  /**
   * before_tool: the input after every hook that rewrote it, in order, each given the one before. Unset when a
   * hook denied, which voids every rewrite.
   */
  updatedInput?: Record<string, unknown>;
  /** The hooks whose rewrite that is, in the order they ran. */
  changedBy: string[];
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
  /** Saved secrets. Their values are written as %NAME% before the hook sees them. */
  secrets?: Record<string, string>;
  /** Run only these hook ids. Used when a skill is loaded after the session started. */
  onlyIds?: string[];
  /**
   * A PNG of the page the conversation's browser shows, taken when a hook that runs asks for one (`screenshot`), at
   * most once per event; undefined when no page is open. It must not start a browser.
   */
  screenshot?: (signal: AbortSignal) => Promise<Buffer | undefined>;
  signal?: AbortSignal;
}
/** A file a hook gets beside its JSON, named in the JSON's `files`. */
export interface HookFile {
  kind: 'screenshot';
  path: string;
  mime_type: 'image/png';
  sha256: string;
  size: number;
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
    case 'rewrote':
      return `hook rewrote ${notice.tool ?? 'tool'}${notice.name ? ` · ${notice.name}` : ''}`;
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
    case 'changed':
      return `project hooks need approval${notice.name ? ` · ${notice.name}` : ''}`;
  }
}

/** The line a tool result starts with when a hook decided. The model reads the English. */
export const HOOK_DENIED_LINE = 'Hook denied this call:';
export const HOOK_ASKED_LINE = 'Hook asked before this call:';
export { HOOK_ALLOWED_LINE } from './hook_display.js';
export const HOOK_OUTPUT_LINE = 'Hook output';
/** Starts the tool result of a call a before_tool hook rewrote: `… (name): key = value`. */
export const HOOK_CHANGED_LINE = "Hook changed this call's input";

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

/**
 * The command an entry runs on a platform: the entry's platform command when
 * present, the plain command otherwise. `platform` is a `process.platform`
 * value; anything without a platform field falls back to the plain command.
 * Callers validate the platform fields first; a non-string override here
 * simply does not replace the command.
 */
export function resolveHookCommand(
  entry: {
    command: string;
    command_windows?: unknown;
    command_darwin?: unknown;
    command_linux?: unknown;
  },
  platform: string,
): string {
  const field =
    platform === 'win32'
      ? 'command_windows'
      : platform === 'darwin'
        ? 'command_darwin'
        : platform === 'linux'
          ? 'command_linux'
          : undefined;
  const override = field ? entry[field] : undefined;
  return typeof override === 'string' && override.trim()
    ? override
    : entry.command;
}

function readHookFile(
  file: string,
  source: HookSource,
  sourceLabel: string,
  skill?: string,
  /** The bytes already read, so a digest and the hooks it covers are one read. */
  bytes?: Buffer,
): { hooks: HookDefinition[]; error?: HookLoadError } {
  let raw: unknown;
  try {
    raw = JSON.parse((bytes ?? readFileSync(file)).toString('utf8'));
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
      const badField = (
        ['command_windows', 'command_darwin', 'command_linux'] as const
      ).find((field) => {
        const override = entry[field];
        return (
          override !== undefined &&
          (typeof override !== 'string' ||
            !override.trim() ||
            override.length > 4000 ||
            override.includes('\0'))
        );
      });
      if (badField) {
        problems.push(`${event}[${index}] ${badField} is not usable`);
        return;
      }
      if (
        entry.screenshot !== undefined &&
        (typeof entry.screenshot !== 'boolean' ||
          (entry.screenshot && event !== 'after_tool'))
      ) {
        problems.push(
          `${event}[${index}] screenshot must be true or false, and only after_tool takes it`,
        );
        return;
      }
      const command = resolveHookCommand(
        {
          command: entry.command,
          command_windows: entry.command_windows,
          command_darwin: entry.command_darwin,
          command_linux: entry.command_linux,
        },
        process.platform,
      );
      hooks.push({
        id: `${source}:${file}:${event}:${index}`,
        event,
        name: hookName(entry.name, command),
        command,
        timeoutMs: clampTimeout(entry.timeout_ms),
        loopLimit: clampLoop(entry.loop_limit),
        tools: toolMatcher(entry.tools ?? entry.matcher),
        paths: pathMatcher(entry.paths),
        source,
        sourceLabel,
        file,
        ...(skill ? { skill, skillDir: dirname(file) } : {}),
        ...(entry.screenshot === true ? { screenshot: true } : {}),
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

function hookTrustPath(home: string): string {
  return join(home, 'hook-trust.json');
}

interface ApprovedHook {
  name: string;
  event: string;
  command: string;
  screenshot?: boolean;
}

/** One approved version of a project hooks file: its digest and the hooks it held. */
interface HookTrustEntry {
  digest: string;
  hooks: ApprovedHook[];
}

function approvedHooks(value: unknown): ApprovedHook[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hooks: ApprovedHook[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      typeof item.event !== 'string' ||
      typeof item.command !== 'string'
    )
      return undefined;
    hooks.push({
      name: item.name,
      event: item.event,
      command: item.command,
      ...(item.screenshot === true ? { screenshot: true } : {}),
    });
  }
  return hooks;
}

/** Approved versions, keyed by the file's canonical path. Anything else in the file is not an approval. */
function readHookTrust(home: string): Record<string, HookTrustEntry> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(hookTrustPath(home), 'utf8'));
  } catch {
    return {};
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.files))
    return {};
  const files: Record<string, HookTrustEntry> = {};
  for (const [path, stored] of Object.entries(value.files)) {
    if (!isRecord(stored) || typeof stored.digest !== 'string') continue;
    if (!/^[a-f0-9]{64}$/.test(stored.digest)) continue;
    const hooks = approvedHooks(stored.hooks);
    if (hooks) files[path] = { digest: stored.digest, hooks };
  }
  return files;
}

/** The digest approved for this file, if any. */
export function approvedHookDigest(
  home: string,
  file: string,
): string | undefined {
  return readHookTrust(home)[canonicalPath(file)]?.digest;
}

function previewHooks(
  current: HookDefinition[],
  previous: HookTrustEntry | undefined,
): HookPreview[] {
  const rows = current.map((hook) => ({
    name: hook.name,
    event: hook.event,
    command: hook.command,
    ...(hook.screenshot ? { screenshot: true } : {}),
  }));
  if (!previous) return rows.map((hook) => ({ ...hook, mark: 'new' as const }));
  const used = new Set<number>();
  const marked = rows.map((hook): HookPreview => {
    const exact = previous.hooks.findIndex(
      (item, index) =>
        !used.has(index) &&
        item.event === hook.event &&
        item.name === hook.name &&
        item.command === hook.command &&
        !!item.screenshot === !!hook.screenshot,
    );
    if (exact >= 0) {
      used.add(exact);
      return { ...hook, mark: 'unchanged' };
    }
    const sameName = previous.hooks.findIndex(
      (item, index) =>
        !used.has(index) &&
        item.event === hook.event &&
        item.name === hook.name,
    );
    if (sameName >= 0) used.add(sameName);
    return { ...hook, mark: sameName >= 0 ? 'changed' : 'new' };
  });
  const removed = previous.hooks
    .filter((_, index) => !used.has(index))
    .map((hook): HookPreview => ({
      name: hook.name,
      event: hook.event as HookEvent,
      command: hook.command,
      ...(hook.screenshot ? { screenshot: true } : {}),
      mark: 'removed',
    }));
  return [...marked, ...removed];
}

/**
 * Remember that these bytes of a project hooks file are approved: the digest and the
 * hooks of the read the person saw, never a second read of the file.
 */
export function approveHookFile(home: string, change: HookChange): void {
  const path = hookTrustPath(ensureHome(home));
  withPrivateJsonLock(path, () => {
    const files: Record<string, HookTrustEntry> = readHookTrust(home);
    files[canonicalPath(change.file)] = {
      digest: change.digest,
      hooks: change.definitions.map((hook) => ({
        name: hook.name,
        event: hook.event,
        command: hook.command,
        ...(hook.screenshot ? { screenshot: true } : {}),
      })),
    };
    writePrivateJson(path, { version: 1, files });
  });
}

export function loadHooks(options: {
  workspace: string;
  home: string;
  trusted: boolean;
  userHome?: string;
}): LoadedHooks {
  const hooks: HookDefinition[] = [];
  const errors: HookLoadError[] = [];
  const approved = readHookTrust(options.home);
  const projectChanged: HookChange[] = [];
  let projectIgnored = false;
  const take = (
    file: string,
    source: HookSource,
    label: string,
    skill?: string,
  ) => {
    if (!fileExists(file)) return;
    const read = readHookFile(file, source, label, skill);
    hooks.push(...read.hooks);
    if (read.error) errors.push(read.error);
  };
  // A project file runs only when the folder is trusted and these bytes were approved.
  // The digest, the hooks that load and what an approval card lists are one read.
  const considerProject = (
    file: string,
    source: HookSource,
    label: string,
    skill?: string,
  ) => {
    if (!fileExists(file)) return;
    if (!options.trusted) {
      projectIgnored = true;
      return;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      errors.push({
        file,
        message: `hooks could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const read = readHookFile(file, source, label, skill, bytes);
    const previous = approved[canonicalPath(file)];
    // Nothing in it would run, so there is nothing to approve.
    if (previous?.digest === digest || !read.hooks.length) {
      hooks.push(...read.hooks);
      if (read.error) errors.push(read.error);
      return;
    }
    projectChanged.push({
      file,
      digest,
      hooks: previewHooks(read.hooks, previous),
      definitions: read.hooks,
      ...(read.error ? { error: read.error } : {}),
    });
  };
  take(join(options.home, 'hooks.json'), 'user', 'user');
  considerProject(
    join(options.workspace, '.circle', 'hooks.json'),
    'project',
    'project',
  );
  let skills: ReturnType<typeof discoverSkills> = [];
  try {
    skills = discoverSkills(options.workspace, options.home, options.userHome);
  } catch {
    skills = [];
  }
  for (const skill of skills) {
    // Personal manifests do not carry hooks; a locally added sidecar is not an installation approval.
    if (skill.source_label === 'Personal pack') continue;
    const projectSkill = skill.source_label.startsWith('Project');
    const file = join(dirname(skill.path), 'hooks.json');
    if (!fileExists(file)) continue;
    if (projectSkill)
      considerProject(file, 'skill', `skill:${skill.name}`, skill.name);
    else take(file, 'skill', `skill:${skill.name}`, skill.name);
  }
  return { hooks, errors, projectIgnored, projectChanged };
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Empty output is no opinion. Any other non-object is not hook JSON. */
function hookStdout(stdout: string): {
  parsed?: Record<string, unknown>;
  invalid: boolean;
  text: string;
} {
  const text = stdout.trim();
  if (!text) return { invalid: false, text: '' };
  try {
    const value = JSON.parse(text) as unknown;
    if (isRecord(value)) return { parsed: value, invalid: false, text };
    return { invalid: true, text };
  } catch {
    return { invalid: true, text };
  }
}

function interpretOutput(
  event: HookEvent,
  exitCode: number | null,
  stdout: string,
  stderr: string,
  timedOut: boolean,
  spawnError?: string,
): Pick<
  HookOutcome,
  'decision' | 'reason' | 'userMessage' | 'updatedInput' | 'context' | 'failed'
> {
  const gating = GATING.has(event);
  // A gating failure denies. Anywhere else it is only a notice: the tool
  // result and the session keep going, and the error text is not fed back.
  const fail = (reason: string) =>
    gating
      ? {
          decision: 'deny' as const,
          reason,
          userMessage: '',
          context: '',
          failed: true,
        }
      : {
          decision: 'none' as const,
          reason,
          userMessage: '',
          context: '',
          failed: true,
        };
  if (timedOut) return fail('hook timed out');
  if (spawnError) return fail(spawnError);
  const { parsed, invalid, text } = hookStdout(stdout);
  const named = textField(parsed?.decision);
  const decision = (['allow', 'deny', 'ask'] as const).find(
    (item) => item === named,
  );
  const reason = textField(parsed?.reason) || stderr.trim().slice(0, 2000);
  // What the person reads in place of the reason. The model never gets it.
  const userMessage = textField(parsed?.user_message).slice(0, 2000);
  // Plain text is the hook's own message. A JSON object is not, unless it
  // named a reason: the raw object must not become the denial text.
  const message = reason || (parsed ? '' : text.slice(0, MAX_OUTPUT));
  const context =
    textField(parsed?.context) ||
    textField(parsed?.additional_context) ||
    (parsed || invalid ? '' : text.slice(0, MAX_OUTPUT));
  if (exitCode === 2) {
    if (!gating) return fail(message || 'hook exited 2');
    return {
      decision: 'deny',
      reason: message || 'hook denied',
      userMessage,
      context: '',
      failed: false,
    };
  }
  if (exitCode !== 0)
    return fail(message || `hook exited ${exitCode ?? 'unknown'}`);
  if (invalid) {
    if (gating) return fail('hook output is not JSON');
    return {
      decision: 'none',
      reason: '',
      userMessage: '',
      context: text.slice(0, MAX_OUTPUT),
      failed: false,
    };
  }
  // A rewrite is a before_tool answer: the whole input the call runs with instead. A deny voids it; anything but
  // an object is no input, so the call does not run.
  const rewrite = event === 'before_tool' ? parsed?.updated_input : undefined;
  if (rewrite !== undefined && !isRecord(rewrite))
    return fail('hook updated_input is not a JSON object');
  const updatedInput =
    rewrite && decision !== 'deny' ? { updatedInput: rewrite } : {};
  if (gating && decision) {
    if (event === 'before_stop' && decision === 'ask')
      return {
        decision: 'deny',
        reason: reason || context || 'hook blocked stop',
        userMessage,
        context: '',
        failed: false,
      };
    return {
      decision,
      reason: reason || (decision === 'deny' ? 'hook denied' : ''),
      userMessage,
      ...updatedInput,
      context: '',
      failed: false,
    };
  }
  return {
    decision: 'none',
    reason: '',
    userMessage,
    ...updatedInput,
    context,
    failed: false,
  };
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

function hookEnvironment(secrets: Record<string, string>): NodeJS.ProcessEnv {
  const env = shellEnvironment();
  if (!Object.keys(secrets).length) return env;
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      value === undefined ? undefined : redactSecrets(value, secrets),
    ]),
  );
}

/** The variable a skill's hook finds that skill's folder by. */
export const SKILL_DIR_VARIABLE = 'CIRCLE_SKILL_DIR';

/**
 * The command as the system shell gets it. `cmd.exe` reads `%NAME%`, not `${NAME}`, so on Windows the
 * `${CIRCLE_SKILL_DIR}` a hooks file writes for every system becomes `%CIRCLE_SKILL_DIR%`. Either way the shell
 * takes the value from the environment: the folder's name never becomes part of the command's text.
 */
export function hookShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? command.replaceAll(`\${${SKILL_DIR_VARIABLE}}`, `%${SKILL_DIR_VARIABLE}%`)
    : command;
}

function runHookCommand(
  command: string,
  cwd: string,
  stdin: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  secrets: Record<string, string> = {},
  /** Set for this hook only. An undefined value removes the variable. */
  extraEnv: Record<string, string | undefined> = {},
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
      child = spawn(hookShellCommand(command), {
        cwd,
        env: { ...hookEnvironment(secrets), ...extraEnv },
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
    // A command that exits without reading its input closes the pipe. The
    // write then fails asynchronously with EPIPE, which must not crash Circle.
    child.stdin?.on('error', () => {});
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
  const base = {
    tool,
    name: outcome.hook.name,
    reason: outcome.reason,
    ...(outcome.userMessage ? { message: outcome.userMessage } : {}),
  };
  if (outcome.decision === 'deny' && outcome.hook.event !== 'before_stop')
    return { kind: 'denied', ...base };
  if (outcome.decision === 'ask') return { kind: 'asked', ...base };
  if (outcome.decision === 'allow') return { kind: 'allowed', ...base };
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
      ...base,
      reason: outcome.context.split('\n')[0]?.slice(0, 200),
    };
  return undefined;
}

function strictest(outcomes: HookOutcome[]): {
  decision: HookDecision | 'none';
  reason: string;
  userMessage: string;
} {
  const joined = (decided: HookOutcome[], field: 'reason' | 'userMessage') =>
    decided
      .map((item) => item[field])
      .filter(Boolean)
      .join('\n');
  for (const decision of ['deny', 'ask', 'allow'] as const) {
    const decided = outcomes.filter((item) => item.decision === decision);
    if (decided.length)
      return {
        decision,
        reason: joined(decided, 'reason'),
        userMessage: joined(decided, 'userMessage'),
      };
  }
  return { decision: 'none', reason: '', userMessage: '' };
}

export class HookRunner {
  /** How many times each before_stop hook has blocked this session. */
  private blocks = new Map<string, number>();
  private limited = new Set<string>();
  /** Skills loaded in this session. Their hooks stay off until then. */
  private armed = new Set<string>();
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

  private armedHook(hook: HookDefinition): boolean {
    return hook.source !== 'skill' || this.armed.has(hook.skill ?? '');
  }

  /** Hooks that can run now. A skill hook is absent until that skill is loaded. */
  active(): HookDefinition[] {
    return this.loaded.hooks.filter((hook) => this.armedHook(hook));
  }

  /**
   * Load a file that was waiting for approval: the hooks of the read that the
   * approval was for, not the file as it is now. False when it is not waiting.
   */
  approve(change: HookChange): boolean {
    const index = this.loaded.projectChanged.findIndex(
      (item) => item.file === change.file && item.digest === change.digest,
    );
    if (index < 0) return false;
    const [waiting] = this.loaded.projectChanged.splice(index, 1);
    this.loaded.hooks.push(...waiting!.definitions);
    if (waiting!.error) this.loaded.errors.push(waiting!.error);
    return true;
  }

  /** Every configured hook, including a skill hook this session has not loaded. */
  listing(): { hook: HookDefinition; active: boolean }[] {
    return this.loaded.hooks.map((hook) => ({
      hook,
      active: this.armedHook(hook),
    }));
  }

  /**
   * Arm one skill's hooks for this session. The first call returns those hooks;
   * loading the same skill again does not.
   */
  activateSkill(name: string): HookDefinition[] {
    const key = name.trim().toLowerCase();
    if (!key || this.armed.has(key)) return [];
    this.armed.add(key);
    return this.loaded.hooks.filter(
      (hook) => hook.source === 'skill' && hook.skill === key,
    );
  }

  async run(request: HookRunRequest): Promise<HookBatch> {
    // The page's picture, for the hooks that ask for it: taken once, in a folder of its own, removed when the event's
    // hooks have all finished
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
      return await this.runHooks(request, screenshot);
    } finally {
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  }

  private async runHooks(
    request: HookRunRequest,
    screenshot: () => Promise<HookFile | undefined>,
  ): Promise<HookBatch> {
    const pathOptions: HookPathOptions = {
      workspace: this.options.workspace,
      platform: this.options.platform,
      canonicalize: this.options.canonicalize,
    };
    const outcomes: HookOutcome[] = [];
    const notices: HookNotice[] = [];
    const secrets = request.secrets ?? {};
    // A before_tool hook that rewrites the input hands the next hook its rewrite. Which hooks run was settled by
    // the call as the model sent it.
    let input = request.toolInput;
    const changedBy: string[] = [];
    for (const hook of this.loaded.hooks) {
      if (request.onlyIds && !request.onlyIds.includes(hook.id)) continue;
      if (!this.armedHook(hook)) continue;
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
      const file =
        hook.screenshot && request.event === 'after_tool'
          ? await screenshot()
          : undefined;
      const stdin = JSON.stringify({
        event: request.event,
        session_id: request.sessionId,
        cwd: request.cwd,
        hook: hook.name,
        source: hook.source,
        source_label: hook.sourceLabel,
        tool_name: request.toolName,
        tool_input: redactHookValue(input, secrets),
        paths: redactHookValue(canonicalPaths, secrets),
        tool_output: redactHookValue(request.toolOutput, secrets),
        tool_status: request.toolStatus,
        permission_reason: redactHookValue(request.permissionReason, secrets),
        ...(hook.skillDir ? { skill_dir: hook.skillDir } : {}),
        ...(file ? { files: [file] } : {}),
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
          secrets,
          // Only a skill's hook has its folder; no other hook inherits one from Circle's own environment
          { [SKILL_DIR_VARIABLE]: hook.skillDir },
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
          userMessage: '',
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
      // Handing back the input it was given, in any key order, is no rewrite
      if (
        outcome.updatedInput &&
        canonicalJson(outcome.updatedInput) !==
          canonicalJson(redactHookValue(input, secrets))
      ) {
        input = outcome.updatedInput;
        changedBy.push(hook.name);
      }
      this.log(request, outcome, secrets);
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
    // A deny voids every rewrite: the call does not run in any form. Whether a rewrite changes what runs is the
    // harness's to tell, once it has checked it; it reports the hooks that rewrote the call then.
    const rewritten =
      request.event === 'before_tool' &&
      decision.decision !== 'deny' &&
      changedBy.length > 0;
    return {
      ...decision,
      ...(rewritten ? { updatedInput: input } : {}),
      changedBy: rewritten ? changedBy : [],
      context,
      outcomes,
      notices,
    };
  }

  private log(
    request: HookRunRequest,
    outcome: HookOutcome,
    secrets: Record<string, string>,
  ): void {
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
