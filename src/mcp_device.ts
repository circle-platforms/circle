// The device authorization grant (RFC 8628) for an MCP server whose authorization server offers it. Instead of opening
// the authorization page and waiting on a loopback address for the browser to come back, Circle asks for a device code
// and a short user code, shows the user code with the address of the server's page for it, and polls the token
// endpoint until a person approved or refused it there. Nothing on this side needs a browser or a redirect, so the
// sign-in also works where the page cannot be opened from here or cannot reach back to this machine. Nothing here
// belongs to one server: any authorization server that names a device_authorization_endpoint and the grant is used so.
import { setTimeout as delay } from 'node:timers/promises';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** RFC 8628 3.2: the interval when the server names none. */
const DEFAULT_INTERVAL_S = 5;
/** A sign-in never waits longer than this, whatever lifetime the server names. */
const LONGEST_WAIT_S = 30 * 60;

export interface DeviceAuthorization {
  deviceCode: string;
  /** What the person types, as the server wrote it. */
  userCode: string;
  /** The page where it is typed. */
  verificationUri: string;
  /** The same page with the code already filled in, when the server gives one. */
  verificationUriComplete?: string;
  /** When the codes stop working, in milliseconds since the epoch. */
  expiresAt: number;
  /** Seconds between polls. */
  interval: number;
}

/** The server's device authorization endpoint, when its metadata offers the device code grant. */
export function deviceEndpoint(
  discovery: OAuthDiscoveryState | undefined,
): string | undefined {
  const metadata = discovery?.authorizationServerMetadata as
    Record<string, unknown> | undefined;
  const endpoint = metadata?.device_authorization_endpoint;
  const grants = metadata?.grant_types_supported;
  if (
    typeof endpoint !== 'string' ||
    !Array.isArray(grants) ||
    !grants.includes(DEVICE_CODE_GRANT)
  )
    return undefined;
  return webAddress(endpoint);
}

/** An http or https address without user information, or undefined. */
function webAddress(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2048) return undefined;
  try {
    const url = new URL(raw);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** What a server's error answer names (RFC 6749 5.2), or the HTTP status. */
async function errorOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (
      typeof body.error === 'string' &&
      /^[\x20-\x7e]{1,64}$/.test(body.error)
    )
      return body.error;
  } catch {
    // not JSON: the status says enough
  }
  return `HTTP ${response.status}`;
}

const form = (fields: Record<string, string | undefined>): URLSearchParams =>
  new URLSearchParams(
    Object.entries(fields).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/** RFC 8628 3.1, 3.2: asks for a device code and a user code for `resource`. */
export async function startDeviceAuthorization(
  endpoint: string,
  clientId: string,
  resource: string | undefined,
  fetcher: FetchLike = fetch,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<DeviceAuthorization> {
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form({ client_id: clientId, resource }),
    redirect: 'error',
    signal,
  });
  if (!response.ok)
    throw new Error(
      `the server gave no device code: ${await errorOf(response)}`,
    );
  const body = (await response.json()) as Record<string, unknown>;
  const verificationUri = webAddress(body.verification_uri);
  const complete = webAddress(body.verification_uri_complete);
  const expires = Number(body.expires_in);
  const interval =
    body.interval === undefined ? DEFAULT_INTERVAL_S : Number(body.interval);
  if (
    typeof body.device_code !== 'string' ||
    !body.device_code ||
    body.device_code.length > 4096 ||
    typeof body.user_code !== 'string' ||
    !/^[\x21-\x7e][\x20-\x7e]{0,62}[\x21-\x7e]$/.test(body.user_code) ||
    !verificationUri ||
    !Number.isFinite(expires) ||
    expires <= 0 ||
    !Number.isFinite(interval) ||
    interval < 1 ||
    interval > 60
  )
    throw new Error('the server answered the device code request unreadably');
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri,
    ...(complete ? { verificationUriComplete: complete } : {}),
    expiresAt: now() + Math.min(expires, LONGEST_WAIT_S) * 1000,
    interval,
  };
}

/** The sign-in was refused, or its code expired: a new sign-in starts over. */
export class DeviceSignInEnded extends Error {}

/**
 * RFC 8628 3.4, 3.5: polls the token endpoint until the device code gives tokens. It waits the interval before each
 * poll and five seconds longer after each slow_down; a refusal, an expiry, or any other error ends it.
 */
export async function pollDeviceToken(
  tokenEndpoint: string,
  clientId: string,
  resource: string | undefined,
  authorization: DeviceAuthorization,
  fetcher: FetchLike = fetch,
  signal?: AbortSignal,
  now: () => number = Date.now,
  wait: (ms: number, signal?: AbortSignal) => Promise<unknown> = (ms, active) =>
    delay(ms, undefined, { signal: active }),
): Promise<OAuthTokens> {
  let interval = authorization.interval;
  for (;;) {
    await wait(interval * 1000, signal);
    signal?.throwIfAborted();
    if (now() >= authorization.expiresAt)
      throw new DeviceSignInEnded('the code expired; reload to get a new one');
    const response = await fetcher(tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form({
        grant_type: DEVICE_CODE_GRANT,
        device_code: authorization.deviceCode,
        client_id: clientId,
        resource,
      }),
      redirect: 'error',
      signal,
    });
    if (response.ok) return OAuthTokensSchema.parse(await response.json());
    const error = await errorOf(response);
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (error === 'access_denied')
      throw new DeviceSignInEnded('the sign-in was refused');
    if (error === 'expired_token')
      throw new DeviceSignInEnded('the code expired; reload to get a new one');
    throw new Error(`the server refused the code: ${error}`);
  }
}

/** What a server waiting for its device sign-in says in place of its tools. */
export const deviceSignInWaiting = (userCode: string): string =>
  `enter the code ${userCode} on the sign-in page`;
