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
/** Only sanitized device flow state crosses the bridge. Dedicated 0700 temp configs are removed before completion. */
export class DeliveryLogin {
  private entries = new Map<
    string,
    {
      state: LoginState;
      process: LoginPty;
      directory: string;
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
  async start() {
    for (const entry of this.entries.values())
      if (['starting', 'waiting'].includes(entry.state.status))
        return { ...entry.state };
    const id = randomUUID();
    const state: LoginState = { id, status: 'starting' };
    const directory = await mkdtemp(path.join(tmpdir(), 'circle-gh-auth-'));
    await chmod(directory, 0o700);
    const env: Record<string, string | undefined> = {
      ...process.env,
      GH_CONFIG_DIR: directory,
      BROWSER: 'false',
      GH_BROWSER: 'false',
      GH_NO_UPDATE_NOTIFIER: '1',
    };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
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
    const timer = setTimeout(() => {
      void this.cancel(id);
    }, 300_000);
    timer.unref();
    this.entries.set(id, { state, process: child, directory, timer });
    child.onData((data) => {
      buffer = (buffer + data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')).slice(
        -16000,
      );
      const code = buffer.match(
        /(?:one-time code|code:)\s*:?\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i,
      )?.[1];
      if (code) {
        state.code = code.toUpperCase();
        state.url = 'https://github.com/login/device';
        state.status = 'waiting';
      }
      if (!advanced && /press enter.*browser/i.test(buffer)) {
        advanced = true;
        child.write('\r');
      }
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      void (async () => {
        try {
          if (state.status === 'cancelled') return;
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
          this.sessionToken = token;
          state.storage = 'session';
          if (this.store) {
            try {
              await this.store.put(token);
              state.storage = 'encrypted';
            } catch {
              state.storage = 'session';
            }
          }
          await rm(directory, { recursive: true, force: true });
          state.status = 'complete';
        } catch {
          state.status = 'failed';
          state.error = 'GitHub authorization did not complete';
        } finally {
          await rm(directory, { recursive: true, force: true }).catch(() => {
            state.status = 'failed';
            state.error = 'temporary authorization cleanup failed';
          });
        }
      })();
    });
    return { ...state };
  }
  poll(id: string) {
    const item = this.entries.get(id);
    if (!item) throw Error('unknown login request');
    return { ...item.state };
  }
  async cancel(id: string) {
    const item = this.entries.get(id);
    if (!item) throw Error('unknown login request');
    if (['starting', 'waiting'].includes(item.state.status)) {
      item.state.status = 'cancelled';
      clearTimeout(item.timer);
      item.process.kill();
      await rm(item.directory, { recursive: true, force: true });
    }
    return { ...item.state };
  }
  async dispose() {
    for (const id of this.entries.keys()) await this.cancel(id);
    this.entries.clear();
    this.sessionToken = undefined;
  }
}
