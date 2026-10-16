import type {
  GitHubConnectionBackend,
  GitHubConnectionMethods,
  GitHubPR,
  GitHubCheck,
} from '../../../../src/github_connection.js';
import type { NativeGitHubConnection } from './github-connection.ts';
import { DeliveryService } from './delivery.ts';
const text = (value: unknown, name: string, max = 10000) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    value.includes('\0')
  )
    throw Error('invalid GitHub ' + name);
  return value;
};
const safePR = (value: unknown): GitHubPR => {
  const p = value as GitHubPR;
  if (
    !Number.isSafeInteger(p?.number) ||
    !/^https:\/\/github\.com\//.test(p?.url ?? '')
  )
    throw Error('invalid GitHub pull request');
  return {
    number: p.number,
    url: p.url,
    isDraft: p.isDraft === true,
    headRefOid: text(p.headRefOid, 'head', 64),
    headRefName: text(p.headRefName, 'branch', 300),
    state: text(p.state, 'state', 30),
  };
};
export function githubWorkspaceBackend(options: {
  connection: NativeGitHubConnection;
  delivery: () => Promise<DeliveryService>;
  acquireLease?: () => () => void;
  assertEnabled?: () => void;
  providerSignal?: () => AbortSignal;
  runWrite?: (
    method: string,
    params: unknown,
    callId: string,
    action: () => Promise<unknown>,
  ) => Promise<unknown>;
}): GitHubConnectionBackend {
  const { connection } = options;
  let leases = 0;
  const enabled = () => {
    if (!leases) throw Error('GitHub extension is disabled');
    options.assertEnabled?.();
  };
  const backend: GitHubConnectionBackend = {
    subscribe: (listener) => {
      leases++;
      const releaseOwner = options.acquireLease?.();
      const unsubscribe = connection.subscribe(listener);
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        leases--;
        unsubscribe();
        releaseOwner?.();
      };
    },
    async call(method, params, context) {
      context?.signal.throwIfAborted();
      enabled();
      const p = params as Record<string, unknown>;
      let result: unknown;
      if (method === 'status') result = await connection.status();
      else if (method === 'connect')
        result = await connection.connect({
          storage: p.storage as 'encrypted' | 'session',
          repositories: p.repositories as string[],
        });
      else if (method === 'cancel' || method === 'disconnect') {
        if (!Number.isSafeInteger(p.epoch))
          throw Error('invalid GitHub connection epoch');
        result =
          method === 'cancel'
            ? await connection.cancel(p.epoch as number)
            : await connection.disconnect(p.epoch as number);
      } else if (['publish', 'checks', 'logs', 'retry'].includes(method)) {
        const epoch = p.epoch,
          repository = text(p.repository, 'repository', 220),
          head = text(p.head, 'head', 64);
        if (
          !Number.isSafeInteger(epoch) ||
          !/^[-\w.]+\/[-\w.]+$/.test(repository) ||
          !/^[a-f\d]{40,64}$/i.test(head)
        )
          throw Error('invalid GitHub task scope');
        connection.assertGrant(epoch as number, repository);
        const source = await options.delivery();
        const guard = () => {
          context?.signal.throwIfAborted();
          enabled();
          connection.assertGrant(epoch as number, repository);
        };
        guard();
        const delivery = new DeliveryService(source.root, source.ghPath, {
          connection,
          epoch: epoch as number,
          signal: context?.signal,
          assertActive: guard,
          spawn: () => {
            throw Error('login belongs in settings');
          },
        });
        const remote = (
          await delivery.git.git(['remote', 'get-url', 'origin'])
        ).trim();
        const normalized = remote
          .replace(/^git@github\.com:/, 'https://github.com/')
          .replace(/\.git$/, '');
        if (normalized !== 'https://github.com/' + repository)
          throw Error(
            'GitHub repository differs from the trusted workspace remote',
          );
        const state = await delivery.git.snapshot();
        if (state.head !== head) throw Error('GitHub candidate head changed');
        if (method === 'publish') {
          if (
            text(p.branch, 'branch', 300) !== state.branch ||
            ['main', 'master', 'detached'].includes(state.branch)
          )
            throw Error(
              'GitHub publication requires the reviewed feature branch',
            );
          if (text(p.revision, 'revision', 128) !== state.revision)
            throw Error('GitHub candidate revision changed');
          if (
            !Array.isArray(p.paths) ||
            p.paths.some((item) => typeof item !== 'string')
          )
            throw Error('explicit reviewed GitHub paths are required');
          const paths = (
            await delivery.git.git([
              'diff',
              '--name-only',
              '-z',
              'origin/main...HEAD',
            ])
          )
            .split('\0')
            .filter(Boolean)
            .sort();
          if (
            !paths.length ||
            JSON.stringify(paths) !==
              JSON.stringify([...new Set(p.paths as string[])].sort())
          )
            throw Error(
              'GitHub publication paths differ from the reviewed branch',
            );
          connection.assertGrant(epoch as number, repository);
          result = safePR(
            await delivery.call('publish', {
              revision: state.revision,
              title: text(p.title, 'title', 1000),
              body: typeof p.body === 'string' ? p.body : '',
            }),
          );
        } else {
          const pr = JSON.parse(
            await delivery.gh([
              'pr',
              'view',
              '--json',
              'number,url,isDraft,headRefOid,headRefName,state',
            ]),
          );
          if (
            pr.headRefOid !== head ||
            pr.headRefName !== state.branch ||
            pr.state !== 'OPEN'
          )
            throw Error('GitHub pull request candidate changed');
          if (method === 'checks') {
            const checks = (await delivery.call('checks')) as GitHubCheck[];
            result = {
              head,
              checks: checks.map((c) => ({
                name: text(c.name, 'check name'),
                state: text(c.state, 'check state'),
                bucket: text(c.bucket, 'check bucket'),
                ...(c.link ? { link: text(c.link, 'check link') } : {}),
                ...(c.workflow
                  ? { workflow: text(c.workflow, 'workflow') }
                  : {}),
              })),
            };
          } else {
            if (!Number.isSafeInteger(p.runId) || Number(p.runId) <= 0)
              throw Error('valid CI run id is required');
            const run = JSON.parse(
              await delivery.gh([
                'run',
                'view',
                String(p.runId),
                '--json',
                'headSha',
              ]),
            );
            if (run.headSha !== head)
              throw Error('CI run belongs to another commit');
            connection.assertGrant(epoch as number, repository);
            const response = await delivery.call(method, { runId: p.runId });
            result =
              method === 'logs'
                ? {
                    text: String((response as { text: string }).text),
                    head,
                    runId: p.runId,
                  }
                : { retried: p.runId, head };
          }
          const after = JSON.parse(
            await delivery.gh([
              'pr',
              'view',
              '--json',
              'headRefOid,headRefName',
            ]),
          );
          if (after.headRefOid !== head || after.headRefName !== state.branch)
            throw Error('GitHub candidate changed while reading results');
        }
        connection.assertGrant(epoch as number, repository);
      } else throw Error('unsupported GitHub connection method');
      return result as GitHubConnectionMethods[typeof method]['result'];
    },
  };
  const execute = backend.call.bind(backend);
  backend.call = async (method, params, context) => {
    const providerSignal = options.providerSignal?.();
    if (providerSignal)
      context = {
        ...context,
        signal: context
          ? AbortSignal.any([context.signal, providerSignal])
          : providerSignal,
      };
    enabled();
    context?.signal.throwIfAborted();
    if (method !== 'publish' && method !== 'retry')
      return execute(method, params, context);
    connection.assertGrant(
      (params as { epoch: number }).epoch,
      (params as { repository: string }).repository,
    );
    if (!context?.callId || !options.runWrite)
      throw Error('GitHub writes require a trusted operation identity');
    return (await options.runWrite(method, params, context.callId, () =>
      execute(method, params, context),
    )) as never;
  };
  return backend;
}
