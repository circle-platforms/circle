// Adapted from Circle Hub (Apache-2.0); see provenance.json. No server imports.
// Credential scan (B02 R[4]), credential-scan@3: private keys, bearer or basic credentials, JWTs, password assignments and
// cloud keys. Findings carry the detector id and the position only, never the matched text. The bytes are scanned in every
// form a reader could be served: the decoded text (UTF-8, also lossy as text() serves it; UTF-16 with or without a byte order
// mark; GB 18030; windows-1252), the same text without NUL, and every quoted string with its escapes undone (also JSON
// nested inside a JSON string). Each pattern stops after MAX_FINDINGS + 1 hits and every look-ahead is bounded, so a scan is
// linear in the input. Bytes that are not text (compressed containers, images, other binary) are reported as not
// inspected, never as clean.
export interface CredentialFinding {
  detector: string;
  offset: number;
  line: number;
  column: number;
}
export interface CredentialScan {
  scanner: string;
  inspected: boolean;
  clean: boolean;
  findings: CredentialFinding[];
  truncated: boolean;
}
import { decodeHtmlEntity } from './html-entity.js';

export const CREDENTIAL_SCANNER = 'credential-scan@3';
export const CREDENTIAL_DETECTORS = [
  'private_key',
  'bearer_credential',
  'basic_credential',
  'jwt',
  'password_assignment',
  'cloud_key',
] as const;
export type CredentialDetector = (typeof CREDENTIAL_DETECTORS)[number];

export const CREDENTIAL_FINDING_LIMIT = 100;
const MAX_FINDINGS = CREDENTIAL_FINDING_LIMIT;
/** Quoted strings and encoded scan views are expanded this many levels deep. */
const MAX_NESTING = 4;
/**
 * Share of C0 control bytes (NUL included, white space excluded) above which bytes are binary rather than text. Random or
 * compressed bytes have about 11%; text almost none (a log with colour codes a few percent).
 */
const BINARY_CONTROL_SHARE = 0.05;
const SAMPLE_BYTES = 64 * 1024;

type Report = ((index: number, matched: string) => void) & { limit?: number };

/** Where a hit was found: the decoded (and, inside a quoted string, unescaped) text and the index in it. */
interface Located {
  text: string;
  index: number;
}

interface RawHit {
  detector: CredentialDetector;
  index: number;
  /** Kept only when the caller asked for the text around the findings (scanWithContexts). */
  at?: Located;
  matched?: string;
  additional?: string[];
  incomplete?: boolean;
}

/** Characters a context takes before a hit, after it (its line and the next one at most), and after a key header. */
const CONTEXT_BEFORE = 256;
const CONTEXT_AFTER = 1024;
const KEY_CONTEXT_AFTER = 8192;

const PLACEHOLDER =
  /^(?:<[^>]*>|\[[^\]]*\]|\{\{.*\}\}|\$\{.*\}|%[A-Za-z_][A-Za-z0-9_]*%|\*+|•+|x{3,}|X{3,}|\.{3,}|…+|_+|-+|#+|null|nil|none|true|false|undefined|empty|changeme|change_me|change-me|example|sample|placeholder|redacted|hidden|masked|secret|password|passwd|pass|pwd|token|string|value|todo|tbd|n\/a|your[_-].*|my[_-].*)$/i;

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value) || /example/i.test(value);
}

/** Exact reference syntaxes that name a secret kept elsewhere; a value that merely starts with @ or ! is not one. */
function isReference(value: string): boolean {
  return (
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value) || // $VAR
    /^\$[0-9]$/.test(value) || // $1
    /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(value) || // %VAR%
    /^![A-Za-z][A-Za-z_]*$/.test(value) || // YAML tag such as !vault or !Ref
    /^[&*][A-Za-z_][A-Za-z0-9_-]*$/.test(value) || // YAML anchor or alias
    /^@(?:[./~]|[A-Za-z]:\\)/.test(value) // @/path: read from a file
  );
}

function trimValue(raw: string): string {
  return raw.replace(/[.,;:!?)\]}>"'。，；]+$/u, '');
}

/** A value that reads like a secret, not like prose, a placeholder, a path or a code reference. */
function isSecretValue(raw: string): boolean {
  const value = trimValue(raw);
  if (value.length < 6 || value.length > 200) return false;
  if (!/^[\x21-\x7e]+$/.test(value)) return false;
  if (isPlaceholder(value)) return false;
  if (/[()[\]{}]/.test(value)) return false;
  if (isReference(value)) return false;
  if (/^(?:~|\.{1,2})?\//.test(value)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value))
    return false;
  if (/^[A-Za-z_-]+$/.test(value)) return false;
  return /[0-9]/.test(value) || /[^A-Za-z0-9_-]/.test(value);
}

/** For forms without an assignment sign: letters and digits, and not a hyphenated English word. */
function isStrictSecretValue(raw: string): boolean {
  const value = trimValue(raw);
  return (
    isSecretValue(value) &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value) &&
    !/-[a-z]{3,}/.test(value)
  );
}

/** An opaque token: long enough, mixes letters and digits, not a placeholder. */
function isTokenValue(raw: string): boolean {
  const value = trimValue(raw);
  return (
    value.length >= 16 &&
    value.length <= 400 &&
    /[0-9]/.test(value) &&
    /[A-Za-z]/.test(value) &&
    /^[\x21-\x7e]+$/.test(value) &&
    !isPlaceholder(value)
  );
}

const TOKEN_PREFIXES = new Set([
  '',
  'auth',
  'access',
  'refresh',
  'api',
  'bearer',
  'session',
  'private',
  'secret',
  'oauth',
  'personal',
]);
const PAGINATION = /(?:page|next|prev|previous|continuation|cursor|sync)$/;

/** The identifier characters right before a keyword (DB_ in DB_PASSWORD, user in userToken). */
function prefixBefore(text: string, index: number): string {
  let start = index;
  while (
    start > 0 &&
    start > index - 60 &&
    /[A-Za-z0-9_.-]/.test(text[start - 1]!)
  )
    start--;
  return text.slice(start, index);
}

/** `token` keys: a credential prefix takes any secret-looking value; another identifier (PLM_TOKEN, userToken) a token-shaped one. */
function tokenAccepted(prefix: string, value: string): boolean {
  const lower = prefix.toLowerCase().replace(/[_.-]+$/, '');
  if (PAGINATION.test(lower)) return false;
  if (TOKEN_PREFIXES.has(lower.split(/[_.-]/).pop() ?? ''))
    return isSecretValue(value);
  return isTokenValue(value);
}

/** `pass` and `pwd` only as a word of their own or a camelCase part: not bypass, compass. */
function shortKeyAllowed(text: string, index: number): boolean {
  const before = text[index - 1]!;
  if (before === undefined || !/[A-Za-z0-9]/.test(before)) return true;
  return /[A-Z]/.test(text[index]!) && /[a-z0-9]/.test(before);
}

/** Runs a global pattern, reporting accepted matches; stops after MAX_FINDINGS + 1 of them (later ones are never kept). */
function each(
  text: string,
  pattern: RegExp,
  accept: (match: RegExpExecArray) => boolean,
  report: Report,
  at: (match: RegExpExecArray) => number = (match) => match.index,
  matched: (match: RegExpExecArray) => string = (match) => match[0]!,
): void {
  pattern.lastIndex = 0;
  let accepted = 0;
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    if (accept(match)) {
      report(at(match), matched(match));
      if (++accepted > (report.limit ?? MAX_FINDINGS)) return;
    }
    if (match[0]!.length === 0) pattern.lastIndex++;
  }
}

/** Calls `check(match, limit)` for each match, where limit is the start of the next match (a look-ahead never reaches past it). */
function eachBounded(
  text: string,
  pattern: RegExp,
  check: (match: RegExpExecArray, limit: number) => boolean,
  report: Report,
  matchText: (match: RegExpExecArray, limit: number) => string = (match) =>
    match[0]!,
): void {
  pattern.lastIndex = 0;
  let accepted = 0;
  let pending = pattern.exec(text);
  while (pending !== null) {
    const next = pattern.exec(text);
    if (check(pending, next === null ? text.length : next.index)) {
      report(
        pending.index,
        matchText(pending, next === null ? text.length : next.index),
      );
      if (++accepted > (report.limit ?? MAX_FINDINGS)) return;
    }
    pending = next;
  }
}

const PEM_HEADER =
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP |SSH2 ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g;
const PUTTY_HEADER = /PuTTY-User-Key-File-[0-9]+:/g;
const PUTTY_PRIVATE = /Private-Lines:[ \t]*[0-9]+/g;
const ARMOR_HEADER = /^[A-Za-z][A-Za-z0-9-]{0,40}:/;

function isBreak(text: string, index: number): number {
  const c = text.charCodeAt(index);
  if (c === 10 || c === 13) return 1;
  if (c === 92 && (text[index + 1]! === 'n' || text[index + 1]! === 'r'))
    return 2;
  return 0;
}

/** Key material after a PEM header within [from, to): optional armor headers, then at least 32 base64 characters. */
function keyMaterialFollows(text: string, from: number, to: number): boolean {
  let index = from;
  const skipSpace = () => {
    while (index < to) {
      const c = text.charCodeAt(index);
      if (c === 32 || c === 9) index++;
      else {
        const step = isBreak(text, index);
        if (step === 0) return;
        index += step;
      }
    }
  };
  skipSpace();
  for (let headers = 0; headers < 8 && index < to; headers++) {
    if (!ARMOR_HEADER.test(text.slice(index, Math.min(to, index + 42)))) break;
    while (index < to && isBreak(text, index) === 0) index++;
    if (index >= to) return false;
    skipSpace();
  }
  let run = 0;
  while (index < to && run < 32 && /[A-Za-z0-9+/=]/.test(text[index]!)) {
    run++;
    index++;
  }
  return run >= 32;
}

function privateKeys(text: string, report: Report): void {
  eachBounded(
    text,
    PEM_HEADER,
    (match, limit) =>
      keyMaterialFollows(
        text,
        match.index + match[0]!.length,
        Math.min(limit, match.index + match[0]!.length + 800),
      ),
    report,
    (match, limit) => {
      // A header alone is shared by unrelated private keys. Include the entire observed key,
      // including its material; without a closing marker conservatively include the remainder.
      const close = text.indexOf('-----END ', match.index + match[0]!.length);
      const end = close < 0 ? -1 : text.indexOf('-----', close + 9);
      let material = text.slice(
        match.index,
        end < 0 || end + 5 > limit ? limit : end + 5,
      );
      // JSON may spell the key's line breaks and slashes as escapes. The key alphabet
      // contains no literal backslashes, so compare the exact decoded key material.
      for (
        let depth = 0;
        depth < MAX_NESTING && material.includes('\\');
        depth++
      )
        material = unescape(material);
      return material;
    },
  );
  // A PuTTY key file: its Private-Lines line follows the header within 4000 characters and before the next header.
  PUTTY_PRIVATE.lastIndex = 0;
  let privateLine = PUTTY_PRIVATE.exec(text);
  eachBounded(
    text,
    PUTTY_HEADER,
    (match, limit) => {
      while (privateLine !== null && privateLine.index <= match.index)
        privateLine = PUTTY_PRIVATE.exec(text);
      return (
        privateLine !== null &&
        privateLine.index < Math.min(limit, match.index + 4000)
      );
    },
    report,
    (match, limit) => text.slice(match.index, limit),
  );
}

function bearerCredentials(text: string, report: Report): void {
  each(
    text,
    /\bBearer\s+([A-Za-z0-9\-._~+/]{20,}=*)/gi,
    (match) => isTokenValue(match[1]!),
    report,
    undefined,
    (match) => match[1]!,
  );
  each(
    text,
    /\b(?:authorization|proxy-authorization|x-api-key|x-auth-token|x-access-token|private-token|api-key)(?:\\?["'])?[ \t]*[:=：][ \t]*(?:\\?["'])?([A-Za-z0-9\-._~+/]{16,}=*)/gi,
    (match) => isTokenValue(match[1]!),
    report,
    undefined,
    (match) => match[1]!,
  );
}

function basicCredentials(text: string, report: Report): void {
  each(
    text,
    /\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/gi,
    (match) => {
      const decoded = Buffer.from(match[1]!, 'base64');
      if (decoded.toString('base64') !== match[1]!) return false;
      return /^[\x21-\x7e]{1,200}:[\x20-\x7e]{1,200}$/.test(
        decoded.toString('latin1'),
      );
    },
    report,
    undefined,
    (match) => match[1]!,
  );
  each(
    text,
    /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s:@/?#'"<>]{0,100}):([^\s@/?#'"<>]{1,200})@[A-Za-z0-9.[\]-]/gi,
    (match) => {
      const password = match[2]!;
      return (
        !isPlaceholder(password) &&
        !/^[$%]/.test(password) &&
        !/^\{\{.*\}\}$/.test(password)
      );
    },
    report,
    undefined,
    (match) => match[2]!,
  );
}

function jwts(text: string, report: Report): void {
  each(
    text,
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g,
    (match) => {
      try {
        const header: unknown = JSON.parse(
          Buffer.from(
            match[0]!.slice(0, match[0]!.indexOf('.')),
            'base64url',
          ).toString('utf8'),
        );
        return (
          typeof header === 'object' &&
          header !== null &&
          typeof (header as Record<string, unknown>).alg === 'string'
        );
      } catch {
        return false;
      }
    },
    report,
  );
}

const KEYS =
  'password|passwd|passphrase|pass|pwd|secret[_-]?key|secret|apikey|api[_-]key|access[_-]key|private[_-]key|auth[_-]key|token';
// key, optional (escaped) quote, a sign (= : => := full-width : = or a table bar), then a double-, single-, typographically
// quoted (text converted from a word processor) or unquoted value.
const ASSIGNMENT = new RegExp(
  String.raw`(${KEYS})(?:\\?["'])?[ \t]*(?:=>|:=|=|:|：|＝|\|)[ \t]*(?:\\?"([^"\\\r\n]{1,200})\\?"|\\?'([^'\\\r\n]{1,200})\\?'|[“‘]([^”’\r\n]{1,200})[”’]|([^\s"'“”‘’<>,;|\\]{1,200}))`,
  'gi',
);
// A password label followed by an argument in a command line or .netrc record.
const SPACED = /\b(password|passwd|pwd)[ \t]+([^\s"'<>,;|\\]{6,200})/gi;
// `<password>X</password>`
const ELEMENT =
  /<(password|passwd|pwd|secret|token|apikey|api[_-]?key)>[ \t]*([^<\s]{1,200})[ \t]*<\//gi;
// YAML with the value on the next line: `password:` then an indented `X`.
const NEXT_LINE =
  /(?:^|\n)[ \t]*([A-Za-z0-9_.-]{0,60}?)(password|passwd|pwd|secret|token|apikey|api[_-]key)[ \t]*:[ \t]*(?:[|>][-+]?[ \t]*)?\r?\n[ \t]+([^\s#'"]{1,200})[ \t]*(?=\r?\n|$)/dgi;
// PostgreSQL password file line: host:port:database:user:password.
const PGPASS =
  /(?:^|\n)([A-Za-z0-9.*_-]{1,253}):([0-9]{1,5}|\*):([^:\s]{1,63}):([^:\s]{1,63}):([^:\s]{1,200})[ \t]*(?=\r?\n|$)/g;
const CN_KEYS = '密码|口令|密钥|秘钥';
const CN_ASSIGNMENT = new RegExp(
  String.raw`(?:${CN_KEYS})[ \t]*(?:[:：=＝|｜]|是|为|為)[ \t]*(?:["“'‘「]([^"”'’」\r\n]{1,200})["”'’」]|([^\s，。；、,;"“”'‘’<>（）()|｜「」]{1,200}))`,
  'g',
);
const CN_SPACED = new RegExp(
  String.raw`(?:${CN_KEYS})[ \t]+([^\s，。；、,;"“”'‘’<>（）()|｜「」]{6,200})`,
  'g',
);

function passwordAssignments(text: string, report: Report): void {
  each(
    text,
    ASSIGNMENT,
    (match) => {
      const keyword = match[1]!.toLowerCase();
      if (
        (keyword === 'pass' || keyword === 'pwd') &&
        !shortKeyAllowed(text, match.index)
      )
        return false;
      const value = match[2]! ?? match[3]! ?? match[4]! ?? match[5]! ?? '';
      return keyword === 'token'
        ? tokenAccepted(prefixBefore(text, match.index), value)
        : isSecretValue(value);
    },
    report,
    undefined,
    (match) => match[2]! ?? match[3]! ?? match[4]! ?? match[5]! ?? '',
  );
  each(
    text,
    SPACED,
    (match) => isStrictSecretValue(match[2]!),
    report,
    undefined,
    (match) => match[2]!,
  );
  each(
    text,
    ELEMENT,
    (match) =>
      match[1]!.toLowerCase() === 'token'
        ? isTokenValue(match[2]!)
        : isSecretValue(match[2]!),
    report,
    undefined,
    (match) => match[2]!,
  );
  each(
    text,
    NEXT_LINE,
    (match) =>
      match[2]!.toLowerCase() === 'token'
        ? tokenAccepted(match[1]!, match[3]!)
        : isSecretValue(match[3]!),
    report,
    (match) => match.indices?.[2]?.[0] ?? match.index,
    (match) => match[3]!,
  );
  each(
    text,
    PGPASS,
    (match) => isSecretValue(match[5]!),
    report,
    (match) => (text[match.index]! === '\n' ? match.index + 1 : match.index),
    (match) => match[5]!,
  );
  each(
    text,
    CN_ASSIGNMENT,
    (match) => isSecretValue(match[1]! ?? match[2]! ?? ''),
    report,
    undefined,
    (match) => match[1]! ?? match[2]! ?? '',
  );
  each(
    text,
    CN_SPACED,
    (match) => isStrictSecretValue(match[1]!),
    report,
    undefined,
    (match) => match[1]!,
  );
}

function hasMixedCase(value: string): boolean {
  return /[0-9]/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value);
}

const always = () => true;
const CLOUD_PATTERNS: Array<[RegExp, (match: RegExpExecArray) => boolean]> = [
  [
    /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g,
    (match) => !isPlaceholder(match[0]!),
  ],
  [
    /\baws_secret_access_key(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    (match) => !isPlaceholder(match[0]!),
  ],
  [/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, always],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, always],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, always],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, always],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, (match) => /[0-9]/.test(match[0]!)],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, always],
  [
    /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
    (match) => hasMixedCase(match[0]!),
  ],
  [/\bLTAI[A-Za-z0-9]{12,20}\b/g, (match) => /[0-9]/.test(match[0]!.slice(4))],
  [/\bAKID[A-Za-z0-9]{13,40}\b/g, (match) => hasMixedCase(match[0]!.slice(4))],
  [/\bAccountKey=([A-Za-z0-9+/]{40,}={0,2})/g, always],
];
function cloudKeys(text: string, report: Report): void {
  for (const [pattern, accept] of CLOUD_PATTERNS)
    each(
      text,
      pattern,
      accept,
      report,
      undefined,
      (match) => match[1]! ?? match[0]!,
    );
}

const DETECTORS: ReadonlyArray<{
  id: CredentialDetector;
  run: (text: string, report: Report) => void;
}> = [
  { id: 'private_key', run: privateKeys },
  { id: 'bearer_credential', run: bearerCredentials },
  { id: 'basic_credential', run: basicCredentials },
  { id: 'jwt', run: jwts },
  { id: 'password_assignment', run: passwordAssignments },
  { id: 'cloud_key', run: cloudKeys },
];

// ---------------------------------------------------------------- quoted strings with escapes

interface Literal {
  start: number;
  end: number;
  value: string;
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
};

function unescape(raw: string): string {
  return raw.replace(
    /\\(?:u([0-9A-Fa-f]{4})|([\s\S]))/g,
    (_, hex: string | undefined, char: string | undefined) =>
      hex !== undefined
        ? String.fromCharCode(Number.parseInt(hex, 16))
        : (ESCAPES[char as string]! ?? (char as string)),
  );
}

/** Double-quoted strings on one line that hold a backslash escape, with the escapes undone (JSON rules, lenient otherwise). */
function escapedLiterals(
  text: string,
  visit: (literal: Literal) => boolean,
): void {
  let from = 0;
  for (;;) {
    const open = text.indexOf('"', from);
    if (open < 0) return;
    let index = open + 1;
    let escaped = false;
    let close = -1;
    while (index < text.length) {
      const c = text.charCodeAt(index);
      if (c === 10 || c === 13) break;
      if (c === 92) {
        escaped = true;
        index += 2;
        continue;
      }
      if (c === 34) {
        close = index;
        break;
      }
      index++;
    }
    if (close < 0) {
      from = index + 1;
      if (from >= text.length) return;
      continue;
    }
    // Strings without an escape equal their raw text, which the patterns already saw.
    if (
      escaped &&
      !visit({
        start: open,
        end: close,
        value: unescape(text.slice(open + 1, close)),
      })
    )
      return;
    from = close + 1;
  }
}

/** A scan-only replacement view. Mapping streams the edits only if findings need original positions. */
function replaced(
  view: View,
  pattern: RegExp,
  replacement: (value: string) => string,
): View {
  // Most Unicode text is already normalized. Do not allocate a whole replacement string for unchanged matches.
  let parts: string[] | null = null,
    from = 0;
  for (const match of view.text.matchAll(pattern)) {
    const value = replacement(match[0]!);
    if (value === match[0]!) continue;
    (parts ??= []).push(view.text.slice(from, match.index), value);
    from = match.index + match[0]!.length;
  }
  if (parts === null) return view;
  parts.push(view.text.slice(from));
  const text = parts.join('');
  return {
    text,
    offsets(indices) {
      const mapped: number[] = [];
      let source = 0,
        target = 0,
        next = 0;
      for (const match of view.text.matchAll(pattern)) {
        const value = replacement(match[0]!),
          start = target + match.index - source;
        while (next < indices.length && indices[next]! < start)
          mapped.push(source + indices[next++]! - target);
        while (next < indices.length && indices[next]! < start + value.length) {
          const at = indices[next++]! - start;
          mapped.push(
            match.index + (value.length === match[0]!.length ? at : 0),
          );
        }
        source = match.index + match[0]!.length;
        target = start + value.length;
        if (next === indices.length) break;
      }
      while (next < indices.length)
        mapped.push(source + indices[next++]! - target);
      return view.offsets(mapped);
    },
  };
}
const HTML_ENTITY = /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]{1,31});?/gi;
const entityCache = new Map<string, string>();
function htmlEntity(value: string): string {
  const cached = entityCache.get(value);
  if (cached !== undefined) return cached;
  const decoded = decodeHtmlEntity(value);
  if (entityCache.size < 256) entityCache.set(value, decoded);
  return decoded;
}
function normalizedText(text: string): View {
  let view: View = { text, offsets: (indices) => [...indices] };
  // Include an ASCII base with combining marks; Hangul jamo normalize as one composition unit.
  const unicode =
    /(?:[\u1100-\u11ff\u3130-\u318f]+|[\x00-\x7f]\p{M}+|[^\x00-\x7f]+)/gu;
  const normalize = (value: string) =>
    value.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  view = replaced(view, unicode, normalize);
  view = replaced(view, HTML_ENTITY, htmlEntity);
  return replaced(view, unicode, normalize);
}

/** Paths are scanned as joined segments and as adjacent key/value pairs; stored paths are untouched. */
function pathLiterals(
  text: string,
  visit: (literal: Literal) => boolean,
): void {
  const paths = /(?:^|(?<=[\s"'`]))\/[^\s"'`<>\\]+/g;
  for (const match of text.matchAll(paths)) {
    const parts = match[0]!.split('/').filter(Boolean);
    if (parts.length < 2) continue;
    const views = [parts.join('')];
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = (prefix + parts[i]!).slice(-60);
      views.push(prefix + '=' + parts[i + 1]!);
    }
    if (
      !visit({
        start: match.index,
        end: match.index + match[0]!.length,
        value: views.join('\n'),
      })
    )
      return;
  }
}
function base64Literals(
  text: string,
  visit: (literal: Literal) => boolean,
): void {
  for (const match of text.matchAll(
    /[A-Za-z0-9+/_-]{24,}(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9+/_-]{2,})*={0,2}/g,
  )) {
    const value = match[0]!.replace(/[ \t\r\n]/g, ''),
      bytes = Buffer.from(value, 'base64url');
    if (
      bytes.toString('base64url') !==
      value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    )
      continue;
    const sample = bytes.subarray(0, SAMPLE_BYTES);
    if (
      isContainer(bytes) ||
      (controlShare(sample) > BINARY_CONTROL_SHARE &&
        !nulPattern(sample).length)
    )
      continue;
    for (const view of decode(bytes).views)
      if (
        !visit({
          start: match.index,
          end: match.index + match[0]!.length,
          value: view.text,
        })
      )
        return;
  }
}

/** Hits in `text`; a hit inside an escaped string is reported at the string's opening quote. */
function scanText(
  text: string,
  depth: number,
  located: boolean,
  limit = MAX_FINDINGS,
): RawHit[] {
  const hits: RawHit[] = [];
  for (const detector of DETECTORS) {
    const report: Report = (index, matched) => {
      hits.push(
        located
          ? { detector: detector.id, index, at: { text, index }, matched }
          : { detector: detector.id, index },
      );
    };
    report.limit = limit;
    detector.run(text, report);
  }
  if (depth >= MAX_NESTING) return hits;
  const direct = [...hits].sort((a, b) => a.index - b.index);
  const coveredBy = (
    detector: CredentialDetector,
    start: number,
    end: number,
  ) => {
    let low = 0;
    let high = direct.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (direct[middle]!.index < start) low = middle + 1;
      else high = middle;
    }
    for (
      let index = low;
      index < direct.length && direct[index]!.index < end;
      index++
    )
      if (direct[index]!.detector === detector) return direct[index]!;
    return null;
  };
  let literalsWithHits = 0;
  const append = (inner: RawHit[], start: number, end: number) => {
    let added = false;
    for (const hit of inner) {
      const covering = coveredBy(hit.detector, start, end);
      if (covering !== null) {
        if (located) {
          (covering.additional ??= []).push(
            ...(hit.matched === undefined ? [] : [hit.matched]),
            ...(hit.additional ?? []),
          );
          if (inner.length > limit || hit.incomplete)
            covering.incomplete = true;
        }
        continue;
      }
      hits.push(
        located
          ? {
              detector: hit.detector,
              index: start,
              at: hit.at,
              matched: hit.matched,
              additional: hit.additional,
              incomplete: hit.incomplete || inner.length > limit,
            }
          : { detector: hit.detector, index: start },
      );
      added = true;
    }
    // A literal hit after MAX_FINDINGS + 1 earlier literal hits can never be among the first MAX_FINDINGS findings.
    if (added) literalsWithHits++;
    return literalsWithHits <= limit;
  };
  const normalized = normalizedText(text);
  if (normalized.text !== text) {
    const inner = scanText(normalized.text, depth + 1, located, limit).sort(
        (a, b) => a.index - b.index,
      ),
      positions = normalized.offsets(inner.map((hit) => hit.index));
    inner.forEach((hit, index) =>
      append([hit], positions[index]!, positions[index]! + 1),
    );
  }
  const visit = (literal: Literal) =>
    append(
      scanText(literal.value, depth + 1, located, limit),
      literal.start,
      literal.end,
    );
  if (text.includes('\\')) escapedLiterals(text, visit);
  pathLiterals(text, visit);
  base64Literals(text, visit);
  return hits;
}

// ---------------------------------------------------------------- decoding

interface View {
  text: string;
  /** Byte offsets in the original bytes of ascending indices into `text`. */
  offsets(indices: readonly number[]): number[];
}

function utf8View(text: string): View {
  return {
    text,
    offsets(indices) {
      const out: number[] = [];
      let index = 0;
      let byte = 0;
      for (const target of indices) {
        while (index < target) {
          const c = text.charCodeAt(index);
          if (c < 0x80) byte += 1;
          else if (c < 0x800) byte += 2;
          else if (c >= 0xd800 && c <= 0xdbff && index + 1 < text.length) {
            byte += 4;
            index++;
          } else byte += 3;
          index++;
        }
        out.push(byte);
      }
      return out;
    },
  };
}

function scaledView(text: string, width: number): View {
  return { text, offsets: (indices) => indices.map((index) => index * width) };
}

/** One step of the WHATWG UTF-8 decoder: bytes consumed and UTF-16 units produced (an ill-formed part gives one U+FFFD). */
function utf8Step(bytes: Uint8Array, at: number): [number, number] {
  const lead = bytes[at]!;
  if (lead < 0x80) return [1, 1];
  let need: number;
  let lower = 0x80;
  let upper = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) need = 1;
  else if (lead >= 0xe0 && lead <= 0xef) {
    need = 2;
    if (lead === 0xe0) lower = 0xa0;
    if (lead === 0xed) upper = 0x9f;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    need = 3;
    if (lead === 0xf0) lower = 0x90;
    if (lead === 0xf4) upper = 0x8f;
  } else return [1, 1];
  for (let step = 1; step <= need; step++) {
    const next = bytes[at + step]!;
    if (
      next === undefined ||
      next < (step === 1 ? lower : 0x80) ||
      next > (step === 1 ? upper : 0xbf)
    )
      return [step, 1];
  }
  return [need + 1, need === 3 ? 2 : 1];
}

/** The lossy UTF-8 decode that text() serves for bytes that are not valid UTF-8 (invalid parts become U+FFFD). */
function lossyUtf8View(bytes: Uint8Array): View {
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  return {
    text,
    offsets(indices) {
      const out: number[] = [];
      let index = 0;
      let byte = 0;
      for (const target of indices) {
        while (index < target && byte < bytes.length) {
          const [consumed, units] = utf8Step(bytes, byte);
          byte += consumed;
          index += units;
        }
        out.push(byte);
      }
      return out;
    },
  };
}

/** GB 18030: one byte below 0x81, four when the second byte is a digit, otherwise two; a four-byte form may give two UTF-16 units. */
function gbView(text: string, bytes: Uint8Array): View {
  return {
    text,
    offsets(indices) {
      const out: number[] = [];
      let index = 0;
      let byte = 0;
      for (const target of indices) {
        while (index < target && byte < bytes.length) {
          const lead = bytes[byte]!;
          if (lead < 0x81 || lead === 0xff) byte += 1;
          else if (bytes[byte + 1]! >= 0x30 && bytes[byte + 1]! <= 0x39)
            byte += 4;
          else byte += 2;
          const c = text.charCodeAt(index);
          index += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
        }
        out.push(Math.min(byte, Math.max(0, bytes.length - 1)));
      }
      return out;
    },
  };
}

/** The bytes without zero bytes: in UTF-8, GB 18030 and single-byte text a NUL character is exactly one zero byte. */
function withoutZeroBytes(bytes: Uint8Array): Uint8Array {
  let zeros = 0;
  for (const byte of bytes) if (byte === 0) zeros++;
  const out = new Uint8Array(bytes.length - zeros);
  let at = 0;
  for (const byte of bytes) if (byte !== 0) out[at++]! = byte;
  return out;
}

/** A view of the bytes without zero bytes; its offsets are mapped back to the original bytes. */
function unstripped(original: Uint8Array, view: View): View {
  return {
    text: view.text,
    offsets(indices) {
      const out: number[] = [];
      let index = 0;
      let kept = 0;
      for (const target of view.offsets(indices)) {
        while (
          index < original.length &&
          (kept < target || original[index]! === 0)
        ) {
          if (original[index]! !== 0) kept++;
          index++;
        }
        out.push(index);
      }
      return out;
    },
  };
}

/** The view without NUL characters (a UTF-16 text holding U+0000); indices map back through the view it was made from. */
function withoutNul(view: View): View {
  const text = view.text.replaceAll('\0', '');
  return {
    text,
    offsets(indices) {
      const original: number[] = [];
      let index = 0;
      let kept = 0;
      for (const target of indices) {
        while (
          index < view.text.length &&
          (kept < target || view.text.charCodeAt(index) === 0)
        ) {
          if (view.text.charCodeAt(index) !== 0) kept++;
          index++;
        }
        original.push(index);
      }
      return view.offsets(original);
    },
  };
}

const DECODERS = new Map<string, TextDecoder | null>();

function decoder(label: string): TextDecoder | null {
  if (DECODERS.has(label)) return DECODERS.get(label)!;
  try {
    const value = new TextDecoder(label, { fatal: true, ignoreBOM: true });
    DECODERS.set(label, value);
    return value;
  } catch {
    DECODERS.set(label, null);
    return null;
  }
}

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return decoder(label)?.decode(bytes) ?? null;
  } catch {
    return null;
  }
}

function startsWith(
  bytes: Uint8Array,
  signature: readonly number[],
  at = 0,
): boolean {
  return (
    bytes.length >= at + signature.length &&
    signature.every((byte, index) => bytes[at + index]! === byte)
  );
}

/** Compressed, archive, document and image containers: their content is not text the scanner could read. */
const CONTAINER_SIGNATURES: ReadonlyArray<readonly number[]> = [
  [0x1f, 0x8b], // gzip
  [0x50, 0x4b, 0x03, 0x04], // zip, xlsx, docx
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], // rar
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
  [0x25, 0x50, 0x44, 0x46, 0x2d], // PDF
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], // OLE2 (doc, xls)
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
];
function isContainer(bytes: Uint8Array): boolean {
  if (CONTAINER_SIGNATURES.some((signature) => startsWith(bytes, signature)))
    return true;
  // bzip2: "BZh", a block size digit, then the block magic (all printable, so the whole header is checked).
  if (
    startsWith(bytes, [0x42, 0x5a, 0x68]) &&
    bytes[3]! >= 0x31 &&
    bytes[3]! <= 0x39 &&
    startsWith(bytes, [0x31, 0x41, 0x59, 0x26, 0x53, 0x59], 4)
  )
    return true;
  return (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ); // WebP
}

/**
 * UTF-16 without a byte order mark, recognised by the zero high bytes of its ASCII characters: NUL in at least 30% of the
 * odd (little-endian) or even (big-endian) byte positions of the sample, and far fewer in the other half (not all-zero data).
 */
function nulPattern(sample: Uint8Array): Array<'utf-16le' | 'utf-16be'> {
  const pairs = Math.floor(sample.length / 2);
  if (pairs < 2) return [];
  let even = 0;
  let odd = 0;
  for (let index = 0; index + 1 < sample.length; index += 2) {
    if (sample[index]! === 0) even++;
    if (sample[index + 1]! === 0) odd++;
  }
  const out: Array<'utf-16le' | 'utf-16be'> = [];
  if (odd / pairs >= 0.3 && even <= odd / 4) out.push('utf-16le');
  if (even / pairs >= 0.3 && odd <= even / 4) out.push('utf-16be');
  return out;
}

/** C0 controls other than white space, and DEL. Bytes 0x80-0x9F are not counted: UTF-8, GB 18030 and windows-1252 text use them. */
function controlShare(sample: Uint8Array): number {
  if (sample.length === 0) return 0;
  let controls = 0;
  for (const byte of sample)
    if ((byte < 0x20 && (byte < 0x09 || byte > 0x0d)) || byte === 0x7f)
      controls++;
  return controls / sample.length;
}

/** The byte-aligned decodings of some bytes (each NUL character is one zero byte in all of them). */
function byteViews(
  bytes: Uint8Array,
  utf8: string | null,
  gb: string | null,
  textual: boolean,
): View[] {
  if (utf8 !== null) return [utf8View(utf8)];
  // Bytes that are no text at all: one character per byte finds what ASCII they hold.
  const singleByte = scaledView(
    new TextDecoder('windows-1252').decode(bytes),
    1,
  );
  if (!textual) return [singleByte];
  // What text() serves (lossy UTF-8), GB 18030 when the bytes are valid GB 18030, and one character per byte (windows-1252,
  // the WHATWG reading of ISO-8859-1 labels, as the build site pages are read).
  return [
    lossyUtf8View(bytes),
    ...(gb === null ? [] : [gbView(gb, bytes)]),
    singleByte,
  ];
}

/** Every text view of the bytes and whether the bytes are text at all. */
function decode(bytes: Uint8Array): { views: View[]; inspected: boolean } {
  if (
    bytes.length >= 2 &&
    ((bytes[0]! === 0xff && bytes[1]! === 0xfe) ||
      (bytes[0]! === 0xfe && bytes[1]! === 0xff))
  ) {
    const view = scaledView(
      new TextDecoder(bytes[0]! === 0xff ? 'utf-16le' : 'utf-16be', {
        ignoreBOM: true,
      }).decode(bytes),
      2,
    );
    return {
      views: view.text.includes('\0') ? [view, withoutNul(view)] : [view],
      inspected: true,
    };
  }
  const sample = bytes.subarray(0, SAMPLE_BYTES);
  const wide = nulPattern(sample);
  const utf8 = tryDecode('utf-8', bytes);
  const gb = utf8 === null ? tryDecode('gb18030', bytes) : null;
  const textual =
    wide.length > 0 || controlShare(sample) <= BINARY_CONTROL_SHARE;
  const views = byteViews(bytes, utf8, gb, textual);
  // Text views drop NUL (PostgreSQL text refuses it), so the reader gets the text without it: scan that too. Bytes that are
  // UTF-16 are scanned as UTF-16 instead.
  if (wide.length === 0 && bytes.includes(0)) {
    const stripped = withoutZeroBytes(bytes);
    const strippedUtf8 = tryDecode('utf-8', stripped);
    const strippedGb =
      strippedUtf8 === null && textual ? tryDecode('gb18030', stripped) : null;
    views.push(
      ...byteViews(stripped, strippedUtf8, strippedGb, textual).map((view) =>
        unstripped(bytes, view),
      ),
    );
  }
  for (const encoding of wide)
    views.push(scaledView(new TextDecoder(encoding).decode(bytes), 2));
  return { views, inspected: textual && !isContainer(bytes) };
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (
    let index = text.indexOf('\n');
    index >= 0;
    index = text.indexOf('\n', index + 1)
  )
    starts.push(index + 1);
  return starts;
}

function lineOf(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= index) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The hit's line (from at most CONTEXT_BEFORE characters before it) and the next line; for a key, the material after it. */
function contextOf(at: Located | undefined, detector: string): string {
  if (at === undefined) return '';
  const { text, index } = at;
  const from = Math.max(0, index - CONTEXT_BEFORE);
  const lineStart = from + text.slice(from, index).lastIndexOf('\n') + 1;
  if (detector === 'private_key')
    return text.slice(lineStart, index + KEY_CONTEXT_AFTER);
  const after = text.slice(index, index + CONTEXT_AFTER);
  const lineEnd = after.indexOf('\n');
  const nextEnd = lineEnd < 0 ? -1 : after.indexOf('\n', lineEnd + 1);
  return text.slice(lineStart, index + (nextEnd < 0 ? after.length : nextEnd));
}

function scanBytes(
  bytes: Uint8Array,
  located: boolean,
  limit = MAX_FINDINGS,
): {
  scan: CredentialScan;
  contexts: string[];
  matches: string[];
  complete: boolean;
} {
  const { views, inspected } = decode(bytes);
  const found = new Map<
    string,
    { finding: CredentialFinding; at?: Located; matches: Set<string> }
  >();
  let complete = true;
  for (const view of views) {
    const hits = scanText(view.text, 0, located, limit);
    if (hits.length > limit || hits.some((hit) => hit.incomplete))
      complete = false;
    if (hits.length === 0) continue;
    hits.sort(
      (a, b) =>
        a.index - b.index ||
        CREDENTIAL_DETECTORS.indexOf(a.detector) -
          CREDENTIAL_DETECTORS.indexOf(b.detector),
    );
    const indices = [...new Set(hits.map((hit) => hit.index))];
    const offsets = new Map<number, number>();
    view
      .offsets(indices)
      .forEach((offset, position) => offsets.set(indices[position]!, offset));
    const starts = lineStartsOf(view.text);
    for (const hit of hits) {
      const offset = offsets.get(hit.index) ?? 0;
      const key = `${hit.detector}:${offset}`;
      if (found.has(key)) {
        if (hit.matched !== undefined) found.get(key)!.matches.add(hit.matched);
        for (const value of hit.additional ?? [])
          found.get(key)!.matches.add(value);
        continue;
      }
      const line = lineOf(starts, hit.index);
      found.set(key, {
        finding: {
          detector: hit.detector,
          offset,
          line: line + 1,
          column: hit.index - starts[line]! + 1,
        },
        at: hit.at,
        matches: new Set([
          ...(hit.matched === undefined ? [] : [hit.matched]),
          ...(hit.additional ?? []),
        ]),
      });
    }
  }
  const all = [...found.values()].sort(
    (a, b) =>
      a.finding.offset - b.finding.offset ||
      CREDENTIAL_DETECTORS.indexOf(a.finding.detector as CredentialDetector) -
        CREDENTIAL_DETECTORS.indexOf(b.finding.detector as CredentialDetector),
  );
  const kept = all.slice(0, limit);
  const findings = kept.map((entry) => entry.finding);
  const scan = {
    scanner: CREDENTIAL_SCANNER,
    inspected,
    clean: inspected && findings.length === 0,
    findings,
    truncated: all.length > findings.length,
  };
  return {
    scan,
    contexts: located
      ? kept.map((entry) => contextOf(entry.at, entry.finding.detector))
      : [],
    matches: kept.flatMap((entry) => [...entry.matches]),
    complete,
  };
}

/**
 * Scans bytes and reports where credentials appear. `inspected` is false when the bytes are not text (a compressed or
 * image container, or binary): nothing could be examined, so `clean` is false too, while `findings` still lists any hit.
 */
export function scanForCredentials(bytes: Uint8Array): CredentialScan {
  return scanBytes(bytes, false).scan;
}

/**
 * The same scan, plus for each kept finding the text around it in the decoded (and unescaped) form it was found in: its
 * line and the next one, or the key material after a key header. Package-internal: the contexts hold the matched text,
 * so they serve only to check that an admin's note does not copy it, and are never stored, logged or returned.
 */
export function scanWithContexts(bytes: Uint8Array): {
  scan: CredentialScan;
  contexts: string[];
} {
  const { scan, contexts } = scanBytes(bytes, true);
  return { scan, contexts };
}

/** Exact decoded matches for coverage only. Package-internal: never return, log, store or hash them. */
export function scanWithMatches(bytes: Uint8Array): {
  scan: CredentialScan;
  matches: string[];
  complete: boolean;
} {
  const { scan, matches, complete } = scanBytes(bytes, true);
  return { scan, matches, complete };
}
