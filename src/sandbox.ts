import { spawn, execFile } from 'node:child_process';
import { posix, relative, resolve, sep, win32 } from 'node:path';
import { canonicalPath, expandUser } from './paths.js';
import {
  classifyCommand,
  DEFAULT_CREDENTIAL_FILES,
  wildcard,
} from './approvals.js';
import { decodeOutput } from './output_encoding.js';
import { PLAN_FOLDER } from './plan_file.js';
/**
 * A path the operating system already anchors. On POSIX every leading `/` is absolute,
 * including `/workspace`, `/srv`, `/data` and `/code`. On Windows a drive (`C:\`, `C:/`),
 * a UNC share (`\\server\share`) and a root (`\foo`) are absolute. `~` is the home folder.
 */
export function isHostAbsolutePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (path.startsWith('~')) return true;
  return (platform === 'win32' ? win32 : posix).isAbsolute(path);
}
/**
 * Whether a name looks like it holds a secret: one of its words is KEY, TOKEN, SECRET, PASS,
 * PASSWORD, PASSPHRASE, CREDENTIAL, COOKIE, PRIVATE or the like, or ends in PASS, TOKEN,
 * SECRET or APIKEY. `OPENAI_API_KEY`, `X-Auth-Token` and `DBPASSWORD` do; `REGION` does not.
 */
export function secretLookingName(name: string): boolean {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some(
      (part) =>
        /^(KEYS?|TOKENS?|SECRETS?|PASS|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|COOKIES?|PRIVATE)$/.test(
          part,
        ) || /(PASS|PASSWORD|PASSWD|TOKEN|SECRET|APIKEY)$/.test(part),
    );
}
export function shellEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) => value !== undefined && !secretLookingName(name),
    ),
  );
}
// The most output bytes kept from a command; the text keeps its last 2 000 000 characters.
const OUTPUT_BYTES = 8_000_000;
function resolvedTarget(path: string): string {
  return canonicalPath(path);
}
export class Sandbox {
  readonly workspace: string;
  constructor(
    workspace: string,
    readonly offloadRoot?: string,
    readonly credentialFiles = DEFAULT_CREDENTIAL_FILES,
  ) {
    this.workspace = canonicalPath(workspace);
  }
  resolvePath(raw: string): string {
    if (raw.replace(/\\/g, '/').split('/').includes('..'))
      throw new Error('Path traversal not allowed');
    let full: string;
    const virtual = raw.replace(/^\/+/, '').replace(/\\/g, '/');
    const top = virtual.split('/')[0];
    if (
      this.offloadRoot &&
      [
        'conversation_history',
        'large_tool_results',
        'background_jobs',
        PLAN_FOLDER,
      ].includes(top ?? '')
    )
      full = resolve(this.offloadRoot, virtual);
    else
      full = isHostAbsolutePath(raw)
        ? resolve(expandUser(raw))
        : resolve(this.workspace, virtual);
    return resolvedTarget(full);
  }
  isInside(raw: string): boolean {
    const rel = relative(this.workspace, this.resolvePath(raw));
    return (
      rel !== '..' && !rel.startsWith('..' + sep) && !/^[A-Za-z]:/.test(rel)
    );
  }
  /** Whether a path is refused by name alone, without throwing: a search needs to count
   * the files it leaves out, not stop on the first one. */
  isCredentialPath(path: string): boolean {
    const name = path.replace(/\\/g, '/').split('/').at(-1)!;
    return this.credentialFiles.some((pattern) => wildcard(pattern, name));
  }
  checkCredentialPath(path: string): void {
    const name = path.replace(/\\/g, '/').split('/').at(-1)!;
    if (this.isCredentialPath(path))
      throw new Error(
        `Denied by approval policy: '${name}' is a credential file`,
      );
  }
  /** Whether a resolved path is in Circle's own output folder: offloaded history,
   * large tool results and job output. */
  isOffloadOutput(path: string): boolean {
    if (!this.offloadRoot) return false;
    const rel = relative(
      resolvedTarget(resolve(this.offloadRoot)),
      resolvedTarget(path),
    );
    return (
      rel === '' ||
      (rel !== '..' && !rel.startsWith('..' + sep) && !/^[A-Za-z]:/.test(rel))
    );
  }
  /** Whether a resolved path is in the folder of plan mode's plans, one per conversation. */
  isPlanFile(path: string): boolean {
    if (!this.offloadRoot) return false;
    const rel = relative(
      resolvedTarget(resolve(this.offloadRoot, PLAN_FOLDER)),
      resolvedTarget(path),
    );
    return (
      rel !== '' &&
      rel !== '..' &&
      !rel.startsWith('..' + sep) &&
      !/^[A-Za-z]:/.test(rel)
    );
  }
  /** Whether a resolved path is in the folder of command and job output. */
  isJobOutput(path: string): boolean {
    if (!this.offloadRoot) return false;
    const rel = relative(
      resolvedTarget(resolve(this.offloadRoot, 'background_jobs')),
      resolvedTarget(path),
    );
    return (
      rel === '' ||
      (rel !== '..' && !rel.startsWith('..' + sep) && !/^[A-Za-z]:/.test(rel))
    );
  }
  checkMutablePath(path: string): void {
    this.checkCredentialPath(path);
    if (this.isJobOutput(path))
      throw new Error('Background job output is read-only');
  }
  async execute(
    command: string,
    signal: AbortSignal,
    timeout = 120000,
  ): Promise<{ output: string; exit_code: number; timed_out: boolean }> {
    const found = classifyCommand(command, this.credentialFiles);
    if (found.verdict === 'DENY')
      throw new Error(found.message || found.reason);
    signal.throwIfAborted();
    return new Promise((resolveResult, reject) => {
      const child = spawn(command, {
        cwd: this.workspace,
        env: shellEnvironment(),
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Bytes, decoded once at the end, so no character is split between two reads.
      let chunks: Buffer[] = [];
      let size = 0;
      let cut = false;
      let stopping = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let escalation: NodeJS.Timeout | undefined;
      let windowsKill: Promise<void> | undefined;
      const collect = (chunk: Buffer): void => {
        chunks.push(chunk);
        size += chunk.length;
        if (size > 2 * OUTPUT_BYTES) {
          chunks = [Buffer.concat(chunks).subarray(-OUTPUT_BYTES)];
          size = OUTPUT_BYTES;
          cut = true;
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const kill = (force: boolean): void => {
        if (!child.pid) return;
        if (process.platform === 'win32')
          windowsKill ??= new Promise<void>((resolveKilled) =>
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () =>
              resolveKilled(),
            ),
          );
        else
          try {
            process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
          } catch {
            /* Group already gone. */
          }
      };
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        kill(false);
        escalation = setTimeout(() => kill(true), 500);
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        signal.removeEventListener('abort', stop);
      };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeout);
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', async (code) => {
        if (stopping) kill(true);
        await windowsKill;
        cleanup();
        let output = decodeOutput(Buffer.concat(chunks), { cutStart: cut });
        if (output.length > 2_000_000) output = output.slice(-2_000_000);
        resolveResult({
          output: signal.aborted
            ? output +
              '\nStopped: the user pressed esc, so the command was ended before it finished.'
            : timedOut
              ? output + '\nCommand timed out.'
              : output,
          exit_code: code ?? 130,
          timed_out: timedOut,
        });
      });
    });
  }
}
