import type { ChatFile } from '../../../../src/remote_bot_protocol.ts';
import { t } from '../i18n/index.ts';
import type { McpServer, Message, WorkbenchSnapshot } from './types.ts';

export const HUB_SERVER = 'Hub';
export const BOT_RETRY_BASE_MS = 1000;
export const BOT_RETRY_MAX_MS = 30_000;

export type RemoteBotFailureKind =
  | 'version-mismatch'
  | 'version-invalid'
  | 'disabled'
  | 'auth'
  | 'oauth-forbidden'
  | 'transient'
  | 'other';

export interface RemoteBotFailure {
  kind: RemoteBotFailureKind;
  retryable: boolean;
  title: string;
  cause: string;
  action: string;
  detail?: string;
}

export type RemoteEvent = Pick<Message, 'id' | 'at' | 'role' | 'text'> & {
  files?: ChatFile[];
  cursor: number;
  delivery?: string | null;
};

export interface BotDiscovery {
  id: string;
  current: string;
  binding: string;
  name?: string;
}

export interface BotHistory {
  queued?: { request: string; at: string; text: string }[];
  fileDeliveries?: { id: string; slot: number; state: string }[];
  question?: string | null;
  events: RemoteEvent[];
  deliveries?: { id: string; state: string }[];
  active: { request: string; draft: string } | null;
}

export function findHubConnection(
  snapshot: Pick<WorkbenchSnapshot, 'mcp'>,
): McpServer | undefined {
  return snapshot.mcp.find((row) => row.name === HUB_SERVER);
}

export function isHubConnected(
  snapshot: Pick<WorkbenchSnapshot, 'mcp'>,
): boolean {
  return findHubConnection(snapshot)?.status === 'connected';
}

export function shouldOpenInitialConnectionModal(params: {
  mode: string;
  configured: boolean | undefined;
  snapshot: Pick<WorkbenchSnapshot, 'mcp'>;
  pathname: string;
}): boolean {
  return (
    params.mode === 'live' &&
    params.configured === false &&
    !isHubConnected(params.snapshot) &&
    params.pathname !== '/page/remote-bot'
  );
}

export function nextBotRetryDelay(currentMs: number): number {
  return currentMs > 0
    ? Math.min(BOT_RETRY_MAX_MS, currentMs * 2)
    : BOT_RETRY_BASE_MS;
}

export function stripInvokeErrorPrefix(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/s, '')
    .trim();
}

function readFailureMeta(reason: unknown): {
  status?: number;
  code?: string;
  message?: string;
} {
  if (!reason || typeof reason !== 'object') {
    return typeof reason === 'string'
      ? { message: stripInvokeErrorPrefix(reason) }
      : {};
  }
  const err = reason as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const nested =
    err.cause && typeof err.cause === 'object'
      ? (err.cause as { status?: unknown; code?: unknown; message?: unknown })
      : undefined;
  const status =
    typeof err.status === 'number'
      ? err.status
      : typeof nested?.status === 'number'
        ? nested.status
        : undefined;
  const code =
    typeof err.code === 'string'
      ? err.code
      : typeof nested?.code === 'string'
        ? nested.code
        : undefined;
  const rawMessage =
    typeof err.message === 'string'
      ? err.message
      : typeof nested?.message === 'string'
        ? nested.message
        : undefined;
  return {
    status,
    code,
    ...(rawMessage ? { message: stripInvokeErrorPrefix(rawMessage) } : {}),
  };
}

export function classifyRemoteBotFailure(reason: unknown): RemoteBotFailure {
  const { status, code, message } = readFailureMeta(reason);
  if (code === 'BOT_VERSION_MISMATCH' || status === 426) {
    return {
      kind: 'version-mismatch',
      retryable: false,
      title: t('Circle update required'),
      cause: t('Hub rejected this Circle version for my bot.'),
      action: t('Update Circle desktop, then reconnect.'),
    };
  }
  if (code === 'BOT_VERSION_INVALID') {
    return {
      kind: 'version-invalid',
      retryable: false,
      title: t('invalid client version'),
      cause: t('Hub could not recognize the Circle client version header.'),
      action: t('Reinstall or update Circle desktop, then try again.'),
    };
  }
  if (code === 'BOT_DISABLED') {
    return {
      kind: 'disabled',
      retryable: false,
      title: t('my bot is disabled'),
      cause: t('Your Hub administrator has disabled my bot access.'),
      action: t('Ask your Hub administrator to enable it, then retry.'),
    };
  }
  if (code === 'BOT_CLIENT_FORBIDDEN') {
    return {
      kind: 'oauth-forbidden',
      retryable: false,
      title: t('direct member token required'),
      cause: t('Hub refused the OAuth sign-in token for my bot API.'),
      action: t(
        'Configure a direct member Bearer token in the Hub MCP settings, then retry.',
      ),
    };
  }
  if (status === 401) {
    return {
      kind: 'auth',
      retryable: false,
      title: t('bot sign-in expired'),
      cause: t(
        'Hub rejected the credential because it expired or was revoked.',
      ),
      action: t('Sign in to Hub again in Settings -> Extensions, then retry.'),
    };
  }
  const unsafeTransport =
    message !== undefined &&
    /requires https or loopback http|invalid remote bot server/i.test(message);
  if (
    !unsafeTransport &&
    (status === undefined ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      status === 429)
  ) {
    return {
      kind: 'transient',
      retryable: true,
      title: t('remote bot disconnected'),
      cause: t('Cannot reach the Hub bot endpoint right now.'),
      action: t('Circle will retry automatically with backoff, or retry now.'),
    };
  }
  return {
    kind: 'other',
    retryable: false,
    title: t('remote bot request failed'),
    cause: t('Hub returned an unexpected error for my bot.'),
    action: t('Check the Hub connection and retry.'),
    ...(message ? { detail: message } : {}),
  };
}

export function translateBotTransferError(
  reason: unknown,
  fallback: string,
): string {
  const raw =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : '';
  const cleaned = stripInvokeErrorPrefix(raw);
  switch (cleaned) {
    case 'select up to eight files':
      return t('select up to eight files');
    case 'symbolic links cannot be attached':
      return t('symbolic links cannot be attached');
    case 'only a regular file can be attached':
      return t('only a regular file can be attached');
    case 'file exceeds the 100 MiB limit':
      return t('file exceeds the 100 MiB limit');
    case 'remote bot requires https or loopback http':
      return t('remote bot requires https or loopback http');
    case 'file upload was not verified':
      return t('file upload was not verified');
    case 'file unavailable':
      return t('file unavailable');
    case 'file digest mismatch':
      return t('file digest mismatch');
    default:
      return cleaned || fallback;
  }
}

export function botIdentityKey(discovery: BotDiscovery): string {
  return JSON.stringify([discovery.binding, discovery.id, discovery.current]);
}

export function mergeDeliveryStates(
  history: Pick<BotHistory, 'deliveries' | 'fileDeliveries'>,
): Record<string, string> {
  return Object.fromEntries([
    ...(history.deliveries ?? []).map((row) => [row.id, row.state]),
    ...(history.fileDeliveries ?? []).map((row) => [
      `${row.id}:${row.slot}`,
      row.state,
    ]),
  ]);
}

export function deliveryText(state?: string | null): string | null {
  switch (state) {
    case 'sent':
      return t('private chat acknowledged');
    case 'unknown':
      return t('private chat delivery unknown');
    case 'refused':
      return t('private chat delivery refused');
    case 'unbound':
      return t('private chat not bound');
    case 'queued':
      return t('waiting for private chat delivery');
    default:
      return null;
  }
}
