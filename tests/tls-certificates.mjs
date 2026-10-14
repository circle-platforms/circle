// Synthetic test certificates must not inherit an installed OpenSSL configuration.
// Combining its v3_ca defaults with req -addext can emit duplicate constraints.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function tlsCertificates(folder, host, env = process.env) {
  assert.match(host, /^[a-zA-Z0-9.-]+$/);
  const config = (name, subject, extensions) =>
    writeFileSync(
      join(folder, name),
      [
        '[req]',
        'distinguished_name=dn',
        'prompt=no',
        'default_md=sha256',
        '[dn]',
        `CN=${subject}`,
        '[ext]',
        ...extensions,
        '',
      ].join('\n'),
    );
  config('ca.cnf', `${host} test CA ${randomUUID().slice(0, 8)}`, [
    'basicConstraints=critical,CA:TRUE',
    'keyUsage=critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid:always',
  ]);
  config('leaf.cnf', host, [
    `subjectAltName=DNS:${host},IP:127.0.0.1`,
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid:always',
  ]);
  const run = (args) => {
    const result = spawnSync('openssl', args, {
      cwd: folder,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(
      result.status,
      0,
      `${result.error ?? ''}\n${result.stdout}${result.stderr}`,
    );
    return result.stdout;
  };
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '2',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-config',
    'ca.cnf',
    '-extensions',
    'ext',
  ]);
  run([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-keyout',
    'key.pem',
    '-out',
    'leaf.csr',
    '-config',
    'leaf.cnf',
  ]);
  run([
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-set_serial',
    '2',
    '-sha256',
    '-days',
    '2',
    '-out',
    'leaf.pem',
    '-extfile',
    'leaf.cnf',
    '-extensions',
    'ext',
  ]);
  run(['verify', '-check_ss_sig', '-CAfile', 'ca.pem', 'ca.pem']);
  run(['verify', '-purpose', 'sslserver', '-CAfile', 'ca.pem', 'leaf.pem']);
  for (const name of ['ca.pem', 'leaf.pem']) {
    const text = run(['x509', '-in', name, '-noout', '-text']);
    assert.equal((text.match(/X509v3 Basic Constraints:/g) ?? []).length, 1);
    assert.match(text, /X509v3 Basic Constraints: critical/);
    assert.match(text, /X509v3 Key Usage: critical/);
    assert.match(text, /X509v3 Subject Key Identifier:/);
    assert.match(text, /X509v3 Authority Key Identifier:/);
    assert.match(text, /Signature Algorithm: sha256WithRSAEncryption/);
  }
  const cert = readFileSync(join(folder, 'leaf.pem'));
  const ca = new X509Certificate(readFileSync(join(folder, 'ca.pem')));
  const leaf = new X509Certificate(cert);
  assert.equal(ca.ca, true);
  assert.equal(ca.subject, ca.issuer);
  assert.equal(ca.verify(ca.publicKey), true);
  assert.equal(leaf.ca, false);
  assert.equal(leaf.checkIssued(ca), true);
  assert.equal(leaf.verify(ca.publicKey), true);
  assert.equal(leaf.checkHost(host), host);
  assert.equal(leaf.checkIP('127.0.0.1'), '127.0.0.1');
  for (const certificate of [ca, leaf]) {
    assert.ok(Date.parse(certificate.validFrom) <= Date.now());
    assert.ok(Date.parse(certificate.validTo) > Date.now());
  }
  return {
    ca: join(folder, 'ca.pem'),
    key: readFileSync(join(folder, 'key.pem')),
    cert,
  };
}
