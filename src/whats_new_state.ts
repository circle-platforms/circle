// Remembers which release's notes were dismissed. The file lives in the Circle
// home (`whats-new.json`). A first run with no saved work writes the current
// version and shows nothing; an upgrade shows the notes once, on the home page.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ensureHome } from './paths.js';
import { VERSION } from './version.js';
import { noticeFor, notesSince, type WhatsNewNotice } from './whats_new.js';

const FILE = 'whats-new.json';

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

/**
 * The notice still waiting, or nothing. With no file and no history this is a
 * first run: the current version is marked seen and nothing is shown. When the
 * notes between the last-seen version and this one say nothing a person must
 * do, the seen version advances and nothing is shown.
 */
export function pendingWhatsNew(
  home: string,
  version = VERSION,
): WhatsNewNotice | undefined {
  const seen = readSeen(home);
  if (!seen && !circleHasHistory(home)) {
    writeSeen(home, version);
    return undefined;
  }
  const items = notesSince(seen, version);
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
