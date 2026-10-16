import fs, {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import {
  credentialsPath,
  settingsPath,
  circleHome,
  ensureHome,
  normalizeWorkspace,
} from './paths.js';
import type { SessionMode } from './approvals.js';

// Circle signs in only with an API URL and key. A `mode` or `oauth_provider` that older
// releases wrote is dropped on load.
export interface ModelAuth {
  protocol: string;
  base_url: string;
  model: string;
  api_key_ref: string;
}
export interface CircleSettings {
  version: number;
  initialized: boolean;
  auth: ModelAuth;
  trusted_folders: string[];
  theme: 'auto' | 'dark' | 'light';
  mcp_servers: Record<string, unknown>[];
  extensions: Record<string, Record<string, unknown>>;
  credential_files: string[];
  trust_cert_files: string[];
  // Wildcard patterns; a command every segment of which matches one runs
  // without asking (src/approvals.ts commandAllowed)
  allowed_commands: string[];
  // The mode a session starts with; "" is manual. A project may not set it.
  default_mode: SessionMode | '';
  update_check: boolean;
  default_thinking: string;
  enabled_models: string[];
  models: Record<string, Record<string, unknown>>;
  double_escape: 'tree' | 'fork' | 'none';
  hide_thinking: boolean;
  /**
   * Where the desktop application starts its default workspace; "" is the
   * built-in scratch folder inside the data folder. Desktop-only: the
   * terminal ignores it, and a project may not set it.
   */
  workspace_folder: string;
  /**
   * Where a task that belongs to no project gets a folder of its own; ""
   * is `tasks` inside the data folder. The desktop and `circle --task`
   * use it; a project may not set it.
   */
  task_folder: string;
  /** Named values, written %NAME% in a tool's arguments; the model also reads them. */
  variables: Record<string, string>;
  [key: string]: unknown;
}
/** A variable's or a secret's name: capital letters, digits and _, from a letter. */
export const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_VARIABLE = 2000;
export const defaultAuth = (): ModelAuth => ({
  protocol: 'openai',
  base_url: '',
  model: '',
  api_key_ref: 'api_key',
});
export const defaultSettings = (): CircleSettings => ({
  version: 1,
  initialized: false,
  auth: defaultAuth(),
  trusted_folders: [],
  theme: 'auto',
  mcp_servers: [],
  extensions: {},
  credential_files: [],
  trust_cert_files: [],
  allowed_commands: [],
  default_mode: '',
  update_check: true,
  default_thinking: '',
  enabled_models: [],
  models: {},
  double_escape: 'tree',
  hide_thinking: false,
  workspace_folder: '',
  task_folder: '',
  variables: {},
});
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim())
    : [];
// The session modes, spelled as in approvals.ts SESSION_MODES (a test pins
// the two lists together); anything else, or nothing, means manual.
const MODE_NAMES: readonly (SessionMode | '')[] = [
  'manual',
  'accept-edits',
  'plan',
  'auto',
];
const modeName = (value: unknown): SessionMode | '' => {
  const name = String(value || '')
    .trim()
    .toLowerCase();
  return (MODE_NAMES as readonly string[]).includes(name)
    ? (name as SessionMode)
    : '';
};
export function loadSettingsFromDict(
  raw: Record<string, unknown>,
): CircleSettings {
  const settings = { ...raw, ...defaultSettings() };
  const auth = isRecord(raw.auth) ? raw.auth : {};
  settings.auth = Object.fromEntries(
    Object.entries(defaultAuth()).map(([key, fallback]) => [
      key,
      String(auth[key] || fallback),
    ]),
  ) as unknown as ModelAuth;
  settings.version = Number(raw.version || 1);
  settings.initialized = Boolean(raw.initialized);
  settings.trusted_folders = strings(raw.trusted_folders);
  const theme = String(raw.theme || '')
    .trim()
    .toLowerCase();
  settings.theme = theme === 'dark' || theme === 'light' ? theme : 'auto';
  settings.mcp_servers = Array.isArray(raw.mcp_servers)
    ? raw.mcp_servers.filter(isRecord)
    : [];
  settings.extensions = isRecord(raw.extensions)
    ? (Object.fromEntries(
        Object.entries(raw.extensions).filter(([, value]) => isRecord(value)),
      ) as Record<string, Record<string, unknown>>)
    : {};
  settings.credential_files = strings(raw.credential_files);
  settings.trust_cert_files = strings(raw.trust_cert_files);
  settings.allowed_commands = strings(raw.allowed_commands);
  settings.default_mode = modeName(raw.default_mode);
  settings.enabled_models = strings(raw.enabled_models);
  settings.models = Object.fromEntries(
    Object.entries(isRecord(raw.models) ? raw.models : {}).flatMap(
      ([name, entry]) =>
        isRecord(entry) ? [[name, structuredClone(entry)]] : [],
    ),
  );
  settings.update_check =
    raw.update_check === undefined ? true : Boolean(raw.update_check);
  settings.default_thinking = String(raw.default_thinking || '')
    .trim()
    .toLowerCase();
  const double = String(raw.double_escape || '')
    .trim()
    .toLowerCase();
  settings.double_escape =
    double === 'fork' || double === 'none' ? double : 'tree';
  settings.hide_thinking = Boolean(raw.hide_thinking);
  const folder =
    typeof raw.workspace_folder === 'string' ? raw.workspace_folder.trim() : '';
  settings.workspace_folder =
    folder.length && folder.length <= 4096 ? folder : '';
  const tasks =
    typeof raw.task_folder === 'string' ? raw.task_folder.trim() : '';
  settings.task_folder = tasks.length && tasks.length <= 4096 ? tasks : '';
  settings.variables = Object.fromEntries(
    Object.entries(isRecord(raw.variables) ? raw.variables : {}).filter(
      ([name, value]) =>
        VARIABLE_NAME.test(name) &&
        typeof value === 'string' &&
        value.length <= MAX_VARIABLE,
    ),
  ) as Record<string, string>;
  return settings;
}
export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temporary, path);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}
export function loadSettings(home = circleHome()): CircleSettings {
  const path = settingsPath(home);
  if (!existsSync(path)) return defaultSettings();
  const raw = readJson(path);
  if (!isRecord(raw)) throw new Error('settings.json must contain an object');
  return loadSettingsFromDict(raw);
}
export function saveSettings(
  settings: CircleSettings,
  home = circleHome(),
): string {
  const path = settingsPath(ensureHome(home));
  return withPrivateJsonLock(path, () => saveSettingsUnlocked(settings, path));
}
function saveSettingsUnlocked(settings: CircleSettings, path: string): string {
  let previous: Record<string, unknown> = {};
  try {
    const raw = readJson(path);
    if (isRecord(raw)) previous = raw;
  } catch {
    /* Initial setup can repair malformed settings. */
  }
  writePrivateJson(path, { ...previous, ...settings });
  return path;
}
// The public settings API is synchronous. Critical sections contain only local reads and
// atomic renames; brief bounded retries serialize other Circle processes without dropping
// a field another terminal just changed. Never call an asynchronous operation inside one.
function transientLockError(error: unknown): boolean {
  return ['EPERM', 'EACCES', 'EBUSY'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}
function retryLockFileOperation<T>(operation: () => T): T {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      if (!transientLockError(error) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
const privateJsonLockFs = { ...fs };
for (const method of [
  'mkdirSync',
  'statSync',
  'rmdirSync',
  'utimesSync',
] as const)
  Object.defineProperty(privateJsonLockFs, method, {
    value: (...args: unknown[]) =>
      retryLockFileOperation(() => Reflect.apply(fs[method], fs, args)),
  });

export function withPrivateJsonLock<T>(path: string, operation: () => T): T {
  const deadline = Date.now() + 5000;
  let release: (() => void) | undefined;
  while (!release) {
    try {
      release = lockfile.lockSync(path, {
        realpath: false,
        stale: 30000,
        update: 5000,
        // Retry the filesystem primitive itself, especially release: replaying a
        // committed operation after an unlock error can duplicate its writes.
        fs: privateJsonLockFs,
      });
    } catch (error) {
      if (
        ((error as NodeJS.ErrnoException).code !== 'ELOCKED' &&
          !transientLockError(error)) ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    release();
  }
}
// Settings and credentials describe one connection. Hold this across login/logout
// writes and SDK construction so another process cannot observe half of the pair.
const connectionSections = new Set<string>();
export function withConnectionLock<T>(home: string, operation: () => T): T {
  const path = join(realpathSync(ensureHome(home)), 'connection-state');
  // All callers are synchronous; nested fingerprint/client reads belong to the same
  // critical section, while another process still contends on the filesystem lock.
  if (connectionSections.has(path)) return operation();
  return withPrivateJsonLock(path, () => {
    connectionSections.add(path);
    try {
      return operation();
    } finally {
      connectionSections.delete(path);
    }
  });
}
export function loadCredentials(home = circleHome()): Record<string, string> {
  const path = credentialsPath(home);
  if (!existsSync(path)) return {};
  const raw = readJson(path);
  if (!isRecord(raw))
    throw new Error('credentials.json must contain an object');
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, String(value)]),
  );
}
export function saveCredentials(
  credentials: Record<string, string>,
  home = circleHome(),
): string {
  const path = credentialsPath(ensureHome(home));
  withPrivateJsonLock(path, () =>
    writePrivateJson(path, { ...loadCredentials(home), ...credentials }),
  );
  return path;
}
export function clearCredentials(home = circleHome()): string {
  const path = credentialsPath(ensureHome(home));
  withPrivateJsonLock(path, () => writePrivateJson(path, {}));
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'CIRCLE_MODEL',
  ])
    delete process.env[key];
  return path;
}
export function isReady(settings: CircleSettings): boolean {
  return (
    settings.initialized &&
    Boolean(settings.auth.model && settings.auth.base_url)
  );
}
export function isFolderTrusted(
  settings: CircleSettings,
  workspace: string,
): boolean {
  return settings.trusted_folders.some(
    (folder) => normalizeWorkspace(folder) === normalizeWorkspace(workspace),
  );
}
export function trustFolder(
  settings: CircleSettings,
  workspace: string,
): CircleSettings {
  const copy = structuredClone(settings);
  const target = normalizeWorkspace(workspace);
  if (!copy.trusted_folders.includes(target)) copy.trusted_folders.push(target);
  return copy;
}
/** Takes away a folder's trust: Circle stops reading anything from it again. */
export function untrustFolder(
  settings: CircleSettings,
  workspace: string,
): CircleSettings {
  const copy = structuredClone(settings);
  const target = normalizeWorkspace(workspace);
  copy.trusted_folders = copy.trusted_folders.filter(
    (folder) => normalizeWorkspace(folder) !== target,
  );
  return copy;
}
export function withConnection(
  auth: ModelAuth,
  home = circleHome(),
): CircleSettings {
  let out: CircleSettings;
  try {
    out = loadSettings(home);
  } catch {
    out = defaultSettings();
  }
  if (
    out.auth.base_url.replace(/\/+$/, '') !== auth.base_url.replace(/\/+$/, '')
  )
    out.enabled_models = [];
  return { ...out, initialized: true, auth };
}
// Whether an empty key may keep the saved one for `url`: only when Circle was set up before
// and `url` is on the saved endpoint's host and port. A key saved for one provider is never
// sent to another; a new host needs its key typed.
export function keepsSavedKey(saved: CircleSettings, url: string): boolean {
  if (!saved.initialized || !saved.auth.base_url) return false;
  try {
    return (
      new URL(url.trim()).host.toLowerCase() ===
      new URL(saved.auth.base_url.trim()).host.toLowerCase()
    );
  } catch {
    return false;
  }
}
export function applyAuthToEnviron(
  settings: CircleSettings,
  home = circleHome(),
): void {
  const credentials = loadCredentials(home);
  const key =
    credentials[settings.auth.api_key_ref] || credentials.api_key || '';
  const prefix =
    settings.auth.protocol === 'anthropic' ? 'ANTHROPIC' : 'OPENAI';
  if (settings.auth.base_url)
    process.env[`${prefix}_BASE_URL`] = settings.auth.base_url;
  if (key) process.env[`${prefix}_API_KEY`] = key;
  if (settings.auth.model) process.env.CIRCLE_MODEL = settings.auth.model;
}
export const PROJECT_KEYS = [
  'model',
  'default_thinking',
  'enabled_models',
  'double_escape',
  'hide_thinking',
  'theme',
  'credential_files',
  'allowed_commands',
] as const;
export type ProjectChanges = Record<string, [unknown, unknown]>;
export function applyProjectSettings(
  settings: CircleSettings,
  workspace: string,
  home = circleHome(),
): { changed: ProjectChanges; problems: string[] } {
  const path = join(workspace, '.circle', 'settings.json');
  const changed: ProjectChanges = {};
  // Running Circle in the folder that holds `CIRCLE_HOME` would otherwise read the global
  // settings.json as a project's, and report every key it owns as a problem.
  if (normalizeWorkspace(path) === normalizeWorkspace(settingsPath(home)))
    return { changed, problems: [] };
  if (!existsSync(path)) return { changed, problems: [] };
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (error) {
    return { changed, problems: [`${path} could not be read: ${error}`] };
  }
  if (!isRecord(raw))
    return { changed, problems: [`${path} should be a JSON object`] };
  const problems = Object.keys(raw)
    .filter(
      (key) => !PROJECT_KEYS.includes(key as (typeof PROJECT_KEYS)[number]),
    )
    .map((key) => `${path}: '${key}' is not a project setting`);
  const allowed = Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) =>
        PROJECT_KEYS.includes(key as (typeof PROJECT_KEYS)[number]) &&
        key !== 'model',
    ),
  );
  const project = loadSettingsFromDict({ ...settings, ...allowed });
  if (
    typeof raw.model === 'string' &&
    raw.model.trim() &&
    raw.model.trim() !== settings.auth.model
  ) {
    changed.model = [settings.auth.model, raw.model.trim()];
    settings.auth.model = raw.model.trim();
  }
  for (const key of PROJECT_KEYS) {
    if (key === 'model' || !(key in raw)) continue;
    // A project adds to these two lists, never narrows them.
    const theirs =
      key === 'credential_files' || key === 'allowed_commands'
        ? [...new Set([...settings[key], ...project[key]])]
        : project[key];
    if (JSON.stringify(theirs) !== JSON.stringify(settings[key])) {
      changed[key] = [structuredClone(settings[key]), structuredClone(theirs)];
      settings[key] = theirs as never;
    }
  }
  return { changed, problems };
}
// Changes one part of settings.json as it is on disk. Values that hold only for this run (a
// project's .circle/settings.json, `--model`, `--thinking`) stay out of the file.
export function saveSettingsChange(
  home: string,
  change: (saved: CircleSettings) => void,
): CircleSettings {
  const path = settingsPath(ensureHome(home));
  return withPrivateJsonLock(path, () => {
    const saved = loadSettings(home);
    change(saved);
    saveSettingsUnlocked(saved, path);
    return saved;
  });
}
// Settings as one run uses them: the saved ones, the project's own in a trusted folder, then
// `--model`.
export function settingsForRun(
  home: string,
  workspace: string,
  modelOverride?: string,
): { settings: CircleSettings; problems: string[] } {
  const settings = loadSettings(home);
  const { problems } = isFolderTrusted(settings, workspace)
    ? applyProjectSettings(settings, workspace, home)
    : { problems: [] };
  if (modelOverride) settings.auth.model = modelOverride;
  return { settings, problems };
}
export function withoutProjectSettings(
  settings: CircleSettings,
  changes: ProjectChanges,
): CircleSettings {
  const copy = structuredClone(settings);
  for (const [key, [mine, theirs]] of Object.entries(changes)) {
    if (key === 'model') {
      if (copy.auth.model === theirs) copy.auth.model = String(mine);
    } else if (JSON.stringify(copy[key]) === JSON.stringify(theirs))
      copy[key] = structuredClone(mine);
  }
  return copy;
}
