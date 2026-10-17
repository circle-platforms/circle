import { DeliveryPreflightError } from './delivery-preflight.ts';
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
/** Resolve only locally known remote refs; never fetch or guess an arbitrary branch. */
export async function githubPublicationBase(git: DeliveryService['git']) {
  const refs = (
    await git.git([
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(symref)',
      'refs/remotes/origin/',
    ])
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  const target = refs.find(
    ([name]) => name === 'refs/remotes/origin/HEAD',
  )?.[2];
  const selected = target
    ? refs.find(([name]) => name === target)
    : ['refs/remotes/origin/main', 'refs/remotes/origin/master']
        .map((name) => refs.find(([ref]) => ref === name))
        .find(Boolean);
  if (!selected || !/^[a-f\d]{40,64}$/i.test(selected[1]))
    throw Error(
      'remote default branch is unavailable; refresh the origin default ref',
    );
  return {
    base: selected[0].replace(/^refs\/remotes\//, ''),
    baseHead: selected[1],
  };
}
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
      else if (method === 'configure')
        result = await connection.configure(
          p.epoch as number,
          p.repositories as string[],
        );
      else if (method === 'cancel' || method === 'disconnect') {
        if (!Number.isSafeInteger(p.epoch))
          throw Error('invalid GitHub connection epoch');
        result =
          method === 'cancel'
            ? await connection.cancel(p.epoch as number)
            : await connection.disconnect(p.epoch as number);
      } else if (
        ['candidate', 'publish', 'checks', 'logs', 'retry'].includes(method)
      ) {
        const epoch = p.epoch,
          repository = text(p.repository, 'repository', 220),
          head =
            method === 'candidate'
              ? undefined
              : method === 'publish'
                ? typeof p.head === 'string'
                  ? p.head
                  : ''
                : text(p.head, 'head', 64);
        if (method === 'publish' && !/^[a-f\d]{40,64}$/i.test(head ?? ''))
          throw new DeliveryPreflightError('GITHUB_CANDIDATE_REFRESH_REQUIRED');
        if (
          !Number.isSafeInteger(epoch) ||
          !/^[-\w.]+\/[-\w.]+$/.test(repository) ||
          (head !== undefined && !/^[a-f\d]{40,64}$/i.test(head))
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
            throw Error('open the GitHub plugin details to connect');
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
        if (method === 'candidate') {
          const { base, baseHead } = await githubPublicationBase(delivery.git);
          const paths = (
            await delivery.git.git([
              'diff',
              '--name-only',
              '-z',
              `${baseHead}...${state.head}`,
            ])
          )
            .split('\0')
            .filter(Boolean)
            .sort();
          const after = await delivery.git.snapshot();
          if (
            after.revision !== state.revision ||
            JSON.stringify(await githubPublicationBase(delivery.git)) !==
              JSON.stringify({ base, baseHead })
          )
            throw Error(
              'GitHub candidate changed; read github_candidate again',
            );
          guard();
          return {
            head: state.head,
            branch: state.branch,
            revision: state.revision,
            base,
            baseHead,
            paths,
            dirty: state.entries.length > 0,
            publishable:
              state.entries.length === 0 &&
              !['main', 'master', 'detached'].includes(state.branch) &&
              state.branch !== base.slice('origin/'.length) &&
              paths.length > 0,
          } as never;
        }
        if (state.head !== head) {
          if (method === 'publish')
            throw new DeliveryPreflightError(
              'GITHUB_CANDIDATE_REFRESH_REQUIRED',
            );
          throw Error('GitHub candidate head changed');
        }
        if (method === 'publish') {
          const { base, baseHead } = await githubPublicationBase(delivery.git);
          if (
            state.branch === base.slice('origin/'.length) ||
            text(p.branch, 'branch', 300) !== state.branch ||
            ['main', 'master', 'detached'].includes(state.branch)
          )
            throw Error(
              'GitHub publication requires the reviewed feature branch',
            );
          if (typeof p.revision !== 'string' || p.revision !== state.revision)
            throw new DeliveryPreflightError(
              'GITHUB_CANDIDATE_REFRESH_REQUIRED',
            );
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
              `${baseHead}...${state.head}`,
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
          if (
            JSON.stringify(await githubPublicationBase(delivery.git)) !==
            JSON.stringify({ base, baseHead })
          )
            throw new DeliveryPreflightError(
              'GITHUB_CANDIDATE_REFRESH_REQUIRED',
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
    const checked = async () => {
      const result = await execute(method, params, context);
      context?.signal.throwIfAborted();
      enabled();
      return result;
    };
    if (method !== 'publish' && method !== 'retry') return checked();
    connection.assertGrant(
      (params as { epoch: number }).epoch,
      (params as { repository: string }).repository,
    );
    if (!context?.callId || !options.runWrite)
      throw Error('GitHub writes require a trusted operation identity');
    return (await options.runWrite(method, params, context.callId, () =>
      checked(),
    )) as never;
  };
  return backend;
}
