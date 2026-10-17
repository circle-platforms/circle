import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime } from '../src/model/state';
import { GitHubConnectionCard } from '../src/components/GitHubConnectionCard';
import { DeliveryPanel } from '../src/components/DeliveryPanel';
import type { GitHubConnectionState } from '../../../src/github_connection';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
import '../src/styles/app.css';
// This stateful component contract never accesses OAuth, a real account or storage.
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
applyTheme(query.get('theme') === 'dark' ? 'dark' : 'light');
const runtime = new PreviewRuntime();
Object.defineProperty(runtime, 'mode', { value: 'live' });
const calls: Array<{ name: string; args?: string }> = [],
  copies: string[] = [],
  opened: string[] = [];
let holdConnect = false;
let heldConnectReject: ((reason: Error) => void) | undefined;
let failEncrypted = true,
  failConfigure = false;
let state: GitHubConnectionState = {
  provider: 'github',
  client: 'GitHub CLI',
  epoch: 7,
  state: 'disconnected',
  repositories: [],
  remoteRevocation: 'not-requested',
};
function publish() {
  runtime.change((snapshot) => {
    snapshot.extensions = [
      {
        id: 'github',
        name: 'github',
        scope: 'bundled',
        version: '0.1.0',
        enabled: true,
        tools: [],
        commands: ['github'],
        events: [],
        view: structuredClone(state),
      },
    ];
  });
}
window.circleDesktop = {
  copyText: async (text: string) => {
    copies.push(text);
  },
  openExternal: async (url: string) => {
    opened.push(url);
  },
  runtimeCommand: async () => ({
    ok: true,
    data: { authenticated: false, pullRequest: null },
  }),
} as unknown as NonNullable<Window['circleDesktop']>;
runtime.command = (name, args = '') => {
  calls.push({ name, args });
  const match = /^(\w+)(?:\s+([\s\S]+))?$/.exec(args)!;
  const verb = match[1],
    params = match[2] ? JSON.parse(match[2]) : {};
  if (verb === 'connect') {
    if (params.storage === 'encrypted' && failEncrypted) {
      failEncrypted = false;
      throw Error(
        'secure credential storage is unavailable\noriginal detail retained',
      );
    }
    state = {
      ...state,
      epoch: state.epoch + 1,
      state: 'authorizing',
      authorizationPhase: 'waiting-for-user',
      lastAuthorizationOutcome: undefined,
      storage: params.storage,
      repositories: params.repositories,
      authorization: {
        id: 'fixture-authorization',
        code: 'CODE-TEST',
        url: 'https://github.com/login/device',
        status: 'waiting',
      },
    };
    if (holdConnect) {
      holdConnect = false;
      delete state.authorization;
      state.authorizationPhase = 'preparing-code';
      publish();
      return new Promise<Record<string, never>>((_resolve, reject) => {
        heldConnectReject = reject;
      });
    }
  } else if (verb === 'configure') {
    if (params.epoch !== state.epoch) throw Error('GitHub connection changed');
    if (failConfigure) {
      failConfigure = false;
      throw Error('configuration write failed\noriginal failure detail');
    }
    state = {
      ...state,
      epoch: state.epoch + 1,
      repositories: params.repositories,
    };
  } else if (verb === 'cancel' || verb === 'disconnect') {
    const outcome =
      verb === 'disconnect'
        ? 'disconnected'
        : state.authorization?.code && state.authorization.url
          ? 'cancelled'
          : 'cancelled-before-code';
    if (params.epoch !== state.epoch) throw Error('GitHub connection changed');
    state = {
      provider: 'github',
      client: 'GitHub CLI',
      epoch: state.epoch + 1,
      state: 'disconnected',
      repositories: [],
      remoteRevocation: verb === 'cancel' ? 'not-requested' : 'unconfirmed',
      lastAuthorizationOutcome: outcome,
    };
  }
  publish();
  return {};
};
Object.assign(window, {
  githubFixture: {
    calls,
    priorDisconnectedGrant: (
      current: 'disconnected' | 'authorizing' | 'connected',
    ) => {
      state = {
        ...state,
        state: current,
        remoteRevocation: 'unconfirmed',
        account:
          current === 'connected'
            ? { login: 'fixture-account', id: 123 }
            : undefined,
      };
      publish();
    },
    holdNextConnect: () => {
      holdConnect = true;
      failEncrypted = false;
    },
    rejectHeldConnect: () => {
      heldConnectReject?.(Error('stale connect cancelled'));
      heldConnectReject = undefined;
    },
    copies,
    opened,
    completeAuthorization: () => {
      if (state.state !== 'authorizing')
        throw Error('fixture requires pending authorization');
      state = {
        ...state,
        state: 'connected',
        account: { login: 'fixture-account', id: 123 },
        authorizationPhase: undefined,
        lastAuthorizationOutcome: 'connected',
      };
      delete state.authorization;
      publish();
    },
    preparingAuthorization: (
      authorization?: GitHubConnectionState['authorization'],
    ) => {
      state = {
        ...state,
        epoch: state.epoch + 1,
        state: 'authorizing',
        remoteRevocation: 'not-requested',
        authorization,
        authorizationPhase: 'preparing-code',
        lastAuthorizationOutcome: undefined,
      };
      publish();
    },
    authorizationCode: () => {
      if (state.state !== 'authorizing')
        throw Error('fixture requires preparing authorization');
      state = {
        ...state,
        authorizationPhase: 'waiting-for-user',
        authorization: {
          id: 'fixture-preparing',
          code: 'CODE-TEST',
          url: 'https://github.com/login/device',
          status: 'waiting',
        },
      };
      publish();
    },
    verifyingAuthorization: () => {
      state = { ...state, authorizationPhase: 'verifying-account' };
      publish();
    },
    failNextConfigure: () => {
      failConfigure = true;
    },
    advanceEpoch: () => {
      state = { ...state, epoch: state.epoch + 1 };
      publish();
    },
    integrationLoading: () =>
      runtime.change((snapshot) => {
        const extension = snapshot.extensions[0];
        extension.enabled = true;
        delete extension.view;
        delete extension.error;
      }),
    integrationFailure: () =>
      runtime.change((snapshot) => {
        const extension = snapshot.extensions[0];
        extension.enabled = true;
        delete extension.view;
        extension.error = 'synthetic GitHub module initialization failure';
      }),
    integrationReady: publish,
    viewError: (error?: string) => {
      state = { ...state, error };
      publish();
    },
    scopeMetadata: (metadata: Partial<GitHubConnectionState>) => {
      delete state.requestedAdditionalScopes;
      delete state.grantedScopes;
      delete state.scopeVerification;
      state = { ...state, ...metadata };
      publish();
    },
    disableWithStaleView: () =>
      runtime.change((snapshot) => {
        snapshot.extensions[0].enabled = false;
      }),
    unavailable: () =>
      runtime.change((s) => {
        s.extensions = [];
      }),
    state: () => structuredClone(state),
  },
});
publish();
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <RuntimeProvider runtime={runtime}>
      <main className="page">
        <GitHubConnectionCard />
        <DeliveryPanel sessionId="test" />
      </main>
    </RuntimeProvider>
  </MemoryRouter>,
);
