// trust_cert_files: authorities named in settings are added to what Circle trusts, and the
// commands and tools Circle starts get a merged bundle through SSL_CERT_FILE so they do not
// lose the system store. Scratch homes only; the real ~/.circle is never read.
import { scratch } from './helpers.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { join } from 'node:path';
import tls from 'node:tls';
import { test, type TestContext } from 'node:test';
import {
  certificateHint,
  configureNetwork,
  extraCertificates,
  isCertificateError,
  TLS_HINT,
  toolTrustBundle,
} from '../src/net.js';
import { shellEnvironment } from '../src/sandbox.js';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
} from '../src/settings.js';

const OPENSSL = spawnSync('openssl', ['version'], { encoding: 'utf8' });
const NO_OPENSSL =
  OPENSSL.status === 0 ? false : 'openssl is not on PATH to make a test CA';

// A CA of its own plus a leaf it signed for 127.0.0.1, as network.test.ts does.
function certificates(t: TestContext): {
  ca: string;
  key: string;
  cert: string;
} {
  const dir = scratch(t, 'circle-trust-ca-');
  const config = (name: string, lines: string[]): void =>
    writeFileSync(
      join(dir, name),
      ['[req]', 'distinguished_name = dn', 'prompt = no', ...lines, ''].join(
        '\n',
      ),
    );
  config('ca.cnf', [
    '[dn]',
    'CN = Circle Trust Test CA',
    '[ext]',
    'basicConstraints = critical,CA:TRUE',
    'keyUsage = critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier = hash',
  ]);
  config('leaf.cnf', [
    '[dn]',
    'CN = circle-lab.test',
    '[ext]',
    'subjectAltName = DNS:circle-lab.test,IP:127.0.0.1',
    'basicConstraints = CA:FALSE',
    'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth',
  ]);
  const run = (command: string): void => {
    const result = spawnSync('openssl', command.split(' '), {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  run(
    'req -x509 -newkey rsa:2048 -nodes -days 2 -keyout ca.key -out ca.pem -config ca.cnf -extensions ext',
  );
  run(
    'req -new -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -config leaf.cnf',
  );
  run(
    'x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -set_serial 2 -days 2 -out leaf.pem -extfile leaf.cnf -extensions ext',
  );
  return {
    ca: join(dir, 'ca.pem'),
    key: readFileSync(join(dir, 'leaf.key'), 'utf8'),
    cert: readFileSync(join(dir, 'leaf.pem'), 'utf8'),
  };
}

const countPem = (text: string): number =>
  (text.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;

test('settings keep trust_cert_files', async (t) => {
  const home = scratch(t, 'circle-trust-home-');
  const file = join(home, 'lab.pem');
  saveSettings(
    {
      ...defaultSettings(),
      trust_cert_files: [file, '', '   ', 7 as unknown as string],
    },
    home,
  );
  const back = loadSettings(home);
  assert.deepEqual(
    back.trust_cert_files,
    [file],
    'blank and non-string entries drop',
  );
});

test(
  'extraCertificates reads trust_cert_files, dedupes, and reports',
  { skip: NO_OPENSSL },
  async (t) => {
    const { ca } = certificates(t);
    const twice = extraCertificates({}, [ca, ca]);
    assert.equal(
      twice.certificates.length,
      1,
      'the same file twice is one authority',
    );
    assert.deepEqual(twice.problems, []);
    const missing = extraCertificates({}, [
      join(scratch(t, 'circle-trust-none-'), 'no-such-ca.pem'),
    ]);
    assert.equal(missing.certificates.length, 0);
    assert.match(
      missing.problems.join('\n'),
      /trust_cert_files cannot be read/,
    );
    const plain = join(scratch(t, 'circle-trust-plain-'), 'not-a-ca.pem');
    writeFileSync(plain, 'hello\n');
    const bad = extraCertificates({}, [plain]);
    assert.match(
      bad.problems.join('\n'),
      /trust_cert_files has no PEM certificate/,
    );
  },
);

test(
  'configureNetwork adds settings files without replacing the system store',
  { skip: NO_OPENSSL },
  async (t) => {
    const { ca } = certificates(t);
    const before = tls.getCACertificates('default').length;
    const setup = configureNetwork({}, [ca]);
    assert.equal(setup.certificates, 1);
    assert.equal(tls.getCACertificates('default').length, before + 1);
    setup.restore();
    assert.equal(tls.getCACertificates('default').length, before);
  },
);

test(
  'toolTrustBundle merges everything into a file and points SSL_CERT_FILE at it',
  { skip: NO_OPENSSL },
  async (t) => {
    const { ca } = certificates(t);
    const home = scratch(t, 'circle-trust-home-');
    // Nothing configured: the environment is left exactly as it is.
    const clean: NodeJS.ProcessEnv = {};
    assert.equal(toolTrustBundle(clean, [], home), undefined);
    assert.equal(clean.SSL_CERT_FILE, undefined);
    // Settings files: system + lab, written into the data folder.
    const env: NodeJS.ProcessEnv = {};
    const tool = toolTrustBundle(env, [ca], home);
    assert.ok(tool);
    assert.equal(env.SSL_CERT_FILE, tool.bundle);
    assert.ok(
      tool.bundle.startsWith(join(home, 'trust')),
      'under the data folder',
    );
    const bundle = readFileSync(tool.bundle, 'utf8');
    assert.ok(bundle.includes('-----BEGIN CERTIFICATE-----'));
    assert.equal(tool.authorities, tls.getCACertificates('default').length + 1);
    assert.ok(
      bundle.includes(
        readFileSync(ca, 'utf8').match(
          /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
        )![0],
      ),
      'the lab CA is in it',
    );
    // The same inputs give the same file, not a second one.
    const again = toolTrustBundle({}, [ca], home);
    assert.equal(again!.bundle, tool.bundle);
    assert.equal(readdirSync(join(home, 'trust')).length, 1);
    // A bundle the user set by hand is kept, not dropped: it joins the merged file.
    const inherited: NodeJS.ProcessEnv = { SSL_CERT_FILE: ca };
    const merged = toolTrustBundle(inherited, [], home);
    assert.ok(merged);
    assert.ok(merged!.bundle !== ca, 'SSL_CERT_FILE now points at the merge');
    assert.equal(
      countPem(readFileSync(merged!.bundle, 'utf8')),
      tls.getCACertificates('default').length + 1,
      'the hand-set file joins the merge',
    );
  },
);

test('the bundle name follows its content', { skip: NO_OPENSSL }, async (t) => {
  const { ca } = certificates(t);
  const second = certificates(t).ca;
  const home = scratch(t, 'circle-trust-home-');
  const first = toolTrustBundle({}, [ca], home)!;
  assert.match(first.bundle, /bundle-[0-9a-f]{16}\.pem$/);
  // Other content: a new name, not an overwrite of the old file.
  const other = toolTrustBundle({}, [second], home)!;
  assert.notEqual(other.bundle, first.bundle);
  assert.ok(existsSync(first.bundle), 'the old bundle stays for other runs');
});

test('SSL_CERT_FILE is not a secret and survives the environment filter', () => {
  const kept = shellEnvironment({
    SSL_CERT_FILE: '/tmp/bundle.pem',
    SOME_API_KEY: 'secret',
    PATH: '/usr/bin',
  } as NodeJS.ProcessEnv);
  assert.equal(kept.SSL_CERT_FILE, '/tmp/bundle.pem');
  assert.equal(kept.SOME_API_KEY, undefined);
});

test(
  'a lab HTTPS server answers only once the files are configured',
  { skip: NO_OPENSSL },
  async (t) => {
    const { ca, key, cert } = certificates(t);
    const server: Server = createHttpsServer({ key, cert }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>((done) => server.close(() => done()));
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `https://127.0.0.1:${address.port}/`;
    // Before: refused, as a lab CA is not in the system store. A flag, not assert.fail
    // inside the try: this catch must only judge fetch errors, not my own assertion.
    let answeredEarly = false;
    try {
      await fetch(url);
      answeredEarly = true;
    } catch (error) {
      assert.ok(
        isCertificateError(error),
        'a certificate error, not something else',
      );
    }
    assert.ok(!answeredEarly, 'the test CA must not be trusted yet');
    // The CLI's own start sequence, on a private environment object.
    const env: NodeJS.ProcessEnv = {};
    const setup = configureNetwork(env, [ca]);
    const tool = toolTrustBundle(env, [ca], scratch(t, 'circle-trust-home-'));
    assert.ok(tool);
    try {
      const answer = await fetch(url);
      assert.equal(answer.status, 200);
      // A child process told to use this environment sees the same whole bundle.
      const child = spawnSync(
        process.execPath,
        ['-e', 'console.log(process.env.SSL_CERT_FILE)'],
        { env: { ...shellEnvironment(process.env), ...env } },
      );
      assert.equal(child.stdout.toString().trim(), tool!.bundle);
      // And the hint now names what is in force.
      assert.match(
        certificateHint(),
        new RegExp(
          String(tool!.bundle).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'),
        ),
      );
      assert.match(certificateHint(), /trust_cert_files/);
      assert.match(TLS_HINT, /set SSL_CERT_FILE/);
    } finally {
      setup.restore();
    }
    // Refusal again after restore is checked in the configureNetwork test: a second
    // fetch to this origin would reuse the pooled keep-alive socket, not re-handshake.
  },
);
