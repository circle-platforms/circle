/** Sanitized native capability injected only into Circle's bundled GitHub extension. */
export interface GitHubConnectionState {
  provider: 'github';
  client: 'GitHub CLI';
  epoch: number;
  state: 'disconnected' | 'authorizing' | 'connected' | 'error';
  account?: { login: string; id: number };
  repositories: string[];
  storage?: 'encrypted' | 'session';
  authorization?: { id: string; url?: string; code?: string; status: string };
  error?: string;
  remoteRevocation: 'not-requested' | 'unconfirmed';
}
export interface GitHubPR {
  number: number;
  url: string;
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  state: string;
}
export interface GitHubCheck {
  name: string;
  state: string;
  bucket: string;
  link?: string;
  workflow?: string;
}
export interface GitHubPublishInput {
  epoch: number;
  repository: string;
  branch: string;
  head: string;
  revision: string;
  paths: string[];
  title: string;
  body: string;
}
export interface GitHubConnectionMethods {
  status: { params: Record<string, never>; result: GitHubConnectionState };
  connect: {
    params: { storage: 'encrypted' | 'session'; repositories: string[] };
    result: GitHubConnectionState;
  };
  cancel: { params: { epoch: number }; result: GitHubConnectionState };
  disconnect: { params: { epoch: number }; result: GitHubConnectionState };
  publish: { params: GitHubPublishInput; result: GitHubPR };
  checks: {
    params: { epoch: number; repository: string; head: string };
    result: { head: string; checks: GitHubCheck[] };
  };
  logs: {
    params: { epoch: number; repository: string; head: string; runId: number };
    result: { text: string; head: string; runId: number };
  };
  retry: {
    params: { epoch: number; repository: string; head: string; runId: number };
    result: { retried: number; head: string };
  };
}
export interface GitHubConnectionBackend {
  call<M extends keyof GitHubConnectionMethods>(
    method: M,
    params: GitHubConnectionMethods[M]['params'],
    context?: { signal: AbortSignal; callId?: string },
  ): Promise<GitHubConnectionMethods[M]['result']>;
  subscribe(listener: (state: GitHubConnectionState) => void): () => void;
}
