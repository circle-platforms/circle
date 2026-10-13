// The proxy and the certificate authorities for the requests Circle makes itself: the model,
// model lists, models.dev, webfetch, websearch, the update check, `circle update`'s release
// lookup and MCP servers reached by URL. All of them use fetch (the model SDKs too), so one
// setting at start covers them. As in the Python releases, HTTPS_PROXY, HTTP_PROXY and
// NO_PROXY choose the proxy, and SSL_CERT_FILE and SSL_CERT_DIR name certificate authorities
// to trust. Those are added to the ones Node.js trusts already (its own list and
// NODE_EXTRA_CA_CERTS); they do not replace them. trust_cert_files in settings names the
// same kind of files without an environment variable; the commands and tools the session
// starts get the whole set through a merged bundle, because outside Node.js SSL_CERT_FILE
// replaces the store instead of adding to it.
import http from 'node:http';
import tls from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface NetworkSetup {
  // Certificate authorities added from SSL_CERT_FILE, SSL_CERT_DIR and trust_cert_files
  certificates: number;
  proxy: boolean;
  // What could not be used, one line each
  problems: string[];
  // Puts back what was there before (tests)
  restore(): void;
}

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function pemCertificates(path: string): string[] {
  const text = readFileSync(path, 'latin1');
  return (text.match(PEM) ?? []).filter((pem) => {
    try {
      new X509Certificate(pem);
      return true;
    } catch {
      return false;
    }
  });
}

// SSL_CERT_FILE: one PEM bundle. SSL_CERT_DIR: folders (separated as in PATH) of PEM files,
// as OpenSSL reads them; every file in them is read, hashed names or not. `files` are the
// trust_cert_files paths: one PEM bundle each, `~/` taken as your home folder.
export function extraCertificates(
  env: NodeJS.ProcessEnv = process.env,
  files: string[] = [],
): {
  certificates: string[];
  problems: string[];
} {
  const certificates: string[] = [];
  const problems: string[] = [];
  const file = env.SSL_CERT_FILE?.trim();
  if (file) {
    try {
      const found = pemCertificates(file);
      if (found.length) certificates.push(...found);
      else problems.push(`SSL_CERT_FILE has no PEM certificate: ${file}`);
    } catch (error) {
      problems.push(`SSL_CERT_FILE cannot be read: ${reason(error)}`);
    }
  }
  for (const folder of (env.SSL_CERT_DIR ?? '').split(delimiter)) {
    if (!folder.trim()) continue;
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch (error) {
      problems.push(`SSL_CERT_DIR cannot be read: ${reason(error)}`);
      continue;
    }
    const before = certificates.length;
    for (const name of names.sort()) {
      const path = join(folder, name);
      try {
        if (statSync(path).isFile())
          certificates.push(...pemCertificates(path));
      } catch {
        // A broken link or an unreadable file in a certificate folder is skipped, as OpenSSL does.
      }
    }
    if (certificates.length === before)
      problems.push(`SSL_CERT_DIR has no PEM certificate: ${folder}`);
  }
  for (const raw of files) {
    const path = expandHome(raw);
    try {
      const found = pemCertificates(path);
      if (found.length) certificates.push(...found);
      else problems.push(`trust_cert_files has no PEM certificate: ${path}`);
    } catch (error) {
      problems.push(
        `trust_cert_files cannot be read: ${path}: ${reason(error)}`,
      );
    }
  }
  return { certificates: [...new Set(certificates)], problems };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const expandHome = (path: string): string =>
  path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

const PROXY_VARIABLES = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
];

// Called once at start, before the first request. Never throws: a setting that cannot be used
// is returned in `problems` for the caller to show. (tls.setDefaultCACertificates is in
// Node.js 24.5 and later, http.setGlobalProxyFromEnv in 24.14 and later; releases ship 24.21.)
export function configureNetwork(
  env: NodeJS.ProcessEnv = process.env,
  files: string[] = [],
): NetworkSetup {
  const undo: (() => void)[] = [];
  const { certificates, problems } = extraCertificates(env, files);
  let added = 0;
  if (certificates.length) {
    if (typeof tls.setDefaultCACertificates !== 'function')
      problems.push(
        `Node.js ${process.version} cannot add SSL_CERT_FILE or SSL_CERT_DIR; use NODE_EXTRA_CA_CERTS or Node.js 24.5 or later`,
      );
    else {
      const previous = tls.getCACertificates('default');
      try {
        tls.setDefaultCACertificates([...previous, ...certificates]);
        undo.push(() => tls.setDefaultCACertificates(previous));
        added = certificates.length;
      } catch (error) {
        problems.push(`certificates could not be added: ${reason(error)}`);
      }
    }
  }
  let proxy = false;
  if (PROXY_VARIABLES.some((name) => env[name]?.trim())) {
    if (typeof http.setGlobalProxyFromEnv === 'function')
      try {
        undo.push(http.setGlobalProxyFromEnv(env));
        proxy = true;
      } catch (error) {
        problems.push(`the proxy setting cannot be used: ${reason(error)}`);
      }
    else if (env.NODE_USE_ENV_PROXY === '1') proxy = true;
    else
      problems.push(
        `Node.js ${process.version} cannot use HTTPS_PROXY or HTTP_PROXY; use Node.js 24.14 or later`,
      );
  }
  return {
    certificates: added,
    proxy,
    problems,
    restore: () => {
      for (const step of [...undo].reverse()) step();
    },
  };
}

// A failed certificate check, anywhere in an error's chain of causes (fetch wraps it).
export function isCertificateError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      /CERT|SELF_SIGNED|UNABLE_TO_(VERIFY|GET_ISSUER)/.test(code)
    )
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export const TLS_HINT =
  'the TLS certificate could not be verified; if your network inspects HTTPS, set SSL_CERT_FILE to its CA bundle';

export interface ToolTrust {
  bundle: string;
  authorities: number;
}
let toolTrust: ToolTrust | undefined;

// Commands, extensions and the tools they start read trust from SSL_CERT_FILE, where it
// replaces the store instead of adding to it. When anything beyond the system authorities
// is in force, Circle writes one bundle of all of them under the data folder and points
// SSL_CERT_FILE at it, so a child inherits the whole set and no user has to merge files
// by hand or remember an environment variable. With nothing configured, the environment
// is left exactly as it is.
export function toolTrustBundle(
  env: NodeJS.ProcessEnv = process.env,
  files: string[] = [],
  home: string,
): ToolTrust | undefined {
  if (!files.length && !env.SSL_CERT_FILE?.trim() && !env.SSL_CERT_DIR?.trim())
    return undefined;
  const { certificates } = extraCertificates(env, files);
  // One certificate can arrive as two strings (Node's store and a parsed file differ in
  // line endings); dedupe by fingerprint, so the bundle and its count hold each once.
  const byFingerprint = new Map<string, string>();
  for (const pem of [...tls.getCACertificates('default'), ...certificates]) {
    try {
      byFingerprint.set(new X509Certificate(pem).fingerprint, pem);
    } catch {
      byFingerprint.set(pem, pem);
    }
  }
  const pems = [...byFingerprint.values()];
  const sha = createHash('sha256')
    .update(pems.join('\n'))
    .digest('hex')
    .slice(0, 16);
  const folder = join(home, 'trust');
  const path = join(folder, `bundle-${sha}.pem`);
  if (!existsSync(path)) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, pems.join('\n') + '\n', { mode: 0o600 });
    renameSync(temp, path);
  }
  env.SSL_CERT_FILE = path;
  toolTrust = { bundle: path, authorities: pems.length };
  return toolTrust;
}

// The bundle this run passed to children, if any (the interface shows it; TLS errors quote it).
export const currentToolTrust = (): ToolTrust | undefined => toolTrust;

// The hint shown when a certificate check failed: with a managed bundle it says what is
// in force, so a forgotten setting and a missing authority are told apart at a glance.
export const certificateHint = (): string =>
  toolTrust
    ? `the TLS certificate could not be verified; Circle passes ${toolTrust.authorities} authorities to its requests and to the tools it starts (bundle ${toolTrust.bundle}); if this host's certificate authority is not among them, add its PEM file to trust_cert_files in settings.json`
    : TLS_HINT;
