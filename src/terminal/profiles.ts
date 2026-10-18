// The person's saved device sessions, like SecureCRT's session list: `terminal-sessions.json`
// in Circle's data folder. A profile never holds a password or a passphrase, only the NAME of
// a saved secret they come from; a key is a path, taken as the file tools take it. The model
// reads the names and connects by them; only a person edits this file, in the application or
// by hand.
import { existsSync } from 'node:fs';
import { VARIABLE_NAME, readJson, writePrivateJson } from '../settings.js';

export interface TerminalProfile {
  name: string;
  transport: 'ssh' | 'telnet';
  host: string;
  port: number;
  user?: string;
  /** The NAME of a saved secret, validated at load: never a value. */
  passwordSecret?: string;
  keyPath?: string;
  /** The NAME of a saved secret for the key's passphrase; never a value. */
  passphraseSecret?: string;
  cols: number;
  rows: number;
}

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/** The device a profile reaches, as `host:port`, lower case: the approval rule's name. */
export function profileTarget(profile: TerminalProfile): string {
  return `${profile.host.toLowerCase()}:${profile.port}`;
}

const NAME = /^[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]{0,99}$/;

function hostAllowed(host: string): boolean {
  // A bare host: no scheme, no path, no spaces, no credentials. IPv6 in brackets.
  if (!host || /\s/.test(host) || host.includes('/')) return false;
  if (host.startsWith('[')) return /^\[[0-9a-f:.]+\]$/i.test(host);
  return /^[a-z0-9][a-z0-9._-]*$/i.test(host);
}

interface LoadedProfile {
  name?: unknown;
  transport?: unknown;
  host?: unknown;
  port?: unknown;
  user?: unknown;
  auth?: unknown;
  cols?: unknown;
  rows?: unknown;
}

/**
 * One entry as saved, or undefined to drop it. A malformed secret name is dropped as a
 * field, not trusted as a value: nothing here can make a profile carry a password.
 */
function parseProfile(entry: LoadedProfile): TerminalProfile | undefined {
  if (typeof entry.name !== 'string' || !NAME.test(entry.name)) return;
  if (entry.transport !== 'ssh' && entry.transport !== 'telnet') return;
  if (typeof entry.host !== 'string' || !hostAllowed(entry.host)) return;
  const defaultPort = entry.transport === 'ssh' ? 22 : 23;
  const port =
    typeof entry.port === 'number' && Number.isInteger(entry.port)
      ? entry.port
      : entry.port === undefined
        ? defaultPort
        : undefined;
  if (!port || port < 1 || port > 65535) return;
  const auth = (entry.auth ?? {}) as Record<string, unknown>;
  const secret = (value: unknown): string | undefined =>
    typeof value === 'string' && VARIABLE_NAME.test(value) ? value : undefined;
  const text = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' &&
    value.length &&
    value.length <= max &&
    !/[\x00-\x1f\x7f]/.test(value)
      ? value
      : undefined;
  return {
    name: entry.name,
    transport: entry.transport,
    host: entry.host,
    port,
    ...(text(entry.user, 128) ? { user: entry.user as string } : {}),
    ...(secret(auth.password) ? { passwordSecret: secret(auth.password) } : {}),
    ...(text(auth.key, 4096) ? { keyPath: auth.key as string } : {}),
    ...(secret(auth.passphrase)
      ? { passphraseSecret: secret(auth.passphrase) }
      : {}),
    cols:
      typeof entry.cols === 'number' &&
      Number.isInteger(entry.cols) &&
      entry.cols >= 20 &&
      entry.cols <= 400
        ? entry.cols
        : DEFAULT_COLS,
    rows:
      typeof entry.rows === 'number' &&
      Number.isInteger(entry.rows) &&
      entry.rows >= 8 &&
      entry.rows <= 200
        ? entry.rows
        : DEFAULT_ROWS,
  };
}

/** The saved profiles, in file order; a malformed file or entry is left out, not fatal. */
export function loadProfiles(file: string): TerminalProfile[] {
  let saved: unknown;
  try {
    if (!existsSync(file)) return [];
    saved = readJson(file);
  } catch {
    return [];
  }
  const list =
    saved && typeof saved === 'object'
      ? (saved as { sessions?: unknown }).sessions
      : undefined;
  if (!Array.isArray(list)) return [];
  const profiles: TerminalProfile[] = [];
  const names = new Set<string>();
  for (const entry of list as LoadedProfile[]) {
    if (!entry || typeof entry !== 'object') continue;
    const profile = parseProfile(entry);
    if (!profile || names.has(profile.name)) continue;
    names.add(profile.name);
    profiles.push(profile);
  }
  return profiles;
}

function savedProfile(profile: TerminalProfile): Record<string, unknown> {
  return {
    name: profile.name,
    transport: profile.transport,
    host: profile.host,
    port: profile.port,
    ...(profile.user ? { user: profile.user } : {}),
    ...(profile.passwordSecret || profile.keyPath || profile.passphraseSecret
      ? {
          auth: {
            ...(profile.passwordSecret
              ? { password: profile.passwordSecret }
              : {}),
            ...(profile.keyPath ? { key: profile.keyPath } : {}),
            ...(profile.passphraseSecret
              ? { passphrase: profile.passphraseSecret }
              : {}),
          },
        }
      : {}),
    ...(profile.cols !== DEFAULT_COLS ? { cols: profile.cols } : {}),
    ...(profile.rows !== DEFAULT_ROWS ? { rows: profile.rows } : {}),
  };
}

/** Rewrites the whole list, 0600 and atomic, like the other private JSON files. */
export function saveProfiles(file: string, profiles: TerminalProfile[]): void {
  writePrivateJson(file, { sessions: profiles.map(savedProfile) });
}

export function findProfile(
  profiles: TerminalProfile[],
  name: string,
): TerminalProfile | undefined {
  const wanted = name.trim().toLowerCase();
  return profiles.find((p) => p.name.toLowerCase() === wanted);
}

/**
 * A device an action names without a profile: `host` as it stands or with an explicit
 * port, checked like a profile's. Nothing else: no scheme, no user, no path.
 */
export function parseTarget(
  transport: 'ssh' | 'telnet',
  host: string,
  port?: number,
): { host: string; port: number; target: string } | undefined {
  const clean = host.trim().toLowerCase();
  if (!hostAllowed(clean)) return;
  const wanted = port ?? (transport === 'ssh' ? 22 : 23);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) return;
  return { host: clean, port: wanted, target: `${clean}:${wanted}` };
}
