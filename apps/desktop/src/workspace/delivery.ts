import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitWorkspaceService } from './git.ts';
import {
  DeliveryLogin,
  type LoginSpawn,
  type CredentialStore,
} from './delivery-login.ts';
const exec = promisify(execFile);
const deliveryLocks = new Map<string, Promise<unknown>>();
export const GH_VERSION = '2.83.2';
export class DeliveryService {
  readonly git: GitWorkspaceService;
  readonly root: string;
  readonly ghPath: string;
  readonly login?: DeliveryLogin;
  constructor(
    root: string,
    ghPath = 'gh',
    options?: { spawn: LoginSpawn; credentialStore?: CredentialStore },
  ) {
    this.root = root;
    this.ghPath = ghPath;
    this.git = new GitWorkspaceService(root);
    if (options)
      this.login = new DeliveryLogin(
        options.spawn,
        ghPath,
        root,
        options.credentialStore,
      );
  }
  async gh(args: string[]) {
    const token = await this.login?.token();
    return (
      await exec(this.ghPath, args, {
        cwd: this.root,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
        env: {
          ...process.env,
          ...(token ? { GH_TOKEN: token } : {}),
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
        },
      })
    ).stdout;
  }
  async dispose() {
    await this.login?.dispose();
  }
  private async pr() {
    return JSON.parse(
      await this.gh([
        'pr',
        'view',
        '--json',
        'number,url,isDraft,headRefOid,headRefName,state',
      ]),
    );
  }
  async call(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!['publish', 'ready', 'retry'].includes(method))
      return this.execute(method, params);
    const key = (await this.git.snapshot()).root;
    const before = deliveryLocks.get(key) ?? Promise.resolve();
    const operation = before
      .catch(() => {})
      .then(() => this.execute(method, params));
    deliveryLocks.set(key, operation);
    try {
      return await operation;
    } finally {
      if (deliveryLocks.get(key) === operation) deliveryLocks.delete(key);
    }
  }
  private async execute(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === 'login') {
      if (!this.login) throw Error('native login helper is unavailable');
      if (params.action === 'poll') return this.login.poll(String(params.id));
      if (params.action === 'cancel')
        return this.login.cancel(String(params.id));
      return this.login.start();
    }
    if (method === 'status') {
      const auth = await this.gh(['auth', 'status']).then(
        () => true,
        () => false,
      );
      const version = (await this.gh(['--version'])).split('\n')[0];
      const pullRequest = await this.pr().catch(() => null);
      return {
        authenticated: auth,
        version,
        expectedVersion: GH_VERSION,
        pullRequest,
      };
    }
    if (method === 'checks')
      return JSON.parse(
        await this.gh([
          'pr',
          'checks',
          '--json',
          'name,state,bucket,link,workflow',
        ]).catch((error: { stdout?: string }) => {
          if (error.stdout) {
            const value = JSON.parse(error.stdout);
            if (Array.isArray(value)) return error.stdout;
          }
          throw error;
        }),
      );
    if (method === 'logs') {
      if (!Number.isSafeInteger(params.runId) || Number(params.runId) <= 0)
        throw Error('valid run id is required');
      return {
        text: await this.gh([
          'run',
          'view',
          String(params.runId),
          '--log-failed',
        ]),
      };
    }
    if (method === 'publish') {
      const state = await this.git.snapshot();
      if (state.revision !== params.revision)
        throw Error('repository changed; refresh before publishing');
      if (state.entries.length)
        throw Error('commit or preserve workspace changes before publishing');
      if (state.branch === 'detached' || /^(main|master)$/.test(state.branch))
        throw Error('publish from a feature branch');
      // Query first, including after an interrupted request; never blindly create a duplicate PR.
      const existing = await this.pr().catch(async () => {
        const list = JSON.parse(
          await this.gh([
            'pr',
            'list',
            '--head',
            state.branch,
            '--state',
            'open',
            '--json',
            'number,url,isDraft,headRefOid',
          ]),
        );
        return list[0] ?? null;
      });
      if (existing) {
        await this.git.call('push', { revision: state.revision });
        return this.pr();
      }
      if (
        typeof params.title !== 'string' ||
        !params.title.trim() ||
        typeof params.body !== 'string'
      )
        throw Error('title and body are required');
      await this.git.call('push', { revision: state.revision });
      try {
        await this.gh([
          'pr',
          'create',
          '--draft',
          '--head',
          state.branch,
          '--title',
          params.title,
          '--body',
          params.body,
        ]);
      } catch (error) {
        const recovered = await this.pr().catch(() => null);
        if (recovered) return recovered;
        throw Error(
          `publish result is unknown; refresh before retrying: ${String(error)}`,
        );
      }
      return this.pr();
    }
    if (method === 'ready') {
      const state = await this.git.snapshot();
      const pr = await this.pr();
      if (state.revision !== params.revision || state.head !== pr.headRefOid)
        throw Error('PR head changed; refresh checks');
      const checks = (await this.call('checks')) as { bucket: string }[];
      if (!checks.length || checks.some((c) => c.bucket !== 'pass'))
        throw Error('all checks must pass before requesting review');
      await this.gh(['pr', 'ready']);
      return this.pr();
    }
    if (method === 'retry') {
      if (!Number.isSafeInteger(params.runId) || Number(params.runId) <= 0)
        throw Error('valid run id is required');
      await this.gh(['run', 'rerun', String(params.runId), '--failed']);
      return { requested: true };
    }
    throw Error('unknown delivery method');
  }
}
