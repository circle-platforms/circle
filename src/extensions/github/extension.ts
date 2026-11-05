import type { ExtensionAPI } from '../../extensions.js';
import type { GitHubConnectionState } from '../../github_connection.js';
const GITHUB_SETUP_HINT =
  'GitHub is not connected. Ask the user to open Settings → Capabilities → Extensions → GitHub (设置 → 能力 → 扩展 → GitHub) and connect an account.';
export async function register(api: ExtensionAPI) {
  const backend = api.githubConnection;
  if (!backend) {
    api.registerCommand(
      'github',
      'GitHub requires the native desktop backend',
      async (_args, context) => {
        context.append('GitHub connection is unavailable in this runtime');
      },
    );
    return;
  }
  const registered = new Set<string>();
  const clear = () => {
    for (const name of registered) api.unregisterTool(name);
    registered.clear();
  };
  const base = {
    epoch: { type: 'integer' },
    repository: { type: 'string' },
    head: { type: 'string' },
  };
  const update = (state: GitHubConnectionState) => {
    if (api.signal.aborted) return;
    // No status line: the connection is set up in the GitHub settings, and the model
    // points the user there when a task needs it.
    api.setView(state);
    clear();
    api.registerTool(
      'github_connection',
      'Read the current GitHub account, access policy and epoch. Repository access follows the connected GitHub credentials. Only the user can connect, in Settings → Capabilities → Extensions → GitHub; when the result has setup, tell them that.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        const current = await backend.call(
          'status',
          {},
          { signal: api.signal },
        );
        return {
          provider: current.provider,
          client: current.client,
          requestedAdditionalScopes: current.requestedAdditionalScopes,
          grantedScopes: current.grantedScopes,
          scopeVerification: current.scopeVerification,
          epoch: current.epoch,
          state: current.state,
          account: current.account,
          accessPolicy: current.accessPolicy,
          storage: current.storage,
          ...(current.state === 'connected' && current.account
            ? {}
            : { setup: GITHUB_SETUP_HINT }),
        };
      },
      { readOnly: true },
    );
    registered.add('github_connection');
    if (state.state !== 'connected' || !state.account) return;
    for (const [method, description, properties, required, readOnly] of [
      [
        'candidate',
        'Inspect the current owner workspace publication candidate: exact commit head, feature branch, opaque revision (not a commit SHA), resolved origin default base and complete reviewed paths. Read this before github_publish; never guess revision. Dirty candidates cannot publish.',
        { epoch: base.epoch, repository: base.repository },
        ['epoch', 'repository'],
        true,
      ],
      [
        'checks',
        'Read the connected GitHub repository pull request checks for this task.',
        base,
        ['epoch', 'repository', 'head'],
        true,
      ],
      [
        'logs',
        'Read failed CI logs from the connected GitHub repository for this task.',
        { ...base, runId: { type: 'integer' } },
        ['epoch', 'repository', 'head', 'runId'],
        true,
      ],
      [
        'retry',
        'Retry failed CI jobs using the connected GitHub repository. Requires approval.',
        { ...base, runId: { type: 'integer' } },
        ['epoch', 'repository', 'head', 'runId'],
        false,
      ],
      [
        'publish',
        'Publish or maintain a draft PR for explicitly reviewed files and exact commit on a feature branch. Never merges.',
        {
          ...base,
          branch: { type: 'string' },
          head: { type: 'string' },
          revision: {
            type: 'string',
            description:
              'Exact opaque revision returned by github_candidate; this is not a commit SHA.',
          },
          paths: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        [
          'epoch',
          'repository',
          'branch',
          'head',
          'revision',
          'paths',
          'title',
          'body',
        ],
        false,
      ],
    ] as const) {
      const name = 'github_' + method;
      api.registerTool(
        name,
        description,
        {
          type: 'object',
          properties,
          required: [...required],
          additionalProperties: false,
        },
        async (args, context) => {
          // Backend independently validates the method's typed payload, epoch and repository grant.
          const result = await backend.call(method, args as never, {
            signal: AbortSignal.any([context.signal, api.signal]),
            callId: context.callId,
          });
          return result;
        },
        { readOnly, approval: !readOnly },
      );
      registered.add(name);
    }
  };
  const unsubscribe = backend.subscribe(update);
  api.signal.addEventListener(
    'abort',
    () => {
      unsubscribe();
      clear();
    },
    { once: true },
  );
  api.registerCommand(
    'github',
    'GitHub connection: status, connect, cancel or disconnect',
    async (args, context) => {
      const match =
        /^(status|connect|cancel|disconnect)(?:\s+([\s\S]+))?$/.exec(
          args.trim() || 'status',
        );
      if (!match)
        throw new api.ToolError(
          'use github status, connect, cancel or disconnect',
        );
      let params = {};
      try {
        if (match[2]) params = JSON.parse(match[2]);
      } catch {
        throw new api.ToolError('invalid GitHub connection parameters');
      }
      const state = await backend.call(match[1] as 'status', params as never, {
        signal: api.signal,
      });
      update(state);
      context.append('GitHub: ' + state.state);
    },
  );
  try {
    update(await backend.call('status', {}, { signal: api.signal }));
  } catch (error) {
    unsubscribe();
    clear();
    throw error;
  }
}
