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
 * Whether one name in a path inside the workspace keeps that path from the desktop
 * application's file access: `.git`, `.circle` or a credential file name. On macOS and
 * Windows, whose file systems usually ignore case, case is ignored here too, so `.ENV` is
 * the credential file `.env` and `.Git` is `.git`. read_file's text reads there and an MCP
 * tool's file parameter both go by it.
 */
export function protectedWorkspaceName(
  name: string,
  credentialFiles: readonly string[],
  platform: string,
): boolean {
  const fold = platform === 'darwin' || platform === 'win32';
  const folded = fold ? name.toLowerCase() : name;
  return (
    folded === '.git' ||
    folded === '.circle' ||
    credentialFiles.some((pattern) =>
      matchPattern(fold ? pattern.toLowerCase() : pattern, folded),
    )
  );
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
