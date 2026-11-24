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
  | 'local-credential'
  | 'local-https'
  | 'transient'
  | 'other';

export interface RemoteBotFailureContext {
  hasAuthorizationHeader?: boolean;
  settingsPath?: string;
}

export interface RemoteBotFailure {
  kind: RemoteBotFailureKind;
  retryable: boolean;
  canReauthorize?: boolean;
  reauthorizeScope?: string;
  title: string;
  cause: string;
  action: string;
  detail?: string;
}

export type RemoteEvent = Pick<Message, 'id' | 'at' | 'role' | 'text'> & {
  code?: string;
  files?: ChatFile[];
  cursor: number;
  delivery?: string | null;
};

const REMOTE_BOT_NOTICE_LABELS: Readonly<Record<string, () => string>> = {
  help: () =>
    t(
      'send text or files to chat with your personal bot. send /new for a new conversation, or /stop to cancel the active reply.',
    ),
  conversation_started: () => t('started a new conversation'),
  stop_requested: () => t('requested stop for active reply'),
  stop_idle: () => t('no active reply to stop'),
  disabled_queued: () =>
    t('bot model is disabled; queued message was not executed'),
  bot_disabled_aborted: () => t('bot model was disabled; active reply stopped'),
  credential_blocked: () => t('message cannot contain bot credentials'),
  reply_stopped: () => t('reply stopped'),
  host_restarted_queued: () =>
    t('host restarted while queued; message not executed'),
  host_restarted_interrupted: () =>
    t('host restarted; previous request outcome unknown'),
  bot_not_enabled: () => t('bot model is not enabled'),
  model_invalid_question: () => t('model did not provide a valid question'),
  model_credentials_blocked: () => t('model reply contained credentials'),
  model_empty_reply: () => t('model returned an empty reply'),
  model_auth_failed: () => t('model endpoint rejected credentials'),
  model_id_unavailable: () => t('model id is unavailable'),
  model_not_found: () => t('endpoint or model not found'),
  model_unreachable: () => t('model endpoint unreachable or timed out'),
  model_invalid_reply: () => t('model did not return a valid reply'),
  attachment_integrity_failed: () => t('attachment integrity check failed'),
  invalid_attachment_digest: () => t('invalid attachment digest'),
  attachment_unavailable: () => t('attachment could not be read'),
  message_not_processed: () =>
    t('message was not processed; you can resend it'),
  reply_interrupted: () => t('model reply interrupted; outcome unknown'),
};

const REMOTE_BOT_NOTICE_FALLBACKS: Readonly<Record<string, string>> = {
  'send text or files to chat with your personal bot. send /new for a new conversation, or /stop to cancel the active reply.':
    'help',
  'started a new conversation': 'conversation_started',
  'requested stop for active reply': 'stop_requested',
  'no active reply to stop': 'stop_idle',
  'bot model is disabled; queued message was not executed': 'disabled_queued',
  'bot model was disabled; active reply stopped': 'bot_disabled_aborted',
  'message cannot contain bot credentials': 'credential_blocked',
  'reply stopped': 'reply_stopped',
  'host restarted while queued; message not executed': 'host_restarted_queued',
  'host restarted; previous request outcome unknown':
    'host_restarted_interrupted',
  'bot model is not enabled': 'bot_not_enabled',
  'model did not provide a valid question': 'model_invalid_question',
  'model reply contained credentials': 'model_credentials_blocked',
  'model returned an empty reply': 'model_empty_reply',
  'model endpoint rejected credentials': 'model_auth_failed',
  'model id is unavailable': 'model_id_unavailable',
  'endpoint or model not found': 'model_not_found',
  'model endpoint unreachable or timed out': 'model_unreachable',
  'model did not return a valid reply': 'model_invalid_reply',
  'attachment integrity check failed': 'attachment_integrity_failed',
  'invalid attachment digest': 'invalid_attachment_digest',
  'attachment could not be read': 'attachment_unavailable',
  'message was not processed; you can resend it': 'message_not_processed',
  'model reply interrupted; outcome unknown': 'reply_interrupted',
};

export function formatRemoteBotNotice(
  code: string | undefined,
  fallbackText: string,
): string {
  if (code && Object.hasOwn(REMOTE_BOT_NOTICE_LABELS, code)) {
    return REMOTE_BOT_NOTICE_LABELS[code]!();
  }
  const normalized = fallbackText.trim();
  const mappedCode = Object.hasOwn(REMOTE_BOT_NOTICE_FALLBACKS, normalized)
    ? REMOTE_BOT_NOTICE_FALLBACKS[normalized]
    : undefined;
  if (mappedCode && Object.hasOwn(REMOTE_BOT_NOTICE_LABELS, mappedCode)) {
    return REMOTE_BOT_NOTICE_LABELS[mappedCode]!();
  }
  return fallbackText;
}

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
  detail?: string;
  scope?: string;
  isTimeout?: boolean;
  errorUploaded?: number;
  errorTotal?: number;
  errorFileName?: string;
  errorReason?: string;
} {
  if (!reason || typeof reason !== 'object') {
    return typeof reason === 'string'
      ? { message: stripInvokeErrorPrefix(reason) }
      : {};
  }
  const err = reason as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
    detail?: unknown;
    remoteMessage?: unknown;
    scope?: unknown;
    errorScope?: unknown;
    errorUploaded?: unknown;
    uploaded?: unknown;
    errorTotal?: unknown;
    total?: unknown;
    errorFileName?: unknown;
    fileName?: unknown;
    errorReason?: unknown;
    reason?: unknown;
    cause?: unknown;
  };
  const nested =
    err.cause && typeof err.cause === 'object'
      ? (err.cause as {
          name?: unknown;
          status?: unknown;
          code?: unknown;
          message?: unknown;
          detail?: unknown;
          remoteMessage?: unknown;
          scope?: unknown;
          errorScope?: unknown;
          errorUploaded?: unknown;
          uploaded?: unknown;
          errorTotal?: unknown;
          total?: unknown;
          errorFileName?: unknown;
          fileName?: unknown;
          errorReason?: unknown;
          reason?: unknown;
        })
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
  const detail =
    typeof err.detail === 'string'
      ? err.detail
      : typeof err.remoteMessage === 'string'
        ? err.remoteMessage
        : typeof nested?.detail === 'string'
          ? nested.detail
          : typeof nested?.remoteMessage === 'string'
            ? nested.remoteMessage
            : undefined;
  const rawScope =
    typeof err.scope === 'string'
      ? err.scope
      : typeof err.errorScope === 'string'
        ? err.errorScope
        : typeof nested?.scope === 'string'
          ? nested.scope
          : typeof nested?.errorScope === 'string'
            ? nested.errorScope
            : undefined;
  const scope = rawScope?.trim() || undefined;
  const isTimeout =
    err.name === 'TimeoutError' || nested?.name === 'TimeoutError';
  const errorUploaded =
    typeof err.errorUploaded === 'number'
      ? err.errorUploaded
      : typeof err.uploaded === 'number'
        ? err.uploaded
        : typeof nested?.errorUploaded === 'number'
          ? nested.errorUploaded
          : typeof nested?.uploaded === 'number'
            ? nested.uploaded
            : undefined;
  const errorTotal =
    typeof err.errorTotal === 'number'
      ? err.errorTotal
      : typeof err.total === 'number'
        ? err.total
        : typeof nested?.errorTotal === 'number'
          ? nested.errorTotal
          : typeof nested?.total === 'number'
            ? nested.total
            : undefined;
  const errorFileName =
    typeof err.errorFileName === 'string'
      ? err.errorFileName
      : typeof err.fileName === 'string'
        ? err.fileName
        : typeof nested?.errorFileName === 'string'
          ? nested.errorFileName
          : typeof nested?.fileName === 'string'
            ? nested.fileName
            : undefined;
  const errorReason =
    typeof err.errorReason === 'string'
      ? err.errorReason
      : typeof err.reason === 'string'
        ? err.reason
        : typeof nested?.errorReason === 'string'
          ? nested.errorReason
          : typeof nested?.reason === 'string'
            ? nested.reason
            : undefined;
  return {
    status,
    code,
    ...(rawMessage ? { message: stripInvokeErrorPrefix(rawMessage) } : {}),
    ...(detail ? { detail } : {}),
    ...(scope ? { scope } : {}),
    ...(isTimeout ? { isTimeout: true } : {}),
    ...(errorUploaded !== undefined ? { errorUploaded } : {}),
    ...(errorTotal !== undefined ? { errorTotal } : {}),
    ...(errorFileName !== undefined ? { errorFileName } : {}),
    ...(errorReason !== undefined ? { errorReason } : {}),
  };
}

export function classifyRemoteBotFailure(
  reason: unknown,
  ctx?: RemoteBotFailureContext,
): RemoteBotFailure {
  const { status, code, message, detail, scope, isTimeout } =
    readFailureMeta(reason);
  const combinedDetail = [message, detail].filter(Boolean).join('\n');
  const settingsPath =
    ctx?.settingsPath || t('<app data folder>/runtime-home/settings.json');
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
  if (status === 401) {
    return {
      kind: 'auth',
      retryable: false,
      title: t('bot sign-in expired'),
      cause: t(
        'Hub rejected the credential because it expired or was revoked.',
      ),
      action: ctx?.hasAuthorizationHeader
        ? t(
            'Update the direct member Bearer token (format: Bearer <token>) for Hub in {path}, then retry.',
            { path: settingsPath },
          )
        : t('Sign in to Hub again in Settings -> Extensions, then retry.'),
    };
  }
  if (code === 'BOT_CLIENT_FORBIDDEN' || status === 403) {
    if (/控制台|console credential/i.test(combinedDetail)) {
      return {
        kind: 'oauth-forbidden',
        retryable: false,
        title: t('console credential not allowed'),
        cause: t('Hub rejected the console session credential for my bot API.'),
        action: t(
          'Configure a direct member Bearer token (format: Bearer <token>) for Hub headers.Authorization in {path}, then retry. Disconnecting removes manual headers; add them again after reconnecting.',
          { path: settingsPath },
        ),
        ...(detail || message ? { detail: detail ?? message } : {}),
      };
    }
    if (/\b(?:Host|Origin)\b/i.test(combinedDetail)) {
      return {
        kind: 'oauth-forbidden',
        retryable: false,
        title: t('request origin or host rejected'),
        cause: t(
          'Hub rejected the request Host or Origin header for my bot API.',
        ),
        action: t(
          'Check the Hub address in Settings -> Extensions or allowed hosts on Hub, then retry.',
        ),
        ...(detail || message ? { detail: detail ?? message } : {}),
      };
    }
    if (!ctx?.hasAuthorizationHeader) {
      return {
        kind: 'oauth-forbidden',
        retryable: false,
        canReauthorize: true,
        ...(scope ? { reauthorizeScope: scope } : {}),
        title: t('bot access not granted'),
        cause: t(
          'Sign in again, and check “Allow this client to use my bot” on the Hub confirmation page.',
        ),
        action: t(
          'Or configure a direct member Bearer token (format: Bearer <token>) for Hub headers.Authorization in {path}, then retry. Disconnecting removes manual headers; add them again after reconnecting.',
          { path: settingsPath },
        ),
      };
    }
    return {
      kind: 'oauth-forbidden',
      retryable: false,
      title: t('direct member token required'),
      cause: t('Hub refused the OAuth sign-in token for my bot API.'),
      action: t(
        'Add a direct member Bearer Authorization header (format: Bearer <token>) for Hub in {path}, then retry. Disconnecting removes manual headers; add them again after reconnecting.',
        { path: settingsPath },
      ),
    };
  }
  const unsetSecretMatch =
    message !== undefined
      ? /the Authorization header names \$\{([^}]+)\}, which is not set(?:;\s*save it with \/secrets ([A-Za-z0-9_]+))?/i.exec(
          message,
        )
      : null;
  if (unsetSecretMatch) {
    const secretName =
      unsetSecretMatch[2] ?? unsetSecretMatch[1]!.replace(/^secret:/, '');
    return {
      kind: 'local-credential',
      retryable: false,
      title: t('Hub authorization secret missing'),
      cause: t(
        'The Hub Authorization header references missing secret {name}.',
        { name: '${' + unsetSecretMatch[1] + '}' },
      ),
      action: t(
        'Save secret {secret} (/secrets {secret}) in Settings -> Variables & Secrets or update headers.Authorization in {path}, then retry.',
        { secret: secretName, path: settingsPath },
      ),
    };
  }
  if (message !== undefined && /MCP sign-in is required/i.test(message)) {
    return {
      kind: 'local-credential',
      retryable: false,
      ...(ctx?.hasAuthorizationHeader
        ? {
            title: t('invalid Hub authorization header'),
            cause: t(
              'The Hub Authorization header is missing a valid Bearer prefix or token.',
            ),
            action: t(
              'Update Hub headers.Authorization in {path} using Bearer <token> format, then retry.',
              { path: settingsPath },
            ),
          }
        : {
            title: t('Hub sign-in required'),
            cause: t(
              'Hub connection is missing a valid local sign-in credential.',
            ),
            action: t(
              'Sign in to Hub in Settings -> Extensions or add a direct member Bearer token (format: Bearer <token>) in {path}, then retry.',
              { path: settingsPath },
            ),
          }),
    };
  }
  const unsafeTransport =
    message !== undefined &&
    /requires https or loopback http|invalid remote bot server/i.test(message);
  if (unsafeTransport) {
    return {
      kind: 'local-https',
      retryable: false,
      title: t('HTTPS required for remote bot'),
      cause: t(
        'Remote bot connections require an https:// address or a loopback http:// address.',
      ),
      action: t(
        'Update the Hub URL to https:// in Settings -> Extensions or {path}, then retry.',
        { path: settingsPath },
      ),
    };
  }
  if (status === 429 || code === 'BOT_BUSY') {
    return {
      kind: 'transient',
      retryable: true,
      title: t('remote bot busy'),
      cause: t('The bot queue is full or rate-limited right now.'),
      action: t('Circle will retry shortly with backoff, or retry now.'),
    };
  }
  if (
    isTimeout ||
    status === undefined ||
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return {
      kind: 'transient',
      retryable: true,
      title: t('remote bot disconnected'),
      cause: t('Cannot reach the Hub bot endpoint right now.'),
      action: t('Circle will retry automatically with backoff, or retry now.'),
    };
  }
  if (code === 'BOT_QUOTA_EXCEEDED') {
    return {
      kind: 'other',
      retryable: false,
      title: t('bot attachment quota exceeded'),
      cause: t('Your member bot attachment storage has reached its limit.'),
      action: t(
        'Wait for older attachments to expire, or send without attachments.',
      ),
      ...(detail || message ? { detail: detail ?? message } : {}),
    };
  }
  if (code === 'BOT_NOT_FOUND' || status === 404) {
    return {
      kind: 'other',
      retryable: false,
      title: t('remote bot resource not found'),
      cause: t('Hub could not find the requested bot conversation or file.'),
      action: t('Start a new bot conversation or retry.'),
      ...(detail || message ? { detail: detail ?? message } : {}),
    };
  }
  if (code === 'BOT_CONFLICT' || status === 409) {
    return {
      kind: 'other',
      retryable: false,
      title: t('remote bot state conflict'),
      cause: t(
        'The request conflicts with an earlier bot conversation or request record.',
      ),
      action: t('Reload the bot conversation and retry with a new request.'),
      ...(detail || message ? { detail: detail ?? message } : {}),
    };
  }
  if (status === 422 && code === 'BOT_INVALID_REQUEST') {
    return {
      kind: 'other',
      retryable: false,
      title: t('attachment integrity check failed'),
      cause: t('Hub rejected the message because the attachment check failed.'),
      action: t('Remove and attach the file again, then retry.'),
      ...(detail || message ? { detail: detail ?? message } : {}),
    };
  }
  if (
    code === 'BOT_INVALID_REQUEST' ||
    status === 400 ||
    status === 413 ||
    status === 422
  ) {
    return {
      kind: 'other',
      retryable: false,
      title: t('invalid remote bot request'),
      cause: t(
        'Hub rejected the bot request because its parameters or size are invalid.',
      ),
      action: t('Check the message or attachment limits and retry.'),
      ...(detail || message ? { detail: detail ?? message } : {}),
    };
  }
  return {
    kind: 'other',
    retryable: false,
    title: t('remote bot request failed'),
    cause: t('Hub returned an unexpected error for my bot.'),
    action: t('Check the Hub connection and retry.'),
    ...(detail || message ? { detail: detail ?? message } : {}),
  };
}

const TRANSFER_TEXT_LABELS: Readonly<Record<string, () => string>> = {
  'select up to eight files': () => t('select up to eight files'),
  'symbolic links cannot be attached': () =>
    t('symbolic links cannot be attached'),
  'only a regular file can be attached': () =>
    t('only a regular file can be attached'),
  'file exceeds the 100 MiB limit': () => t('file exceeds the 100 MiB limit'),
  'remote bot requires https or loopback http': () =>
    t('remote bot requires https or loopback http'),
  'file upload was not verified': () => t('file upload was not verified'),
  'file unavailable': () => t('file unavailable'),
  'file digest mismatch': () => t('file digest mismatch'),
  'file size mismatch': () => t('file size mismatch'),
  'remote bot unavailable': () => t('remote bot unavailable'),
  'remote bot connection changed': () => t('remote bot connection changed'),
  'invalid remote bot server': () => t('invalid remote bot server'),
  'file identity changed': () => t('file identity changed'),
  'invalid file receipt': () => t('invalid file receipt'),
  'invalid remote file': () => t('invalid remote file'),
  'file transfer failed': () => t('file transfer failed'),
  'fetch failed': () => t('fetch failed'),
  'The operation was aborted due to timeout': () =>
    t('The operation was aborted due to timeout'),
  'invalid remote bot connection': () => t('invalid remote bot connection'),
  'invalid remote file operation': () => t('invalid remote file operation'),
  'unknown remote bot operation': () => t('unknown remote bot operation'),
  'runtime not enabled': () => t('runtime not enabled'),
  'client version outdated': () => t('Circle update required'),
  'invalid bot client version': () => t('invalid client version'),
  'remote bot disabled': () => t('my bot is disabled'),
  'oauth client token rejected': () => t('oauth client token rejected'),
  'bot sign-in expired': () => t('bot sign-in expired'),
  'remote bot resource not found': () => t('remote bot resource not found'),
  'remote bot state conflict': () => t('remote bot state conflict'),
  'bot attachment quota exceeded': () => t('bot attachment quota exceeded'),
  'invalid remote bot request': () => t('invalid remote bot request'),
  'remote bot busy': () => t('remote bot busy'),
  'remote bot request timed out': () => t('remote bot request timed out'),
  'attachment integrity check failed': () =>
    t('attachment integrity check failed'),
  'untrusted IPC sender': () => t('untrusted IPC sender'),
  'file permission denied': () => t('file permission denied'),
  'cannot access a directory as a file': () =>
    t('cannot access a directory as a file'),
};

const LOCAL_TRANSFER_ERRORS = new Set([
  'select up to eight files',
  'symbolic links cannot be attached',
  'only a regular file can be attached',
  'file exceeds the 100 MiB limit',
  'remote bot requires https or loopback http',
  'file digest mismatch',
  'file size mismatch',
  'file identity changed',
  'invalid file receipt',
  'invalid remote file',
  'invalid remote bot server',
  'remote bot connection changed',
  'invalid remote bot connection',
  'invalid remote file operation',
  'unknown remote bot operation',
  'runtime not enabled',
  'untrusted IPC sender',
  'file permission denied',
  'cannot access a directory as a file',
]);

function translateTransferReason(
  cleaned: string,
  meta: {
    status?: number;
    code?: string;
    detail?: string;
    isTimeout?: boolean;
  },
): string | undefined {
  if (LOCAL_TRANSFER_ERRORS.has(cleaned)) {
    return TRANSFER_TEXT_LABELS[cleaned]!();
  }
  if (/untrusted IPC sender/i.test(cleaned)) {
    return t('untrusted IPC sender');
  }
  if (/MCP sign-in is required/i.test(cleaned)) {
    return t('MCP sign-in is required');
  }
  const unsetSecret =
    /the Authorization header names \$\{([^}]+)\}, which is not set(?:;\s*save it with \/secrets ([A-Za-z0-9_]+))?/i.exec(
      cleaned,
    );
  if (unsetSecret) {
    const secretName =
      unsetSecret[2] ?? unsetSecret[1]!.replace(/^secret:/, '');
    return t(
      'Authorization header secret {name} is not set; save {secret} in Variables & Secrets first.',
      { name: '${' + unsetSecret[1] + '}', secret: secretName },
    );
  }
  if (
    meta.code === 'ENOENT' ||
    /\bENOENT\b|no such file or directory/i.test(cleaned)
  ) {
    return t('file unavailable');
  }
  if (
    meta.code === 'EACCES' ||
    meta.code === 'EPERM' ||
    /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|file permission denied/i.test(
      cleaned,
    )
  ) {
    return t('file permission denied');
  }
  if (
    meta.code === 'EISDIR' ||
    /\bEISDIR\b|illegal operation on a directory|cannot access a directory as a file/i.test(
      cleaned,
    )
  ) {
    return t('cannot access a directory as a file');
  }
  if (/^fetch failed(?:\b|:)/i.test(cleaned)) {
    return t('fetch failed');
  }
  if (meta.isTimeout || /aborted due to timeout/i.test(cleaned)) {
    return t('The operation was aborted due to timeout');
  }
  const combinedDetail = [cleaned, meta.detail].filter(Boolean).join('\n');
  if (meta.code === 'BOT_VERSION_MISMATCH' || meta.status === 426) {
    return t('Circle update required');
  }
  if (meta.code === 'BOT_VERSION_INVALID') {
    return t('invalid client version');
  }
  if (meta.code === 'BOT_DISABLED') {
    return t('my bot is disabled');
  }
  if (meta.status === 401) {
    return t('bot sign-in expired');
  }
  if (meta.code === 'BOT_CLIENT_FORBIDDEN' || meta.status === 403) {
    if (/控制台|console credential/i.test(combinedDetail)) {
      return t('console credential not allowed');
    }
    if (/\b(?:Host|Origin)\b/i.test(combinedDetail)) {
      return t('request origin or host rejected');
    }
    return t('oauth client token rejected');
  }
  if (meta.code === 'BOT_QUOTA_EXCEEDED') {
    return t('bot attachment quota exceeded');
  }
  if (meta.code === 'BOT_NOT_FOUND' || meta.status === 404) {
    return t('remote bot resource not found');
  }
  if (meta.code === 'BOT_CONFLICT' || meta.status === 409) {
    return t('remote bot state conflict');
  }
  if (meta.code === 'BOT_BUSY' || meta.status === 429) {
    return t('remote bot busy');
  }
  if (meta.code === 'BOT_REQUEST_TIMEOUT' || meta.status === 408) {
    return t('remote bot request timed out');
  }
  if (meta.status === 422 && meta.code === 'BOT_INVALID_REQUEST') {
    return t('attachment integrity check failed');
  }
  if (
    meta.code === 'BOT_INVALID_REQUEST' ||
    meta.status === 400 ||
    meta.status === 413 ||
    meta.status === 422
  ) {
    if (meta.status === 413 && /100\s*MiB|file exceeds/i.test(combinedDetail)) {
      return t('file exceeds the 100 MiB limit');
    }
    return t('invalid remote bot request');
  }
  if (
    meta.code === 'BOT_UPSTREAM_UNAVAILABLE' ||
    meta.status === 500 ||
    meta.status === 502 ||
    meta.status === 503 ||
    meta.status === 504
  ) {
    return t('remote bot unavailable');
  }
  if (Object.hasOwn(TRANSFER_TEXT_LABELS, cleaned)) {
    return TRANSFER_TEXT_LABELS[cleaned]!();
  }
  return undefined;
}

const PARTIAL_BATCH_RE =
  /^Uploaded (\d+) of (\d+) files; failed on (.+?): ([\s\S]+)$/;

export function translateBotTransferError(
  reason: unknown,
  fallback: string,
): string {
  const meta = readFailureMeta(reason);
  if (
    meta.errorUploaded !== undefined &&
    meta.errorTotal !== undefined &&
    meta.errorFileName !== undefined &&
    meta.errorReason !== undefined
  ) {
    const inner = stripInvokeErrorPrefix(meta.errorReason);
    const translatedInner =
      translateTransferReason(inner, {
        status: meta.status,
        code: meta.code,
        detail: meta.detail,
        isTimeout: meta.isTimeout,
      }) ?? inner;
    return t(
      'Uploaded {uploaded} of {total} files; failed on {name}: {reason}',
      {
        uploaded: meta.errorUploaded,
        total: meta.errorTotal,
        name: meta.errorFileName,
        reason: translatedInner,
      },
    );
  }
  const raw =
    meta.message ??
    (reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : '');
  const cleaned = stripInvokeErrorPrefix(raw);
  const partial = PARTIAL_BATCH_RE.exec(cleaned);
  if (partial) {
    const [, uploaded, total, name, inner] = partial;
    const translatedInner =
      translateTransferReason(inner!.trim(), meta) ?? inner!.trim();
    return t(
      'Uploaded {uploaded} of {total} files; failed on {name}: {reason}',
      {
        uploaded: uploaded!,
        total: total!,
        name: name!,
        reason: translatedInner,
      },
    );
  }
  return translateTransferReason(cleaned, meta) ?? (cleaned || fallback);
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
