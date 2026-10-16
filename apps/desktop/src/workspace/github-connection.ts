import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { GitHubConnectionState } from '../../../../src/github_connection.js';
import {
  DeliveryLogin,
  type CredentialStore,
  type LoginSpawn,
} from './delivery-login.ts';
const exec = promisify(execFile);
type Runner = (
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal?: AbortSignal,
) => Promise<string>;
/** One explicitly authorized connection per native profile. Never falls back to host gh credentials. */
export class NativeGitHubConnection {
  private state: GitHubConnectionState = {
    provider: 'github',
    client: 'GitHub CLI',
    epoch: 0,
    state: 'disconnected',
    repositories: [],
    remoteRevocation: 'not-requested',
  };
  private listeners = new Set<(state: GitHubConnectionState) => void>();
  private login: DeliveryLogin;
  private ready: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private attempt?: { id: string; epoch: number };
  private active = false;
  private lifetime = new AbortController();
  private disposed = false;
  private connecting?: Promise<GitHubConnectionState>;
  private polling = false;
  private restoreEpoch?: number;
  private command: Runner;
  private persistence: Promise<void> = Promise.resolve();
  private metadata: string;
  private config: string;
  constructor(
    private options: {
      dataDir: string;
      ghPath: string;
      spawn: LoginSpawn;
      credentialStore?: CredentialStore;
      command?: Runner;
      credentialCommand?: ConstructorParameters<typeof DeliveryLogin>[4];
    },
  ) {
    this.metadata = path.join(options.dataDir, 'github-connection.json');
    this.config = path.join(options.dataDir, 'github-empty-config');
    this.command =
      options.command ??
      (async (args, env, cwd, signal) =>
        (
          await exec(options.ghPath, args, {
            encoding: 'utf8',
            env,
            cwd,
            signal,
            timeout: 120000,
            maxBuffer: 8 * 1024 * 1024,
          })
        ).stdout);
    this.login = new DeliveryLogin(
      options.spawn,
      options.ghPath,
      options.dataDir,
      options.credentialStore,
      options.credentialCommand,
    );
    this.ready = this.initialize();
  }
  private async initialize() {
    await mkdir(this.config, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(this.metadata, 'utf8'));
      if (Number.isSafeInteger(data.epoch) && data.epoch >= 0)
        this.state.epoch = data.epoch;
      if (Array.isArray(data.repositories))
        this.state.repositories = this.repositories(data.repositories);
      if (data.resume === true) {
        this.state.state = 'authorizing';
        this.state.storage = 'encrypted';
        this.restoreEpoch = this.state.epoch;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.active = false;
        this.state.state = 'error';
        this.state.error = 'saved GitHub connection could not be verified';
      }
    }
  }
  private async restore(epoch: number) {
    try {
      await this.verify(epoch);
      if (epoch !== this.state.epoch || this.disposed) return;
      this.active = true;
      this.emit();
    } catch {
      if (epoch === this.state.epoch && !this.disposed) {
        this.active = false;
        this.state.state = 'error';
        this.state.error = 'saved GitHub connection could not be verified';
        this.emit();
      }
    }
  }
  private repositories(value: unknown): string[] {
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      value.some(
        (item) => typeof item !== 'string' || !/^[-\w.]+\/[-\w.]+$/.test(item),
      )
    )
      throw Error('explicit GitHub repositories are required');
    return [...new Set(value as string[])];
  }
  private persist(resume: boolean) {
    const epoch = this.state.epoch,
      payload = JSON.stringify({
        epoch,
        repositories: this.state.repositories,
        resume,
      });
    const work = this.persistence
      .catch(() => {})
      .then(async () => {
        if (epoch !== this.state.epoch) return;
        const temporary = this.metadata + '.' + epoch + '.tmp';
        try {
          await writeFile(temporary, payload, { mode: 0o600 });
          if (epoch === this.state.epoch)
            await rename(temporary, this.metadata);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      });
    this.persistence = work;
    return work;
  }
  snapshot(): GitHubConnectionState {
    return structuredClone(this.state);
  }
  subscribe(listener: (state: GitHubConnectionState) => void) {
    this.listeners.add(listener);
    void this.ready
      .then(() => {
        if (
          this.restoreEpoch === undefined ||
          this.disposed ||
          !this.listeners.size
        )
          return;
        const epoch = this.restoreEpoch;
        this.restoreEpoch = undefined;
        void this.restore(epoch);
      })
      .catch(() => {});
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    const state = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        /* Consumers can re-read state. */
      }
    }
  }
  private env(token: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'GH_REPO',
      'GH_HOST',
    ])
      delete env[key];
    return {
      ...env,
      GH_CONFIG_DIR: this.config,
      GH_HOST: 'github.com',
      GH_TOKEN: token,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
    };
  }
  async run(
    args: string[],
    epoch: number,
    cwd = this.options.dataDir,
    signal?: AbortSignal,
    repository?: string,
  ) {
    await this.ready;
    signal = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    if (
      !this.active ||
      this.state.state !== 'connected' ||
      epoch !== this.state.epoch
    )
      throw Error('GitHub connection is disconnected or expired');
    signal?.throwIfAborted();
    const token = await this.login.token();
    signal?.throwIfAborted();
    if (!token) throw Error('GitHub authorization is unavailable');
    if (
      !this.active ||
      this.state.state !== 'connected' ||
      epoch !== this.state.epoch
    )
      throw Error('GitHub connection changed');
    try {
      if (repository) this.assertGrant(epoch, repository);
      const env = this.env(token);
      if (repository) env.GH_REPO = repository;
      const text = await this.command(args, env, cwd, signal);
      signal?.throwIfAborted();
      if (epoch !== this.state.epoch || !this.active)
        throw Error('connection changed');
      return text.split(token).join('[redacted]');
    } catch (error) {
      if (epoch !== this.state.epoch || !this.active)
        throw Error('GitHub connection changed');
      if (signal?.aborted)
        throw Error(
          'GitHub operation cancelled; reconcile any already sent changes before retrying',
        );
      const detail =
        String((error as { stderr?: string }).stderr ?? '') +
        ' ' +
        (error instanceof Error ? error.message : '');
      const status = (error as { status?: number }).status;
      if (status === 401 || /HTTP 401|Bad credentials/i.test(detail)) {
        this.active = false;
        this.state.epoch++;
        this.state.state = 'error';
        this.state.error =
          'GitHub authorization expired; reconnect in settings';
        delete this.state.account;
        this.emit();
        await Promise.allSettled([
          this.persist(false),
          this.login.disconnect(),
        ]);
        throw Error('GitHub authorization expired; reconnect in settings');
      }
      this.state.error =
        status === 403 || /HTTP 403/i.test(detail)
          ? 'GitHub permission denied for this repository'
          : 'GitHub request failed; check the connection and retry the read';
      this.emit();
      throw Error(this.state.error);
    }
  }
  private async verify(epoch: number) {
    const token = await this.login.token();
    if (epoch !== this.state.epoch || this.state.state === 'disconnected')
      throw Error('connection changed');
    if (!token) throw Error('authorization unavailable');
    const data = JSON.parse(
      await this.command(
        ['api', 'user', '--jq', '{login: .login, id: .id}'],
        this.env(token),
        this.options.dataDir,
        this.lifetime.signal,
      ),
    );
    if (epoch !== this.state.epoch) return;
    if (
      typeof data.login !== 'string' ||
      !/^[-\w]{1,100}$/.test(data.login) ||
      !Number.isSafeInteger(data.id)
    )
      throw Error('invalid GitHub identity');
    this.state.account = { login: data.login, id: data.id };
    this.state.state = 'connected';
    delete this.state.error;
  }
  async status() {
    await this.ready;
    return this.snapshot();
  }
  connect(input: { storage: 'encrypted' | 'session'; repositories: string[] }) {
    const work = this.beginConnect(input);
    this.connecting = work;
    void work
      .finally(() => {
        if (this.connecting === work) this.connecting = undefined;
      })
      .catch(() => {});
    return work;
  }
  private async beginConnect(input: {
    storage: 'encrypted' | 'session';
    repositories: string[];
  }) {
    await this.ready;
    if (this.disposed) throw Error('GitHub connection is closed');
    if (!['encrypted', 'session'].includes(input.storage))
      throw Error('choose encrypted or session-only GitHub storage');
    const repositories = this.repositories(input.repositories);
    if (this.state.state === 'connected')
      throw Error('disconnect the current GitHub connection first');
    const epoch = ++this.state.epoch;
    this.active = false;
    this.state.repositories = repositories;
    delete this.state.account;
    delete this.state.error;
    delete this.state.authorization;
    this.state.state = 'authorizing';
    this.state.storage = input.storage;
    this.emit();
    try {
      await this.cancelCurrent();
      if (epoch !== this.state.epoch || this.disposed) return this.snapshot();
      await this.persist(false);
      if (epoch !== this.state.epoch || this.disposed) return this.snapshot();
      const login = await this.login.start({ storage: input.storage });
      if (epoch !== this.state.epoch || this.disposed) {
        await this.login.cancel(login.id);
        return this.snapshot();
      }
      this.attempt = { id: login.id, epoch };
      this.state.authorization = {
        id: login.id,
        url: login.url,
        code: login.code,
        status: login.status,
      };
      this.emit();
      this.timer = setInterval(() => void this.poll(), 250);
      this.timer.unref();
      return this.snapshot();
    } catch {
      if (epoch === this.state.epoch) {
        this.active = false;
        this.state.state = 'error';
        this.state.error = 'GitHub authorization could not start';
        this.emit();
      }
      throw Error('GitHub authorization could not start');
    }
  }
  private async poll() {
    if (this.polling || !this.attempt) return;
    this.polling = true;
    const { id, epoch } = this.attempt;
    try {
      const login = this.login.poll(id);
      if (epoch !== this.state.epoch) return;
      this.state.authorization = {
        id,
        url: login.url,
        code: login.code,
        status: login.status,
      };
      if (login.status === 'complete') {
        await this.verify(epoch);
        if (epoch !== this.state.epoch) return;
        this.active = true;
        this.state.storage = login.storage;
        await this.persist(login.storage === 'encrypted');
        clearInterval(this.timer);
        this.attempt = undefined;
        delete this.state.authorization;
      } else if (['failed', 'cancelled'].includes(login.status)) {
        this.active = false;
        this.state.state = login.status === 'failed' ? 'error' : 'disconnected';
        this.state.error = login.error;
        clearInterval(this.timer);
        this.attempt = undefined;
      }
      this.emit();
    } catch {
      if (epoch === this.state.epoch) {
        this.active = false;
        this.state.state = 'error';
        this.state.error = 'GitHub authorization could not be verified';
        this.emit();
      }
    } finally {
      this.polling = false;
    }
  }
  private async cancelCurrent() {
    clearInterval(this.timer);
    if (this.attempt) {
      const id = this.attempt.id;
      this.attempt = undefined;
      await this.login.cancel(id);
    }
  }
  async configure(epoch: number, repositories: string[]) {
    await this.ready;
    this.assertEpoch(epoch);
    const next = this.repositories(repositories);
    const previous = this.state.repositories;
    this.state.epoch++;
    const attempt = this.state.epoch;
    this.state.repositories = next;
    try {
      await this.persist(this.state.storage === 'encrypted');
    } catch {
      if (this.state.epoch === attempt) {
        this.state.epoch++;
        this.state.repositories = previous;
        this.state.error = 'GitHub repository settings could not be saved';
        this.emit();
      }
      throw Error('GitHub repository settings could not be saved');
    }
    this.assertEpoch(attempt);
    delete this.state.error;
    this.emit();
    return this.snapshot();
  }
  async disconnect(epoch: number) {
    await this.ready;
    if (epoch !== this.state.epoch) throw Error('GitHub connection changed');
    this.state.epoch++;
    this.active = false;
    this.state.state = 'disconnected';
    delete this.state.account;
    delete this.state.authorization;
    delete this.state.error;
    this.state.remoteRevocation = 'unconfirmed';
    this.emit();
    const cleanup = await Promise.allSettled([
      this.persist(false),
      (async () => {
        await this.connecting?.catch(() => {});
        const results = await Promise.allSettled([
          this.cancelCurrent(),
          this.login.disconnect(),
        ]);
        if (results.some((result) => result.status === 'rejected'))
          throw Error('GitHub authorization cleanup requires attention');
      })(),
    ]);
    if (cleanup.some((result) => result.status === 'rejected')) {
      this.state.error = 'local credential removal requires attention';
      this.emit();
    }
    return this.snapshot();
  }
  async cancel(epoch: number) {
    return this.disconnect(epoch);
  }
  assertEpoch(epoch: number) {
    if (
      epoch !== this.state.epoch ||
      this.state.state !== 'connected' ||
      !this.active
    )
      throw Error('GitHub connection changed');
  }
  assertGrant(epoch: number, repository: string) {
    if (
      epoch !== this.state.epoch ||
      this.state.state !== 'connected' ||
      !this.active ||
      !this.state.repositories.includes(repository)
    )
      throw Error('GitHub connection or repository permission changed');
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.state.epoch++;
    this.lifetime.abort();
    clearInterval(this.timer);
    this.active = false;
    await this.connecting?.catch(() => {});
    await this.cancelCurrent();
    await this.login.dispose();
    this.listeners.clear();
  }
}
