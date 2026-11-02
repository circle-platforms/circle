// Client-side installation and execution of the tools/ files a connected MCP server publishes
// under its /local-tools contract: the manifest is the canonical pack.json (its SHA-256 is the
// pack digest), every file is fetched and verified by size and SHA-256, and a failure leaves
// nothing behind. Execution expands %NAME% placeholders from the configured variables and the
// saved secrets, runs the script with the current Node binary, and redacts every secret value
// from the output.
//
// The serving side stays the authority: what runs here is a client preview. A result becomes
// evidence only when that side recomputes it.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isRecord, type CircleSettings } from './settings.js';

/** Limits of the local-tools contract, so the client refuses what the serving side refuses. */
export const LIMITS = {
  maxFiles: 2000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxDepth: 16,
} as const;

/** The universal Agent Skills root: Circle and DeepSeek Harness both read it. */
export const SKILLS_ROOT = join(homedir(), '.agents', 'skills');

export interface LocalToolsFile {
  path: string;
  sha256: string;
  size: number;
}

export interface InstalledPack {
  pack: string;
  version: string;
  digest: string;
  directory: string;
  files: LocalToolsFile[];
  installed: boolean;
}

export class LocalSkillsError extends Error {
  readonly fix: string;
  constructor(message: string, fix: string) {
    super(message);
    this.name = 'LocalSkillsError';
    this.fix = fix;
  }
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** The base URL for /local-tools: the MCP endpoint without its /mcp suffix. */
export function serverBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/mcp') ? trimmed.slice(0, -4) : trimmed;
}

export function parsePackRef(ref: string): { id: string; version: string } | null {
  const at = ref.indexOf('@');
  if (at <= 0 || at === ref.length - 1) return null;
  const id = ref.slice(0, at);
  const version = ref.slice(at + 1);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  return { id, version };
}

/**
 * The URL and the bearer token of the MCP server entry named `name`: its `url`, and the token
 * its Authorization header gives, either literally or as a `${secret:NAME}` template filled from
 * the saved secrets. The caller passes the saved secrets so nothing here reads the vault.
 */
export function resolveServer(
  settings: CircleSettings,
  secrets: Record<string, string>,
  name: string,
): { url: string; token: string } | { problem: string; fix: string } {
  const entry = settings.mcp_servers.filter(isRecord).find((server) => server.name === name);
  if (entry === undefined) {
    return { problem: `没有名为 ${name.slice(0, 64)} 的 MCP 服务器条目`, fix: '在 mcp_servers 里按这个名字配置它（url 与 Authorization 头）' };
  }
  const url = typeof entry.url === 'string' ? entry.url : '';
  let token = '';
  const headers = isRecord(entry.headers) ? entry.headers : {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization' || typeof value !== 'string') continue;
    const named = /\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/.exec(value);
    if (named !== null && secrets[named[1]!] !== undefined) token = secrets[named[1]!]!;
    else if (/^Bearer\s+[^$]/.test(value.trim())) token = value.trim().slice('Bearer '.length);
  }
  if (url.length === 0) return { problem: `MCP 服务器条目 ${name.slice(0, 64)} 没有 url`, fix: '在这个条目里写 url' };
  if (token.length === 0) {
    return { problem: `MCP 服务器条目 ${name.slice(0, 64)} 没有可用的 Bearer 令牌`, fix: '在它的 Authorization 头里写 Bearer ${secret:<名字>}，并用 /secrets <名字> 保存令牌' };
  }
  return { url, token };
}

/** Fetch with the bearer token, no redirects, and a bounded timeout. */
async function fetchBytes(url: string, token: string, limit: number, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status === 401) throw new LocalSkillsError('令牌无效或已撤销', '重新领取令牌后再试');
    if (response.status === 404) throw new LocalSkillsError('这个版本没有分给你、已下架或不存在', '向管理员确认分配后再试');
    if (!response.ok) throw new LocalSkillsError(`服务器回答了 HTTP ${response.status}`, '确认服务器的监听地址后再试');
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > limit) throw new LocalSkillsError(`文件超过上限 ${limit} 字节`, '确认发布内容后再试');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new LocalSkillsError(`文件超过上限 ${limit} 字节`, '确认发布内容后再试');
    return bytes;
  } catch (error) {
    if (error instanceof LocalSkillsError) throw error;
    if ((error as Error).name === 'AbortError') throw new LocalSkillsError(`服务器在 ${timeoutMs} ms 内没有回答`, '确认服务器可达后再试');
    throw new LocalSkillsError(`服务器连不上：${(error as Error).message}`, '确认服务器的监听地址与网络后再试');
  } finally {
    clearTimeout(timer);
  }
}

/** A manifest path that is safe to write under the pack directory. */
function safePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path) || path.includes('\\') || path.includes('\u0000')) return false;
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  if (parts.length > LIMITS.maxDepth) return false;
  return true;
}

interface Manifest {
  schema: string;
  id: string;
  version: string;
  files: LocalToolsFile[];
}

function parseManifest(bytes: Buffer): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new LocalSkillsError('清单不是完整的 JSON', '重新取这个版本后再试');
  }
  const manifest = value as Partial<Manifest>;
  if (manifest?.schema !== 'pack@1' || typeof manifest.id !== 'string' || typeof manifest.version !== 'string' || !Array.isArray(manifest.files)) {
    throw new LocalSkillsError('清单不是 pack@1', '确认发布内容后再试');
  }
  const files: LocalToolsFile[] = [];
  let total = 0;
  for (const entry of manifest.files as LocalToolsFile[]) {
    if (typeof entry?.path !== 'string' || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isInteger(entry.size) || entry.size < 0) {
      throw new LocalSkillsError('清单的 files 条目形状不对', '确认发布内容后再试');
    }
    if (!safePath(entry.path)) throw new LocalSkillsError(`清单里的路径不安全：${entry.path.slice(0, 120)}`, '要求包作者改正后重发');
    if (entry.size > LIMITS.maxFileBytes) throw new LocalSkillsError(`文件 ${entry.path} 超过单文件上限`, '要求包作者拆分后重发');
    total += entry.size;
    if (total > LIMITS.maxTotalBytes) throw new LocalSkillsError('整包超过总字节上限', '要求包作者拆分后重发');
    files.push({ path: entry.path, sha256: entry.sha256, size: entry.size });
  }
  if (files.length === 0) throw new LocalSkillsError('这个版本没有文件', '确认发布内容后再试');
  if (files.length > LIMITS.maxFiles) throw new LocalSkillsError('文件数超过上限', '要求包作者拆分后重发');
  return { schema: 'pack@1', id: manifest.id, version: manifest.version, files };
}

function backupRootFor(root: string): string {
  return join(root, '..', '.local-skills-backup');
}

async function readInstalled(dir: string): Promise<{ pack: string; version: string; digest: string } | null> {
  try {
    const bytes = await readFile(join(dir, 'pack.json'));
    const manifest = JSON.parse(bytes.toString('utf8')) as { id?: unknown; version?: unknown };
    if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string') return null;
    return { pack: manifest.id, version: manifest.version, digest: sha256Hex(bytes) };
  } catch {
    return null;
  }
}

/**
 * Install one pack version into `<root>/<pack>/`. The whole pack tree is written (tools/,
 * functions/, tables/, SKILL.md, pack.json) because tools import their package files.
 * An existing installation of the same digest is reported as installed; a different one
 * is refused unless `replace` is true, in which case the old tree is moved under the
 * backup directory first.
 */
export async function installPack(options: {
  url: string;
  token: string;
  ref: string;
  digest?: string;
  root?: string;
  replace?: boolean;
  timeoutMs?: number;
}): Promise<InstalledPack> {
  const { url, token, ref, digest, root = SKILLS_ROOT, replace = false, timeoutMs = 120_000 } = options;
  const parsed = parsePackRef(ref);
  if (parsed === null) throw new LocalSkillsError(`包引用不是 <id>@<version>：${ref.slice(0, 120)}`, '从服务器回答里的包引用照抄');
  const base = serverBaseUrl(url);
  if (base.length === 0) throw new LocalSkillsError('没有服务器地址', '在 mcp_servers 里给这个服务器条目写 url');

  const manifestBytes = await fetchBytes(`${base}/local-tools/${parsed.id}@${parsed.version}`, token, LIMITS.maxManifestBytes, timeoutMs);
  const computed = sha256Hex(manifestBytes);
  if (digest !== undefined && digest !== computed) {
    throw new LocalSkillsError(`清单的包号是 ${computed}，与预期的 ${digest} 不符`, '从服务器回答里重新抄包号，或请服务器管理员核对发布内容');
  }
  const manifest = parseManifest(manifestBytes);
  if (manifest.id !== parsed.id || manifest.version !== parsed.version) {
    throw new LocalSkillsError('清单的 id/version 与包引用不符', '确认发布内容后再试');
  }
  if (!manifest.files.some((file) => file.path.startsWith('tools/'))) {
    throw new LocalSkillsError('这个版本没有 tools/ 文件，不是客户端技能包', '换一个带本地工具的包');
  }

  const target = join(root, parsed.id);
  const existing = await readInstalled(target);
  if (existing !== null && existing.digest === computed) {
    return { pack: manifest.id, version: manifest.version, digest: computed, directory: target, files: manifest.files, installed: false };
  }
  if (existing !== null && !replace) {
    throw new LocalSkillsError(
      `已经装有 ${existing.pack}@${existing.version}（包号 ${existing.digest}），与这次的不同`,
      '确认要替换旧版本时用 replace:true；旧版本会备份到技能根之外的 .local-skills-backup',
    );
  }

  const staging = await mkdtempIn(root);
  try {
    for (const file of manifest.files) {
      const bytes = await fetchBytes(
        `${base}/local-tools/${parsed.id}@${parsed.version}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
        token,
        LIMITS.maxFileBytes,
        timeoutMs,
      );
      if (bytes.length !== file.size || sha256Hex(bytes) !== file.sha256) {
        throw new LocalSkillsError(`文件 ${file.path} 的大小或摘要不符`, '重新取这个版本后再试；连续出现时请管理员核对发布内容');
      }
      const destination = join(staging, ...file.path.split('/'));
      const inside = relative(staging, destination);
      if (inside.startsWith('..') || inside.split(sep).includes('..')) throw new LocalSkillsError(`路径越界：${file.path}`, '要求包作者改正后重发');
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    await writeFile(join(staging, 'pack.json'), manifestBytes);
    if (existing !== null) {
      const backup = join(backupRootFor(root), `${existing.pack}@${existing.version}`);
      await mkdir(dirname(backup), { recursive: true });
      await rm(backup, { recursive: true, force: true });
      await rename(target, backup);
    }
    await mkdir(root, { recursive: true });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { pack: manifest.id, version: manifest.version, digest: computed, directory: target, files: manifest.files, installed: true };
}

async function mkdtempIn(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const directory = join(root, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

/** The installed packs under a skills root, one entry per pack directory with a pack.json. */
export async function listInstalled(root: string = SKILLS_ROOT): Promise<Array<{ pack: string; version: string; digest: string; directory: string }>> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const found: Array<{ pack: string; version: string; digest: string; directory: string }> = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue;
    const directory = join(root, entry);
    const info = await readInstalled(directory);
    if (info !== null) found.push({ ...info, directory });
  }
  return found;
}

/**
 * Verify one installed pack against the digest it was installed from: pack.json hashes to
 * the digest, every manifest file exists with its size and SHA-256, and no extra files
 * sit beside them. Symlinks are refused.
 */
export async function verifyInstalled(directory: string, digest?: string): Promise<{ pack: string; version: string; digest: string; files: number }> {
  let stat;
  try {
    stat = await lstat(directory);
  } catch {
    throw new LocalSkillsError(`目录不存在：${directory}`, '先安装这个包');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalSkillsError('目标不是普通目录', '删掉它后重新安装');
  const bytes = await readFile(join(directory, 'pack.json'));
  const computed = sha256Hex(bytes);
  if (digest !== undefined && digest !== computed) {
    throw new LocalSkillsError(`pack.json 的包号是 ${computed}，与预期的 ${digest} 不符`, '重新安装，或确认你核对的是发布时的包号');
  }
  const manifest = parseManifest(bytes);
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const file of manifest.files) {
    const path = join(directory, ...file.path.split('/'));
    const info = await lstat(path).catch(() => null);
    if (info === null || !info.isFile() || info.isSymbolicLink()) throw new LocalSkillsError(`缺少文件或不是普通文件：${file.path}`, '重新安装这个包');
    const content = await readFile(path);
    if (content.length !== file.size || sha256Hex(content) !== file.sha256) throw new LocalSkillsError(`文件的大小或摘要不符：${file.path}`, '重新安装这个包');
  }
  const extras: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(directory, path).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new LocalSkillsError(`不允许符号链接：${rel}`, '重新安装这个包');
      if (entry.isDirectory()) await walk(path);
      else if (rel !== 'pack.json' && !listed.has(rel)) extras.push(rel);
    }
  };
  await walk(directory);
  if (extras.length > 0) throw new LocalSkillsError(`多出的文件：${extras.slice(0, 5).join('、')}`, '重新安装这个包');
  return { pack: manifest.id, version: manifest.version, digest: computed, files: manifest.files.length };
}

function expand(text: string, values: Record<string, string>): string {
  const names = Object.keys(values).filter((name) => values[name]!.length > 0).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const pattern = new RegExp(`%(${names.join('|')})%`, 'g');
  return text.replace(pattern, (_whole, name: string) => values[name]!);
}

function redact(text: string, values: Record<string, string>): string {
  let shown = text;
  for (const [name, value] of Object.entries(values).sort(([, a], [, b]) => b.length - a.length)) {
    if (value.length > 0) shown = shown.split(value).join(`%${name}%`);
  }
  return shown;
}

/**
 * Run one tool script of an installed pack: `node <pack>/tools/<script> ...args`, with
 * %NAME% placeholders expanded from the configured `variables` and the saved `secrets`. The
 * variables are also in the child's environment, the secrets are not. The output has every
 * secret value written back as its %NAME%.
 */
export async function runTool(options: {
  root?: string;
  pack: string;
  script: string;
  args?: string[];
  stdin?: string;
  variables?: Record<string, string>;
  secrets?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<{ exit_code: number | null; stdout: string; stderr: string; truncated: boolean }> {
  const { root = SKILLS_ROOT, pack, script, args = [], stdin = '', variables = {}, secrets = {}, timeoutMs = 300_000, maxOutputBytes = 1024 * 1024 } = options;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(pack)) throw new LocalSkillsError(`包名不合法：${pack.slice(0, 64)}`, '从服务器回答里的包引用照抄');
  if (!safePath(script) || !script.startsWith('tools/')) throw new LocalSkillsError(`脚本必须是 tools/ 下的相对路径：${script.slice(0, 120)}`, '从 SKILL.md 照抄脚本路径');
  const packDir = join(root, pack);
  const target = join(packDir, ...script.split('/'));
  const info = await lstat(target).catch(() => null);
  if (info === null || !info.isFile() || info.isSymbolicLink()) throw new LocalSkillsError(`没有这个脚本：${script}`, '先安装这个包，或从 SKILL.md 照抄脚本路径');
  if (!/\.(?:ts|mts|js|mjs)$/.test(script)) throw new LocalSkillsError('只运行 TypeScript/JavaScript 脚本', '从 SKILL.md 照抄脚本路径');

  const values = { ...variables, ...secrets };
  const expandedArgs = args.map((arg) => expand(arg, values));
  const expandedStdin = expand(stdin, values);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', ...variables };

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [target, ...expandedArgs], { cwd: packDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const collect = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) >= maxOutputBytes) {
        truncated = true;
        return current;
      }
      return current + chunk.toString('utf8');
    };
    const timer = setTimeout(() => {
      truncated = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        truncated = true;
        stdout = stdout.slice(0, maxOutputBytes);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
      if (Buffer.byteLength(stderr) > maxOutputBytes) {
        truncated = true;
        stderr = stderr.slice(0, maxOutputBytes);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new LocalSkillsError(`脚本没有启动：${error.message}`, '确认这个包已完整安装后再试'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exit_code: code, stdout: redact(stdout, secrets), stderr: redact(stderr, secrets), truncated });
    });
    child.stdin.end(expandedStdin);
  });
}
