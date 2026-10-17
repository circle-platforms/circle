// Remembers which release's notes were dismissed. The file lives in the Circle
// home (`whats-new.json`). A first run with no saved work writes the current
// version and shows nothing. An upgrade shows the notes for the versions that
// were actually skipped, once, on the home page.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ensureHome } from './paths.js';
import { compareVersions, validVersion, VERSION } from './version.js';
import { noticeFor, notesSince, type WhatsNewNotice } from './whats_new.js';

const FILE = 'whats-new.json';
/**
 * The last published release that shipped these notes and did not write
 * whats-new.json. A later version, with history and no older install still
 * on disk, has already lived through it.
 */
export const NOTICE_WITHOUT_FILE = '1.7.4';

function readSeen(home: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(join(home, FILE), 'utf8')) as {
      seen?: unknown;
    };
    return typeof value.seen === 'string' ? value.seen : undefined;
  } catch {
    return undefined;
  }
}

function writeSeen(home: string, version: string): void {
  writeFileSync(
    join(ensureHome(home), FILE),
    JSON.stringify({ seen: version }) + '\n',
    { mode: 0o600 },
  );
}

/** A saved key, a secret, or any checkpoint. An empty session row is not history. */
export function circleHasHistory(home: string): boolean {
  if (existsSync(join(home, 'credentials.json'))) return true;
  if (existsSync(join(home, 'secrets.json'))) return true;
  const path = join(home, 'circle.sqlite');
  if (!existsSync(path)) return false;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return Boolean(db.prepare('SELECT 1 FROM checkpoints LIMIT 1').get());
  } catch {
    // Unreadable history is not a first run: show the notes rather than skip them.
    return true;
  } finally {
    db?.close();
  }
}

/** The old extension is still named in settings. An empty `extensions` object is not. */
export function hadCircleServer(home: string): boolean {
  try {
    const raw = JSON.parse(
      readFileSync(join(home, 'settings.json'), 'utf8'),
    ) as {
      extensions?: unknown;
    };
    const extensions = raw.extensions;
    return (
      typeof extensions === 'object' &&
      extensions !== null &&
      !Array.isArray(extensions) &&
      Object.prototype.hasOwnProperty.call(extensions, 'circle-server')
    );
  } catch {
    return false;
  }
}

/** Release folders still installed under a prefix, newest first, older than `current`. */
export function installedBefore(
  current: string,
  prefix = process.env.CIRCLE_INSTALL_PREFIX,
): string | undefined {
  if (!prefix || !validVersion(current)) return undefined;
  let names: string[] = [];
  try {
    names = readdirSync(join(prefix, 'versions'));
  } catch {
    return undefined;
  }
  return names
    .filter((name) => validVersion(name) && compareVersions(name, current) < 0)
    .sort((a, b) => compareVersions(b, a))[0];
}

/**
 * The version whose notes this home has already lived through.
 * A saved seen wins. Otherwise the newest installed release older than
 * `current`. Otherwise, past 1.7.4, that release: it shipped the notes and
 * wrote no file. Otherwise nothing, so the notes of this release are shown.
 */
export function notesBaseline(
  current: string,
  seen: string | undefined,
  prefix?: string,
): string {
  if (seen && validVersion(seen)) return seen;
  const installed = installedBefore(current, prefix);
  if (installed) return installed;
  if (
    validVersion(current) &&
    compareVersions(current, NOTICE_WITHOUT_FILE) > 0
  )
    return NOTICE_WITHOUT_FILE;
  return '0.0.0';
}

/**
 * Records the version an in-app update replaced, when this home has no file
 * yet. The next read then shows only the versions between that and this one.
 */
export function seedWhatsNewFrom(
  home: string,
  from: string,
  current: string,
): void {
  if (readSeen(home)) return;
  if (!validVersion(from) || !validVersion(current)) return;
  if (compareVersions(from, current) >= 0) return;
  writeSeen(home, from);
}

/**
 * The notice still waiting, or nothing. With no file and no history this is a
 * first run: the current version is marked seen and nothing is shown. When the
 * notes between the last-seen version and this one say nothing a person must
 * do, the seen version advances and nothing is shown.
 */
export function pendingWhatsNew(
  home: string,
  version = VERSION,
  prefix = process.env.CIRCLE_INSTALL_PREFIX,
): WhatsNewNotice | undefined {
  const seen = readSeen(home);
  if (!seen && !circleHasHistory(home)) {
    writeSeen(home, version);
    return undefined;
  }
  const from = notesBaseline(version, seen, prefix);
  const items = notesSince(from, version, { hub: hadCircleServer(home) });
  if (!items.length) {
    if (seen !== version) writeSeen(home, version);
    return undefined;
  }
  return noticeFor(version, items);
}

/** Marks the running version seen. The notice stays gone after that. */
export function dismissWhatsNew(home: string, version = VERSION): void {
  writeSeen(home, version);
}
