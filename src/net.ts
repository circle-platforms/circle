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

// Keep the feature checks valid with the older Node 24 declarations the renderer
// package uses; packaged applications run a recent Node 24 runtime.
const nodeTls = tls as typeof tls & {
  setDefaultCACertificates?: (certificates: readonly string[]) => void;
};
const nodeHttp = http as typeof http & {
  setGlobalProxyFromEnv?: (env: NodeJS.ProcessEnv) => () => void;
};

export interface NetworkSetup {
  // Certificate authorities added from SSL_CERT_FILE, SSL_CERT_DIR and trust_cert_files
  certificates: number;
  proxy: boolean;
  // What could not be used, one line each
  problems: string[];
  // Puts back what was there before (tests)
  restore(): void;
}

export interface NetworkStatus {
  proxy: boolean;
  certificates: number;
  authorities: number;
  sources: { name: string; certificates: number; path?: string }[];
  problems: string[];
  bundle?: string;
}
let status: NetworkStatus = {
  proxy: false,
  certificates: 0,
  authorities: tls.getCACertificates('default').length,
  sources: [
    { name: 'default', certificates: tls.getCACertificates('default').length },
  ],
  problems: [],
};
export const currentNetworkStatus = (): NetworkStatus =>
  structuredClone(status);
export function networkSummary(value = currentNetworkStatus()): string {
  const sources = value.sources
    .map(
      (source) =>
        `${source.name}${source.path ? ` (${source.path})` : ''}: ${source.certificates}`,
    )
    .join(', ');
  return `network: proxy ${value.proxy ? 'on' : 'off'}; trust ${value.authorities} authorities (${sources})${value.bundle ? `; bundle ${value.bundle}` : ''}${value.problems.length ? `; ${value.problems.join('; ')}` : ''}`;
}
export function networkProblem(problem: string): void {
  status.problems.push(safeNetworkText(problem));
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
  sources: NetworkStatus['sources'];
} {
  const certificates: string[] = [];
  const problems: string[] = [];
  const sources: NetworkStatus['sources'] = [];
  const file = env.SSL_CERT_FILE?.trim();
  if (file) {
    try {
      const found = pemCertificates(file);
      sources.push({
        name: 'SSL_CERT_FILE',
        path: file,
        certificates: found.length,
      });
      if (found.length) certificates.push(...found);
      else problems.push(`SSL_CERT_FILE has no PEM certificate: ${file}`);
    } catch (error) {
      sources.push({ name: 'SSL_CERT_FILE', path: file, certificates: 0 });
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
    sources.push({
      name: 'SSL_CERT_DIR',
      path: folder,
      certificates: certificates.length - before,
    });
  }
  const settingsCertificates: string[] = [];
  for (const raw of files) {
    const path = expandHome(raw);
    try {
      const found = pemCertificates(path);
      settingsCertificates.push(...found);
      if (found.length) certificates.push(...found);
      else problems.push(`trust_cert_files has no PEM certificate: ${path}`);
    } catch (error) {
      problems.push(
        `trust_cert_files cannot be read: ${path}: ${reason(error)}`,
      );
    }
  }
  if (files.length)
    sources.push({
      name: 'trust_cert_files',
      certificates: new Set(settingsCertificates).size,
    });
  for (const raw of (env.CIRCLE_TRUST_CERTS ?? '')
    .split(delimiter)
    .map((path) => path.trim())
    .filter(Boolean)) {
    const path = expandHome(raw);
    try {
      const found = pemCertificates(path);
      sources.push({
        name: 'CIRCLE_TRUST_CERTS',
        path,
        certificates: found.length,
      });
      certificates.push(...found);
      if (!found.length)
        problems.push(`CIRCLE_TRUST_CERTS has no PEM certificate: ${path}`);
    } catch (error) {
      sources.push({ name: 'CIRCLE_TRUST_CERTS', path, certificates: 0 });
      problems.push(
        `CIRCLE_TRUST_CERTS cannot be read: ${path}: ${reason(error)}`,
      );
    }
  }
  return { certificates: [...new Set(certificates)], problems, sources };
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
  const previousStatus = currentNetworkStatus();
  const { certificates, problems, sources } = extraCertificates(env, files);
  const defaultAuthorities = tls.getCACertificates('default').length;
  let added = 0;
  if (certificates.length) {
    if (typeof nodeTls.setDefaultCACertificates !== 'function')
      problems.push(
        `Node.js ${process.version} cannot add SSL_CERT_FILE or SSL_CERT_DIR; use NODE_EXTRA_CA_CERTS or Node.js 24.5 or later`,
      );
    else {
      const previous = tls.getCACertificates('default');
      try {
        nodeTls.setDefaultCACertificates([...previous, ...certificates]);
        undo.push(() => nodeTls.setDefaultCACertificates!(previous));
        added = certificates.length;
      } catch (error) {
        problems.push(`certificates could not be added: ${reason(error)}`);
      }
    }
  }
  let proxy = false;
  if (PROXY_VARIABLES.some((name) => env[name]?.trim())) {
    if (typeof nodeHttp.setGlobalProxyFromEnv === 'function')
      try {
        undo.push(nodeHttp.setGlobalProxyFromEnv(env));
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
  status = {
    proxy,
    certificates: added,
    authorities: new Set(
      tls
        .getCACertificates('default')
        .map((pem) => new X509Certificate(pem).fingerprint256),
    ).size,
    sources: [
      { name: 'default', certificates: defaultAuthorities },
      ...sources,
    ],
    problems: problems.map(safeNetworkText),
  };
  if (env.NODE_EXTRA_CA_CERTS?.trim())
    status.sources.push({
      name: 'NODE_EXTRA_CA_CERTS',
      path: env.NODE_EXTRA_CA_CERTS,
      certificates: tls.getCACertificates('extra').length,
    });
  return {
    certificates: added,
    proxy,
    problems,
    restore: () => {
      for (const step of [...undo].reverse()) step();
      status = previousStatus;
    },
  };
}

// A failed certificate check, anywhere in an error's chain of causes (fetch wraps it).
export function isCertificateError(error: unknown): boolean {
  return errorChain(error).some((value) =>
    /CERT|SELF_SIGNED|UNABLE_TO_(VERIFY|GET_ISSUER)/.test(value.code ?? ''),
  );
}

export const TLS_HINT =
  'the TLS certificate could not be verified; if your network inspects HTTPS, set SSL_CERT_FILE to its CA bundle';

function errorChain(
  error: unknown,
): { message?: string; code?: string; name?: string; status?: number }[] {
  const found: {
    message?: string;
    code?: string;
    name?: string;
    status?: number;
  }[] = [];
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length && found.length < 12) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const value = current as Error & {
      code?: string;
      status?: number;
      errors?: unknown[];
    };
    found.push(value);
    pending.push(
      value.cause,
      ...(Array.isArray(value.errors) ? value.errors : []),
    );
  }
  return found;
}
// Network diagnostics retain the host and cause, never proxy credentials, URL queries,
// authorization headers or a search query echoed by a failed request.
export function safeNetworkText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s'"<>)]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}`;
      } catch {
        return '[URL]';
      }
    })
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '[credentials]')
    .replace(
      /\b(?:api[_-]?key|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
      '[credentials]',
    );
}
export function isNetworkFailure(error: unknown): boolean {
  return errorChain(error).some(
    (value) =>
      /^(?:EAI_AGAIN|ENOTFOUND|ECONN\w+|EHOST\w+|ENET\w+|EPIPE|ETIMEDOUT|ERR_TLS\w*|ERR_SSL\w*|UND_ERR_\w+|.*CERT.*|.*SELF_SIGNED.*|UNABLE_TO_.*)$/.test(
        value.code ?? '',
      ) ||
      /(?:APIConnection|Timeout|Abort)Error/.test(value.name ?? '') ||
      /fetch failed|connection error/i.test(value.message ?? '') ||
      value.status === 407,
  );
}

export function networkErrorReason(error: unknown): string {
  return (
    [
      ...new Set(
        errorChain(error)
          .map((value) =>
            safeNetworkText(
              [value.code, value.message].filter(Boolean).join(': '),
            ),
          )
          .filter(Boolean),
      ),
    ].join('; ') || safeNetworkText(String(error))
  );
}

/** Describe the endpoint and retain the complete original cause for callers. */
export function networkError(error: unknown, host: string): Error {
  const chain = errorChain(error);
  let target = host;
  try {
    target = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`)
      .host;
  } catch {
    target = host.replace(/[^a-zA-Z0-9.:[\]-]/g, '');
  }
  const codes = chain.map((value) => value.code ?? '').join(' ');
  const messages = chain.map((value) => value.message ?? '').join(' ');
  const tlsFailure = isCertificateError(error) || /ERR_TLS|ERR_SSL/.test(codes);
  const kind = tlsFailure
    ? 'TLS'
    : /ENOTFOUND|EAI_AGAIN/.test(codes)
      ? 'DNS'
      : /PROXY|PRX|407/.test(codes + ' ' + messages) ||
          chain.some((value) => value.status === 407)
        ? 'proxy'
        : /TIMEDOUT|TIMEOUT/.test(codes) ||
            chain.some((value) => /TimeoutError/.test(value.name ?? ''))
          ? 'timeout'
          : /\bHTTP \d{3}\b/.test(messages) ||
              chain.some((value) => typeof value.status === 'number')
            ? 'HTTP'
            : /empty body/i.test(messages)
              ? 'empty response'
              : 'connection';
  const result = new Error(
    `${kind} failure on ${target}: ${networkErrorReason(error)}${tlsFailure ? `; ${certificateHint()}; ${networkSummary()}` : ''}`,
    { cause: error },
  );
  const specific = chain.find((value) => value.code);
  if (specific?.code) Object.assign(result, { code: specific.code });
  const statusCode = chain.find(
    (value) => typeof value.status === 'number',
  )?.status;
  if (statusCode !== undefined) Object.assign(result, { status: statusCode });
  return result;
}

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
  if (
    !files.length &&
    !env.SSL_CERT_FILE?.trim() &&
    !env.SSL_CERT_DIR?.trim() &&
    !env.NODE_EXTRA_CA_CERTS?.trim() &&
    !env.CIRCLE_TRUST_CERTS?.trim()
  )
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
  // Node only reads this at process start: a newly started Node tool must inherit the
  // same authorities, even when it does not import Circle's network bootstrap.
  env.NODE_EXTRA_CA_CERTS = path;
  toolTrust = { bundle: path, authorities: pems.length };
  status.bundle = path;
  status.authorities = pems.length;
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
