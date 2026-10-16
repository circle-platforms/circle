// How Circle matches a name against a pattern, and the names it always protects.
// No Node.js import: the desktop settings page checks a pattern the same way the
// runtime applies it (src/approvals.ts, src/sandbox.ts).

/**
 * `*` stands for any run of characters, `?` for one character, and the whole
 * value has to match. File names on Windows are not case sensitive, so callers
 * there pass `insensitive`.
 */
export function matchPattern(
  pattern: string,
  value: string,
  insensitive = false,
): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, insensitive ? 'i' : '').test(value);
}

/**
 * The file names Circle protects whatever `credential_files` says: a command or
 * a file tool may not read, copy or change one of these. `credential_files` adds
 * to this list and can never narrow it. Matched against the file's name, not its
 * folder, so a pattern is `*.key`, never `secrets/*.key`.
 */
export const DEFAULT_CREDENTIAL_FILES = [
  '.env',
  '.env.*',
  '*.env',
  '.netrc',
  '.pgpass',
  '.git-credentials',
  'credentials.json',
  'secrets.json',
  '*.secrets.json',
  'token.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '*.pem',
  '*.p12',
  '*.pfx',
];
