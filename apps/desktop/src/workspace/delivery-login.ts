import { GITHUB_ADDITIONAL_SCOPES } from '../../../../src/github_connection.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
type CredentialCommand = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    encoding: 'utf8';
    timeout: number;
    maxBuffer: number;
  },
) => Promise<{ stdout: string }>;
export interface LoginPty {
  onData(callback: (data: string) => void): unknown;
  onExit(callback: (event: { exitCode: number }) => void): unknown;
  write(data: string): void;
  kill(): void;
}
export type LoginSpawn = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => LoginPty;
export interface CredentialStore {
  get(): Promise<string | undefined>;
  put(token: string): Promise<void>;
  delete?(): Promise<void>;
}
export type LoginState = {
  id: string;
  status:
    'starting' | 'waiting' | 'saving' | 'complete' | 'failed' | 'cancelled';
  url?: string;
  code?: string;
  error?: string;
  storage?: 'encrypted' | 'session';
};
/** Windows treats environment names case-insensitively, even when a copied JS
 * object contains differently cased aliases. Never inherit a host credential or
 * competing configuration/browser override into this explicit device grant. */
export function githubLoginEnvironment(
  inherited: NodeJS.ProcessEnv,
  directory: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited };
  for (const key of Object.keys(env)) {
    if (
      /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_CONFIG_DIR|GH_HOST|GH_REPO|GH_DEBUG|BROWSER|GH_BROWSER|GH_NO_UPDATE_NOTIFIER|GH_ACCESSIBLE_PROMPTER)$/i.test(
        key,
      )
    )
      delete env[key];
  }
  return {
    ...env,
    GH_CONFIG_DIR: directory,
    BROWSER: 'false',
    GH_BROWSER: 'false',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_ACCESSIBLE_PROMPTER: '1',
  };
}

/** Only sanitized device flow state crosses the bridge. Dedicated 0700 temp configs are removed before completion. */
export class DeliveryLogin {
  private entries = new Map<
    string,
    {
      state: LoginState;
      process: LoginPty;
      directory: string;
      exited: boolean;
      exit: Promise<void>;
      cleanup?: Promise<void>;
      completion?: Promise<void>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private spawn: LoginSpawn;
  private executable: string;
  private cwd: string;
  private store?: CredentialStore;
  private sessionToken?: string;
  constructor(
    spawn: LoginSpawn,
    executable: string,
    cwd: string,
    store?: CredentialStore,
    private readonly credentialCommand: CredentialCommand = exec,
  ) {
    this.spawn = spawn;
    this.executable = executable;
    this.cwd = cwd;
    this.store = store;
  }
  async token() {
    return this.sessionToken ?? this.store?.get();
  }
  async start(
    options: { storage: 'encrypted' | 'session' } = { storage: 'encrypted' },
  ) {
    for (const entry of this.entries.values())
      if (['starting', 'waiting'].includes(entry.state.status))
        return { ...entry.state };
    const id = randomUUID();
    const state: LoginState = { id, status: 'starting' };
    const directory = await mkdtemp(path.join(tmpdir(), 'circle-gh-auth-'));
    await chmod(directory, 0o700);
    const env = githubLoginEnvironment(process.env, directory);
    let child: LoginPty;
    try {
      child = this.spawn(
        this.executable,
        [
          'auth',
          'login',
          '--hostname',
          'github.com',
          '--git-protocol',
          'https',
          '--web',
          '--scopes',
          GITHUB_ADDITIONAL_SCOPES.join(','),
          '--insecure-storage',
        ],
        { name: 'xterm-256color', cols: 100, rows: 30, cwd: this.cwd, env },
      );
    } catch {
      await rm(directory, { recursive: true, force: true });
      throw Error('GitHub login helper could not start');
    }
    let buffer = '';
    let advanced = false;
    let declinedGitCredentialSetup = false;
    const timer = setTimeout(() => {
      void this.cancel(id);
    }, 300_000);
    timer.unref();
    let markExited!: () => void;
    const exit = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const entry = {
      state,
      process: child,
      directory,
      timer,
      exit,
      exited: false,
    };
    this.entries.set(id, entry);
    child.onData((data) => {
      buffer = (buffer + data)
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .slice(-16000);
      // The bundled CLI asks this even with --web/--git-protocol. Circle
      // supplies credentials per native operation and must never configure the
      // user's Git helper. Answer only this specific, known confirmation.
      if (
        !declinedGitCredentialSetup &&
        /Authenticate Git with your GitHub credentials\?\s*(?:\([Yy]\/[Nn]\)|\(default: yes\)\s*\[[Yy]\/[Nn]\])/i.test(
          buffer,
        )
      ) {
        declinedGitCredentialSetup = true;
        child.write('n\n');
      }
      const code = buffer.match(
        /(?:one-time code|code:)\s*:?\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i,
      )?.[1];
      if (code) {
        state.code = code.toUpperCase();
        state.url = 'https://github.com/login/device';
        state.status = 'waiting';
      }
      if (state.code && !advanced && /press enter.*browser/i.test(buffer)) {
        advanced = true;
        child.write('\r');
      }
    });
    child.onExit(({ exitCode }) => {
      entry.exited = true;
      markExited();
      clearTimeout(timer);
      const completion = (async () => {
        let securePersistenceFailed = false;
        try {
          if (this.poll(id).status === 'cancelled') return;
          if (exitCode !== 0) throw Error('authorization failed');
          const result = await this.credentialCommand(
            this.executable,
            ['auth', 'token', '--hostname', 'github.com'],
            {
              cwd: this.cwd,
              env,
              encoding: 'utf8',
              timeout: 10000,
              maxBuffer: 16384,
            },
          );
          const token = result.stdout.trim();
          if (!token || token.includes('\n')) throw Error('invalid credential');
          if (this.poll(id).status === 'cancelled') return;
          state.status = 'saving';
          if (options.storage === 'encrypted') {
            try {
              if (!this.store) throw Error('secure persistence unavailable');
              await this.store.put(token);
            } catch {
              securePersistenceFailed = true;
              throw Error('secure credential storage is unavailable');
            }
            if (this.poll(id).status === 'cancelled') {
              await this.store.delete?.();
              return;
            }
          }
          if (this.poll(id).status === 'cancelled') return;
          this.sessionToken = token;
          state.storage = options.storage;
          await this.cleanup(id);
          state.status = 'complete';
        } catch {
          this.sessionToken = undefined;
          const removed = await Promise.allSettled([
            Promise.resolve().then(() => this.store?.delete?.()),
          ]);
          if (state.status !== 'cancelled') {
            state.status = 'failed';
            state.error = securePersistenceFailed
              ? 'secure credential storage is unavailable'
              : 'GitHub authorization did not complete';
            if (removed.some((item) => item.status === 'rejected'))
              state.error += '; local credential removal requires attention';
          }
        } finally {
          await this.cleanup(id).catch(() => {
            state.status = 'failed';
            state.error = 'temporary authorization cleanup failed';
          });
        }
      })();
      const item = this.entries.get(id);
      if (item) item.completion = completion;
    });
    return { ...state };
  }
  poll(id: string) {
    const item = this.entries.get(id);
    if (!item) throw Error('unknown login request');
    return { ...item.state };
  }
  private cleanup(id: string): Promise<void> {
    const item = this.entries.get(id);
    if (!item) return Promise.reject(Error('unknown login request'));
    return (item.cleanup ??= rm(item.directory, {
      recursive: true,
      force: true,
    }));
  }
  async cancel(id: string) {
    const item = this.entries.get(id);
    if (!item) throw Error('unknown login request');
    if (['starting', 'waiting', 'saving'].includes(item.state.status)) {
      item.state.status = 'cancelled';
      clearTimeout(item.timer);
      if (!item.exited) item.process.kill();
    }
    if (item.state.status === 'cancelled') {
      await item.exit;
      await item.completion;
      await this.cleanup(id);
    }
    return { ...item.state };
  }
  async disconnect() {
    this.sessionToken = undefined;
    const results = await Promise.allSettled(
      [...this.entries.keys()].map((id) => this.cancel(id)),
    );
    this.sessionToken = undefined;
    await this.store?.delete?.();
    if (results.some((result) => result.status === 'rejected'))
      throw Error('GitHub helper cleanup requires attention');
  }
  async dispose() {
    for (const id of this.entries.keys()) await this.cancel(id);
    this.entries.clear();
    this.sessionToken = undefined;
  }
}
