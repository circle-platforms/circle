import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  GITHUB_ADDITIONAL_SCOPES,
  type GitHubConnectionState,
} from '../../../../src/github_connection.js';
import {
  DeliveryLogin,
  type CredentialStore,
  type LoginSpawn,
} from './delivery-login.ts';
import {
  withGitHubPushCredentials,
  type GitPushAuthentication,
} from './git-push-auth.ts';
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
    requestedAdditionalScopes: [...GITHUB_ADDITIONAL_SCOPES],
    scopeVerification: 'not-reported',
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
  private disposal?: Promise<void>;
  private children = new Set<Promise<void>>();
  private connecting?: Promise<GitHubConnectionState>;
  private polling?: { id: string; epoch: number };
  private verification?: { epoch: number; controller: AbortController };
  private restoreEpoch?: number;
  private command: Runner;
  private persistence: Promise<void> = Promise.resolve();
  private metadata: string;
  private config: string;
  constructor(
    private options: {
      dataDir: string;
      ghPath: string;
      nodePath?: string;
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
      (async (args, env, cwd, signal) => {
        const request = exec(options.ghPath, args, {
          encoding: 'utf8',
          env,
          cwd,
          signal,
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
        });
        // execFile may reject on AbortError before the owned process and its
        // pipes close. Preserve that result, but do not release its resources
        // or report cancellation complete until close has actually occurred.
        let escalation: ReturnType<typeof setTimeout> | undefined;
        const escalate = () => {
          escalation ??= setTimeout(() => request.child.kill('SIGKILL'), 1000);
          escalation.unref();
        };
        const closed = new Promise<void>((resolve) => {
          request.child.once('close', () => {
            clearTimeout(escalation);
            signal?.removeEventListener('abort', escalate);
            resolve();
          });
        });
        this.children.add(closed);
        signal?.addEventListener('abort', escalate, { once: true });
        if (signal?.aborted) escalate();
        try {
          return (await request).stdout;
        } finally {
          await closed;
          this.children.delete(closed);
        }
      });
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
        this.state.authorizationPhase = 'verifying-account';
        this.restoreEpoch = this.state.epoch;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.active = false;
        this.state.state = 'error';
        delete this.state.authorizationPhase;
        this.state.lastAuthorizationOutcome = 'failed';
        this.state.error = 'saved GitHub connection could not be verified';
      }
    }
  }
  private async restore(epoch: number) {
    try {
      const account = await this.verify(epoch);
      if (epoch !== this.state.epoch || this.disposed || !account) return;
      this.state.account = account.account;
      this.state.grantedScopes = account.grantedScopes;
      this.state.scopeVerification =
        account.grantedScopes === undefined ? 'not-reported' : 'reported';
      this.state.state = 'connected';
      delete this.state.authorizationPhase;
      this.state.lastAuthorizationOutcome = 'connected';
      delete this.state.error;
      this.active = true;
      this.emit();
    } catch {
      if (epoch === this.state.epoch && !this.disposed) {
        this.active = false;
        this.state.state = 'error';
        delete this.state.authorizationPhase;
        this.state.lastAuthorizationOutcome = 'failed';
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
  gitPushAuthentication(
    epoch: number,
    repository: string,
    signal?: AbortSignal,
    assertActive: () => void = () => {},
  ): GitPushAuthentication {
    return {
      repository,
      withCredentials: async (run) => {
        const guard = () => {
          signal?.throwIfAborted();
          assertActive();
          this.assertGrant(epoch, repository);
        };
        guard();
        const token = await this.login.token();
        guard();
        if (!token) throw Error('connect GitHub in the GitHub plugin details');
        return withGitHubPushCredentials(
          {
            repository,
            token,
            ghPath: this.options.ghPath,
            nodePath: this.options.nodePath,
            env: this.env(token),
            signal,
            assertActive: guard,
          },
          run,
        );
      },
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
          'GitHub authorization expired; reconnect in the GitHub plugin details';
        delete this.state.account;
        delete this.state.grantedScopes;
        this.state.scopeVerification = 'not-reported';
        this.emit();
        await Promise.allSettled([
          this.persist(false),
          this.login.disconnect(),
        ]);
        throw Error(
          'GitHub authorization expired; reconnect in the GitHub plugin details',
        );
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
    const verification = { epoch, controller: new AbortController() };
    this.verification = verification;
    const signal = AbortSignal.any([
      this.lifetime.signal,
      verification.controller.signal,
    ]);
    try {
      const token = await this.login.token();
      signal.throwIfAborted();
      if (epoch !== this.state.epoch || this.state.state === 'disconnected')
        throw Error('connection changed');
      if (!token) throw Error('authorization unavailable');
      const response = (
        await this.command(
          ['api', 'user', '--include', '--jq', '{login: .login, id: .id}'],
          this.env(token),
          this.options.dataDir,
          signal,
        )
      ).replaceAll('\r\n', '\n');
      const separator = response.lastIndexOf('\n\n');
      const included = /^HTTP\/[\d.]+\s+\d{3}/.test(response) && separator >= 0;
      const data = JSON.parse(
        included ? response.slice(separator + 2) : response,
      );
      const scopeHeader = included
        ? /^x-oauth-scopes:[ \t]*([^\n]*)$/im.exec(
            response.slice(0, separator),
          )?.[1]
        : undefined;
      let grantedScopes: string[] | undefined;
      if (scopeHeader !== undefined) {
        const scopes = scopeHeader
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean);
        if (
          scopes.length <= 100 &&
          scopes.every(
            (scope) =>
              /^[a-z][a-z0-9:_-]{0,63}$/.test(scope) && !scope.includes(token),
          )
        )
          grantedScopes = [...new Set(scopes)];
      }
      signal.throwIfAborted();
      if (epoch !== this.state.epoch) return;
      if (
        typeof data.login !== 'string' ||
        !/^[-\w]{1,100}$/.test(data.login) ||
        !Number.isSafeInteger(data.id)
      )
        throw Error('invalid GitHub identity');
      return { account: { login: data.login, id: data.id }, grantedScopes };
    } finally {
      if (this.verification === verification) this.verification = undefined;
    }
  }
  async status() {
    await this.ready;
    return this.snapshot();
  }
  connect(input: { storage: 'encrypted' | 'session'; repositories: string[] }) {
    if (this.connecting)
      return Promise.reject(Error('GitHub authorization is already starting'));
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
    delete this.state.grantedScopes;
    this.state.scopeVerification = 'not-reported';
    delete this.state.error;
    delete this.state.authorization;
    this.state.state = 'authorizing';
    this.state.authorizationPhase = 'preparing-code';
    delete this.state.lastAuthorizationOutcome;
    this.state.storage = input.storage;
    this.emit();
    let phase: 'start' | 'metadata' = 'start';
    try {
      await this.cancelCurrent();
      if (epoch !== this.state.epoch || this.disposed) return this.snapshot();
      phase = 'metadata';
      await this.persist(false);
      phase = 'start';
      if (epoch !== this.state.epoch || this.disposed) return this.snapshot();
      const login = await this.login.start({ storage: input.storage });
      if (epoch !== this.state.epoch || this.disposed) {
        await this.login.cancel(login.id);
        return this.snapshot();
      }
      this.attempt = { id: login.id, epoch };
      this.state.authorizationPhase =
        login.code && login.url ? 'waiting-for-user' : 'preparing-code';
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
        delete this.state.authorizationPhase;
        this.state.lastAuthorizationOutcome = 'failed';
        this.state.error =
          phase === 'metadata'
            ? 'GitHub connection settings could not be saved'
            : 'GitHub authorization could not start';
        delete this.state.account;
        delete this.state.grantedScopes;
        this.state.scopeVerification = 'not-reported';
        delete this.state.authorization;
        await this.login.disconnect().catch(() => {
          this.state.error =
            (this.state.error ? this.state.error + '; ' : '') +
            'local credential removal requires attention';
        });
        this.emit();
      }
      throw Error(
        phase === 'metadata'
          ? 'GitHub connection settings could not be saved'
          : 'GitHub authorization could not start',
      );
    }
  }
  private async poll() {
    const attempt = this.attempt;
    if (!attempt || this.polling === attempt) return;
    this.polling = attempt;
    const { id, epoch } = attempt;
    let phase: 'verification' | 'metadata' = 'verification';
    try {
      const login = this.login.poll(id);
      if (epoch !== this.state.epoch) return;
      this.state.authorization = {
        id,
        url: login.url,
        code: login.code,
        status: login.status,
      };
      this.state.authorizationPhase =
        login.code && login.url ? 'waiting-for-user' : 'preparing-code';
      if (login.status === 'complete') {
        this.state.authorizationPhase = 'verifying-account';
        this.emit();
        const account = await this.verify(epoch);
        if (epoch !== this.state.epoch || !account) return;
        this.state.storage = login.storage;
        phase = 'metadata';
        await this.persist(login.storage === 'encrypted');
        if (epoch !== this.state.epoch) return;
        this.state.account = account.account;
        this.state.grantedScopes = account.grantedScopes;
        this.state.scopeVerification =
          account.grantedScopes === undefined ? 'not-reported' : 'reported';
        this.state.state = 'connected';
        delete this.state.authorizationPhase;
        this.state.lastAuthorizationOutcome = 'connected';
        delete this.state.error;
        this.active = true;
        clearInterval(this.timer);
        this.attempt = undefined;
        delete this.state.authorization;
      } else if (['failed', 'cancelled'].includes(login.status)) {
        this.active = false;
        this.state.state = login.status === 'failed' ? 'error' : 'disconnected';
        delete this.state.authorizationPhase;
        this.state.lastAuthorizationOutcome =
          login.status === 'failed' ? 'failed' : 'cancelled';
        this.state.error = login.error;
        delete this.state.account;
        delete this.state.grantedScopes;
        this.state.scopeVerification = 'not-reported';
        await this.login.disconnect().catch(() => {
          this.state.error =
            (this.state.error ? this.state.error + '; ' : '') +
            'local credential removal requires attention';
        });
        clearInterval(this.timer);
        this.attempt = undefined;
      }
      this.emit();
    } catch {
      if (epoch === this.state.epoch) {
        this.active = false;
        this.state.state = 'error';
        delete this.state.authorizationPhase;
        this.state.lastAuthorizationOutcome = 'failed';
        this.state.error =
          phase === 'metadata'
            ? 'GitHub connection settings could not be saved'
            : 'GitHub authorization could not be verified';
        delete this.state.account;
        delete this.state.grantedScopes;
        this.state.scopeVerification = 'not-reported';
        delete this.state.authorization;
        clearInterval(this.timer);
        this.attempt = undefined;
        await this.login.disconnect().catch(() => {
          this.state.error =
            (this.state.error ? this.state.error + '; ' : '') +
            'local credential removal requires attention';
        });
        await this.persist(false).catch(() => {});
        this.emit();
      }
    } finally {
      if (this.polling === attempt) this.polling = undefined;
    }
  }
  private async cancelCurrent() {
    clearInterval(this.timer);
    const verification = this.verification;
    verification?.controller.abort();
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
    const cancelling = this.state.state === 'authorizing';
    const beforeCode =
      cancelling &&
      this.state.authorizationPhase === 'preparing-code' &&
      !this.state.authorization?.code &&
      !(this.attempt && this.login.poll(this.attempt.id).code);
    const priorGrant =
      this.active ||
      Boolean(this.state.account) ||
      this.state.remoteRevocation === 'unconfirmed';
    this.state.epoch++;
    this.active = false;
    this.state.state = 'disconnected';
    delete this.state.authorizationPhase;
    this.state.lastAuthorizationOutcome = cancelling
      ? beforeCode
        ? 'cancelled-before-code'
        : 'cancelled'
      : 'disconnected';
    delete this.state.account;
    delete this.state.grantedScopes;
    this.state.scopeVerification = 'not-reported';
    delete this.state.authorization;
    delete this.state.error;
    this.state.remoteRevocation =
      beforeCode && !priorGrant ? 'not-requested' : 'unconfirmed';
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
  dispose(): Promise<void> {
    return (this.disposal ??= this.close());
  }
  private async close() {
    this.disposed = true;
    this.state.epoch++;
    this.lifetime.abort();
    clearInterval(this.timer);
    this.active = false;
    await this.connecting?.catch(() => {});
    try {
      await this.cancelCurrent();
      await this.login.dispose();
    } finally {
      await Promise.allSettled([...this.children]);
      this.listeners.clear();
    }
  }
}
