// Adapted from pinned Circle Hub (Apache-2.0).
// Credential scan positives and negatives. Every credential-shaped value is synthetic and assembled at run time, so the
// source file itself holds nothing a secret scanner would flag.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  CREDENTIAL_DETECTORS,
  CREDENTIAL_SCANNER,
  scanForCredentials,
  scanWithContexts,
} from '../src/knowledge/portable/scan.js';

const BS = String.fromCharCode(0x5c);
const dashes = '-'.repeat(5);
const pemHeader = (label: string) => `${dashes}BEGIN ${label}${dashes}`;
const pemFooter = (label: string) => `${dashes}END ${label}${dashes}`;
const base64Lines = (bytes: number) =>
  (
    randomBytes(bytes)
      .toString('base64')
      .match(/.{1,64}/g) ?? []
  ).join('\n');
const alnum = (length: number) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(
    randomBytes(length),
    (byte) => chars[byte % chars.length]!,
  ).join('');
};
const upperDigits = (length: number) =>
  Array.from(
    randomBytes(length),
    (byte) => 'ABCDEFGHJKLMNPQRSTUVWXYZ234567'[byte % 30]!,
  ).join('');
const b64url = (value: string) =>
  Buffer.from(value, 'utf8').toString('base64url');
const jwt = () =>
  `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"synthetic-user","iat":1700000000}')}.${randomBytes(32).toString('base64url')}`;
const token = () => `${randomBytes(30).toString('base64url')}9a`;

function detectors(text: string | Uint8Array): string[] {
  const scan = scanForCredentials(
    typeof text === 'string' ? Buffer.from(text, 'utf8') : text,
  );
  assert.equal(scan.scanner, CREDENTIAL_SCANNER);
  // Clean means inspected and nothing found; bytes that are not text are never clean, hits or not.
  assert.equal(scan.clean, scan.inspected && scan.findings.length === 0);
  for (const finding of scan.findings)
    assert.ok(
      (CREDENTIAL_DETECTORS as readonly string[]).includes(finding.detector),
    );
  return [...new Set(scan.findings.map((finding) => finding.detector))].sort();
}

test('encoded credential views cannot bypass scanning and findings expose original locations only', () => {
  const secret = ['Synth3tic', '!2498'].join(''),
    plain = 'DB_PASSWORD=' + secret;
  const variants = [
    plain,
    'ＤＢ＿ＰＡＳＳＷＯＲＤ＝' + secret,
    'DB_PASS\u200bWORD=' + secret,
    'DB_PASS\u00adWORD=' + secret,
    'DB_PASS\u2060WORD=' + secret,
    'DB_PASSWORD&#61;' + secret,
    'DB_PASSWORD&equals;' + secret,
    'DB_PASSWORD&#x3d;' + secret,
    Buffer.from(plain).toString('base64'),
    Buffer.from(JSON.stringify({ password: secret })).toString('base64url'),
    '/DB_PASS/WORD=/' + secret,
    '/DB_PASSWORD/' + secret,
  ];
  for (const input of variants) {
    const bytes = Buffer.from('第一行\n' + input),
      before = Buffer.from(bytes),
      scan = scanForCredentials(bytes);
    assert.ok(
      scan.findings.some((f) => f.detector === 'password_assignment'),
      input,
    );
    assert.equal(scan.findings[0]!.line, 2);
    assert.ok(
      scan.findings.every((f) => f.offset >= Buffer.byteLength('第一行\n')),
    );
    assert.ok(!JSON.stringify(scan).includes(secret));
    assert.deepEqual(bytes, before);
  }
  const nested = Buffer.from('DB_PASS&#87;ORD=' + secret).toString('base64');
  assert.ok(detectors(nested).includes('password_assignment'));
  for (const input of ['DB_PASSWORD&#61' + secret, 'password&nbsp' + secret])
    assert.ok(detectors(input).includes('password_assignment'), input);
  for (const padding of [0, 17, 31]) {
    const encoded = Buffer.from(
        JSON.stringify({ note: 'x'.repeat(padding), password: secret }),
      ).toString('base64'),
      wrapped = (encoded.match(/.{1,32}/g) ?? []).join('\n');
    assert.ok(detectors(wrapped).includes('password_assignment'));
  }
  const aws = 'AKIA' + 'Q7SYNTHETIC2498X';
  for (const input of [
    aws.replace('AKIA', 'ＡＫＩＡ'),
    Buffer.from(aws).toString('base64'),
  ])
    assert.ok(detectors(input).includes('cloud_key'));
  assert.ok(
    detectors(
      'Authorization: Bearer\u00a0synth3ticTokenValue2498abcdef',
    ).includes('bearer_credential'),
  );
  for (const input of [
    '/password/policy',
    '/password/requirements/8-minimum',
    'PWD=/home/synthetic/project',
    '<password>${DB_PASSWORD}</password>',
    Buffer.from('合成说明：没有凭据。').toString('base64'),
  ])
    assert.deepEqual(detectors(input), [], input);
});

test('positives: each kind of credential is found by its detector', () => {
  const cases: Array<[string, string, string]> = [
    [
      'private_key',
      'PEM RSA key',
      `${pemHeader('RSA PRIVATE KEY')}\n${base64Lines(128)}\n${pemFooter('RSA PRIVATE KEY')}\n`,
    ],
    [
      'private_key',
      'OpenSSH key',
      `${pemHeader('OPENSSH PRIVATE KEY')}\n${base64Lines(200)}\n${pemFooter('OPENSSH PRIVATE KEY')}`,
    ],
    [
      'private_key',
      'encrypted PEM with armor headers',
      `${pemHeader('RSA PRIVATE KEY')}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0011223344556677\n\n${base64Lines(96)}\n`,
    ],
    [
      'private_key',
      'key inside JSON with escaped newlines',
      `{"type":"service_account","private_key":"${pemHeader('PRIVATE KEY')}${BS}n${randomBytes(48).toString('base64')}${BS}n${pemFooter('PRIVATE KEY')}${BS}n"}`,
    ],
    [
      'private_key',
      'PuTTY key file',
      `PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: synthetic\nPublic-Lines: 2\nAAAA\nBBBB\nPrivate-Lines: 1\nCCCC\n`,
    ],
    [
      'bearer_credential',
      'bearer header',
      `GET /api/items HTTP/1.1\nAuthorization: Bearer ${token()}\n`,
    ],
    [
      'bearer_credential',
      'token header without a scheme',
      `curl -H "Authorization: ${token()}" http://192.0.2.10/agile/get_root_node/`,
    ],
    [
      'bearer_credential',
      'API key header',
      `X-Api-Key: ${randomBytes(20).toString('hex')}`,
    ],
    [
      'basic_credential',
      'basic header',
      `Authorization: Basic ${Buffer.from('synthetic-user:synthetic-pass-42').toString('base64')}`,
    ],
    [
      'basic_credential',
      'credentials in a URL',
      [
        'git cl',
        'one ht',
        'tps://',
        'deploy',
        ':Synth',
        '3tic-v',
        'alue@1',
        '92.0.2',
        '.20/re',
        'po.git',
      ].join(''),
    ],
    ['jwt', 'JWT', `token=${jwt()}`],
    ['password_assignment', 'environment assignment', 'DB_PASSWORD=hunter22x'],
    [
      'password_assignment',
      'YAML',
      'database:\n  user: synthetic\n  password: "Synth3tic!"\n',
    ],
    [
      'password_assignment',
      'JSON',
      [
        '{"clie',
        'nt_sec',
        'ret": ',
        '"a1b2c',
        '3d4e5f',
        '6", "c',
        'lient_',
        'id": "',
        'synthe',
        'tic"}',
      ].join(''),
    ],
    [
      'password_assignment',
      'Chinese label',
      '测试床登录\n用户名：synthetic\n密码：Admin@2026\n',
    ],
    [
      'password_assignment',
      'Python',
      ['api_ke', "y = 'a", 'bc123d', 'ef456g', "hi'"].join(''),
    ],
    [
      'password_assignment',
      'token with a credential prefix',
      ['auth_t', 'oken: ', 'tok123', '456789'].join(''),
    ],
    [
      'password_assignment',
      'URL query',
      'http://192.0.2.30/login?user=synthetic&password=hunter22x',
    ],
    [
      'cloud_key',
      'AWS access key id',
      `aws_access_key_id = AKIA${upperDigits(16)}`,
    ],
    ['cloud_key', 'GitHub token', `GITHUB_TOKEN=gh${'p'}_${alnum(36)}`],
    ['cloud_key', 'Google API key', `key=AIza${alnum(35)}`],
    ['cloud_key', 'Slack token', `xox${'b'}-123456789012-${alnum(24)}`],
    ['cloud_key', 'model provider key', `OPENAI=sk-Ab3${alnum(40)}`],
    ['cloud_key', 'Alibaba Cloud AccessKey', `LTAI5t${alnum(14)}`],
    [
      'cloud_key',
      'Azure storage connection string',
      `DefaultEndpointsProtocol=https;AccountName=synthetic;AccountKey=${randomBytes(64).toString('base64')}`,
    ],
  ];
  for (const [detector, label, text] of cases)
    assert.ok(
      detectors(text).includes(detector),
      `${label}: ${detectors(text).join(',') || 'clean'}`,
    );
});

test('negatives: ordinary prose, placeholders, templates and code references are clean', () => {
  const texts = [
    'Users sign in with a password. The password must be at least 12 characters and is never stored in plain text.',
    'Send the token in the Authorization header as a Bearer token. The bearer of this letter may collect the parcel.',
    'Basic configuration is described below. See https://example.org/docs for details.',
    'Password: must contain letters and digits. Token: rotated every 30 days. Secret: kept in the vault.',
    'Authorization: required for every route except /health.',
    '用户使用密码登录，密码长度至少 8 位，三次输错会锁定账号。',
    '密码：请向管理员索取。',
    '口令：********',
    '初始密钥：由系统自动生成，不在文档里给出。',
    '本节说明认证方式：令牌放在 Authorization 头里，有效期约 30 天。',
    'password: <your-password>',
    'password=${DB_PASSWORD}',
    'password: "{{ vault_db_password }}"',
    'password: !vault |',
    'DB_PASSWORD=changeme',
    'password: ********',
    'api_key: YOUR_API_KEY',
    "const password = await vault.getText('db.password');",
    "password = os.environ['DB_PASSWORD']",
    'password: process.env.DB_PASSWORD',
    'const login = { username, password: userPassword };',
    'password: user_password',
    'token_limit: 4096\nmax_tokens: 1000000\npassword_min_length: 12\nmax_token: 123456789',
    '{"password": null, "secret": "", "token": true}',
    '<input type="password" name="password" autocomplete="current-password">',
    'postgres://user:password@localhost:5432/db',
    ['https:', '//user', ':<pass', 'word>@', 'host.e', 'xample', '/'].join(''),
    'ssh://git@example.org/repo.git and mailto:someone@example.org',
    'AKIAIOSFODNN7EXAMPLE',
    `aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY${'EXAMPLE'}KEY`,
    `${pemHeader('PRIVATE KEY')}\n...\n${pemFooter('PRIVATE KEY')}`,
    `Paste your key here, it starts with ${pemHeader('PRIVATE KEY')} and ends with the footer.`,
    `${pemHeader('PUBLIC KEY')}\n${base64Lines(160)}\n${pemFooter('PUBLIC KEY')}`,
    `${pemHeader('CERTIFICATE')}\n${base64Lines(300)}\n${pemFooter('CERTIFICATE')}`,
    [
      'pip in',
      'stall ',
      'sk-lea',
      'rn-tut',
      'orial-',
      'for-be',
      'ginner',
      's',
    ].join(''),
    "Bearer tokens look like 'Bearer <token>'.",
    `Authorization: Basic ${Buffer.from('no colon here').toString('base64')}`,
    'account create alpha password <password> group beta',
    'Run the status command to check the build; the default timeout is 300 seconds.',
  ];
  for (const text of texts) assert.deepEqual(detectors(text), [], text);
});

test('a realistic synthetic manual and mind map export are clean', () => {
  const manual = [
    '# 配置管理',
    '',
    '## 用户与认证',
    '',
    '管理员可以创建本地用户。创建时需要指定用户名和密码，密码由大小写字母、数字和符号组成，长度 8 到 64 位。',
    '',
    '| 参数 | 说明 |',
    '| --- | --- |',
    '| user | 用户名，1 到 32 个字符 |',
    '| password | 口令，按安全策略设置 |',
    '',
    '```',
    'account create <name> password <password> group <group>',
    'account list',
    '```',
    '',
    'Token based access: the API returns a token that is valid for 30 days; send it in the Authorization header.',
  ].join('\n');
  const mindmap = JSON.stringify({
    root: {
      data: { id: 'n1', created: 1700000000000, text: '登录模块' },
      children: [
        {
          data: {
            id: 'n2',
            text: '密码错误三次后锁定账号',
            priority: 1,
            resource: ['negative'],
          },
          children: [
            { data: { id: 'n3', text: '提示账号已锁定' }, children: [] },
          ],
        },
        {
          data: {
            id: 'n4',
            text: '令牌过期后重新登录一次',
            priority: 2,
            resource: ['auth'],
          },
          children: [
            { data: { id: 'n5', text: '登录成功，返回新令牌' }, children: [] },
          ],
        },
      ],
    },
    template: 'default',
    theme: 'fresh-blue',
    version: '1.4.43',
  });
  assert.deepEqual(detectors(manual), []);
  assert.deepEqual(detectors(mindmap), []);
});

test('findings carry detector, byte offset, line and column, and never the matched text', () => {
  const secret = 'Admin@2026';
  const text = `第一行\nsecond line 密码：${secret}\n`;
  const scan = scanForCredentials(Buffer.from(text, 'utf8'));
  assert.equal(scan.findings.length, 1);
  const [finding] = scan.findings;
  const index = text.indexOf('密码');
  assert.deepEqual(finding, {
    detector: 'password_assignment',
    offset: Buffer.byteLength(text.slice(0, index)),
    line: 2,
    column: index - text.indexOf('\n'),
  });
  assert.equal(JSON.stringify(scan).includes(secret), false);
  // UTF-16 with a byte order mark, and bytes that are not UTF-8, are scanned too.
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('x password=hunter22x', 'utf16le'),
  ]);
  const wide = scanForCredentials(utf16);
  // Two bytes of byte order mark, then 'x' and ' ' at two bytes each.
  assert.deepEqual(
    wide.findings.map((f) => [f.detector, f.offset]),
    [['password_assignment', 2 + 2 * 2]],
  );
  const latin = scanForCredentials(
    Buffer.concat([
      Buffer.from([0xc3, 0x28, 0x0a]),
      Buffer.from('password=hunter22x'),
    ]),
  );
  assert.deepEqual(
    latin.findings.map((f) => [f.detector, f.offset, f.line, f.column]),
    [['password_assignment', 3, 2, 1]],
  );
});

const NUL = String.fromCharCode(0);
const hex = (bytes: number) =>
  randomBytes(bytes)
    .toString('hex')
    .replace(/^[0-9]/, 'a')
    .replace(/[a-f]$/, '7');
/** JSON as a Python exporter with ensure_ascii writes it: every non-ASCII character as a \uXXXX escape. */
const asciiJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (char) => `${BS}u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16();
/** GBK bytes of 密码：Admin@2026 (密 C3DC, 码 C2EB, ： A3BA), checked against the platform decoder below. */
const GBK_NOTE = Buffer.concat([
  Buffer.from([0xc3, 0xdc, 0xc2, 0xeb, 0xa3, 0xba]),
  Buffer.from('Admin@2026'),
]);
const mindMapNote = (note: string) =>
  JSON.stringify({
    root: {
      data: { id: 'n1', created: 1700000000000, text: '登录模块', note },
      children: [],
    },
    template: 'default',
    theme: 'fresh-blue',
    version: '1.4.43',
  });

test('credential-scan@2 finds credentials inside JSON strings, in other encodings and under other key shapes', () => {
  assert.equal(new TextDecoder('gbk').decode(GBK_NOTE), '密码：Admin@2026');
  const cases: Array<[string, string, string | Uint8Array]> = [
    [
      'password_assignment',
      'quoted value in a mind-map note',
      mindMapNote('测试床 password: "Admin@2026x"'),
    ],
    [
      'password_assignment',
      'Chinese label with a quoted value in a note',
      mindMapNote('密码："Admin@2026x"'),
    ],
    [
      'password_assignment',
      'login parameters in a note',
      mindMapNote(
        '登录参数 {"username": "synthetic", "password": "Admin@2026x"}',
      ),
    ],
    [
      'password_assignment',
      'double-encoded JSON (an answer whose data is a JSON string)',
      JSON.stringify({
        code: 1000,
        data: JSON.stringify({ password: 'Synth3tic!42' }),
      }),
    ],
    [
      'password_assignment',
      'triple-encoded JSON',
      JSON.stringify({
        data: JSON.stringify({
          inner: JSON.stringify({ password: 'Synth3tic!42' }),
        }),
      }),
    ],
    [
      'bearer_credential',
      'double-encoded Authorization header',
      JSON.stringify({
        data: JSON.stringify({ headers: { Authorization: token() } }),
      }),
    ],
    [
      'password_assignment',
      'double-encoded api_key',
      JSON.stringify({ data: JSON.stringify({ api_key: 'k3y-Synth3tic-42' }) }),
    ],
    [
      'private_key',
      'PEM key in double-encoded JSON',
      JSON.stringify({
        data: JSON.stringify({
          key: `${pemHeader('PRIVATE KEY')}\n${base64Lines(64)}\n${pemFooter('PRIVATE KEY')}\n`,
        }),
      }),
    ],
    [
      'password_assignment',
      'escaped Chinese (ensure_ascii)',
      asciiJson({ t: '密码：Synth3tic!42' }),
    ],
    [
      'password_assignment',
      'UTF-16LE without a byte order mark',
      Buffer.from('# notes\npassword=Synth3tic9x\n', 'utf16le'),
    ],
    [
      'password_assignment',
      'UTF-16BE without a byte order mark',
      utf16be('# notes\npassword=Synth3tic9x\n'),
    ],
    [
      'password_assignment',
      'Chinese UTF-16LE without a byte order mark',
      Buffer.from('测试床\n密码：Admin@2026\n', 'utf16le'),
    ],
    [
      'password_assignment',
      'NUL bytes inside the key',
      `pass${NUL}word=Synth3tic9x`,
    ],
    ['password_assignment', 'GBK Chinese', GBK_NOTE],
    [
      'password_assignment',
      'token named after a system',
      `PLM_TOKEN=${hex(18)}`,
    ],
    ['password_assignment', 'token in YAML', `AGILE_TOKEN: ${hex(16)}`],
    ['password_assignment', 'token header', `X-Token: ${hex(16)}`],
    [
      'password_assignment',
      'camelCase token in JSON',
      `{"userToken": "${hex(16)}"}`,
    ],
    ['password_assignment', 'value starting with !', 'password=!QAZ2wsx3edc'],
    [
      'password_assignment',
      'value starting with ! with more symbols',
      'password=!Synth3tic!42',
    ],
    ['password_assignment', 'value starting with @', 'password: @dmin2026'],
    [
      'password_assignment',
      'Chinese label, value starting with @',
      '密码：@Admin2026',
    ],
    [
      'password_assignment',
      'full-width colon after an English key',
      'Password：Synth3tic!42',
    ],
    [
      'password_assignment',
      'XML element',
      '<config><password>Synth3tic9x</password></config>',
    ],
    [
      'password_assignment',
      'YAML value on the next line',
      'database:\n  password:\n    Synth3tic9x\n',
    ],
    [
      'password_assignment',
      'command with a password argument',
      'user add synthetic password Synth3tic9x role admin',
    ],
    [
      'password_assignment',
      '.netrc line',
      'machine 192.0.2.7 login synthetic password Synth3tic9x',
    ],
    [
      'password_assignment',
      'PostgreSQL password file',
      '# hub\n192.0.2.8:5432:hub:synthetic:Synth3tic9x\n',
    ],
    ['password_assignment', 'Chinese label and a space', '密码 Synth3tic9x'],
    ['password_assignment', 'Chinese 是', '测试床密码是 Synth3tic9x'],
    ['password_assignment', 'Chinese 为', '口令为Synth3tic9x'],
    [
      'password_assignment',
      'Markdown table',
      '| 项目 | 值 |\n| --- | --- |\n| password | Admin@2026 |',
    ],
    ['password_assignment', 'short environment name', 'DB_PASS=Synth3tic9x'],
    ['password_assignment', 'camelCase pass', 'dbPass: Synth3tic9x'],
    [
      'password_assignment',
      'secret key',
      ['SECRET', '_KEY=S', 'ynth3t', 'ic-key', '-42'].join(''),
    ],
    [
      'password_assignment',
      'typographic quotes (text converted from a word processor)',
      'password: “Admin@2026x”',
    ],
    [
      'password_assignment',
      'windows-1252 typographic quotes',
      Buffer.concat([
        Buffer.from('password: '),
        Buffer.from([0x93]),
        Buffer.from('Admin@2026x'),
        Buffer.from([0x94]),
      ]),
    ],
    [
      'password_assignment',
      'valid UTF-8 Chinese in a file with one invalid byte (served lossy)',
      Buffer.concat([
        Buffer.from([0xff]),
        Buffer.from('\n测试床\n密码：Admin@2026\n'),
      ]),
    ],
    [
      'password_assignment',
      'many NUL bytes that are not UTF-16',
      Buffer.from(`pa${NUL}${NUL}ss${NUL}${NUL}wo${NUL}${NUL}rd=Synth3tic9x`),
    ],
  ];
  const missed = cases
    .filter(([detector, , input]) => !detectors(input).includes(detector))
    .map(([, label]) => label);
  assert.deepEqual(missed, []);
});

test('credential-scan@2 keeps prose, references and look-alikes clean', () => {
  const texts = [
    'Enable the password 2FA-enabled option for admins.',
    'The password 8-character minimum applies to every account.',
    'Users change the password policy in the console.',
    `{"nextPageToken": "${randomBytes(24).toString('base64url')}9", "items": []}`,
    'PWD=/home/synthetic/project',
    'bypass: 0x1f2e3d4c',
    'compass=north42west',
    'max_tokens: 4096',
    '密码 长度至少 8 位',
    '密码是必填项，长度 8 到 32 位。',
    '密码为空时不能登录。',
    '用户名和密码是登录的必要条件',
    '| password | 口令，按安全策略设置 |',
    '| password | string | 1-64 |',
    '2026:10:21:08:30',
    'user:1000:1000:Synthetic User:/home/user',
    'password:\n  Must contain letters and digits.\n',
    'password: |\n  see the vault entry db.password\n',
    '<password>${DB_PASSWORD}</password>',
    '<token>string</token>',
    'machine 192.0.2.7 login synthetic password <password>',
    'X-Token: required',
    'password=!vault',
    'password: &db_password',
    'password: *default_password',
    'password=@/run/secrets/db_password',
    'PuTTY-User-Key-File-2: ssh-rsa',
    mindMapNote('密码错误三次后锁定账号；"重新登录" 后提示 \\"已锁定\\"'),
    asciiJson({ root: { data: { text: '令牌过期后重新登录一次' } } }),
  ];
  for (const text of texts) assert.deepEqual(detectors(text), [], text);
});

test('bytes that are not text are reported as not inspected, never as clean', () => {
  const gzip = scanForCredentials(
    gzipSync(Buffer.from('notes\npassword=Synth3tic9x\n')),
  );
  assert.deepEqual(
    { inspected: gzip.inspected, clean: gzip.clean, findings: gzip.findings },
    { inspected: false, clean: false, findings: [] },
  );
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(2048),
  ]);
  assert.equal(scanForCredentials(png).inspected, false);
  assert.equal(scanForCredentials(randomBytes(4096)).inspected, false);
  assert.equal(scanForCredentials(Buffer.alloc(4096)).inspected, false);
  // A container that stores text uncompressed still reports what it finds.
  const stored = scanForCredentials(
    Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('notes.txt password=Synth3tic9x\n'),
    ]),
  );
  assert.equal(stored.inspected, false);
  assert.equal(stored.clean, false);
  assert.deepEqual(
    stored.findings.map((finding) => finding.detector),
    ['password_assignment'],
  );
  for (const text of ['', '# 说明\n普通文本\n', `命令手册${NUL}第二节`]) {
    const scan = scanForCredentials(Buffer.from(text));
    assert.deepEqual(
      { inspected: scan.inspected, clean: scan.clean },
      { inspected: true, clean: true },
      JSON.stringify(text),
    );
  }
  assert.equal(
    scanForCredentials(Buffer.from('普通文本 plain text\n', 'utf16le'))
      .inspected,
    true,
  );
  // Text that is not valid UTF-8 is still text: one stray byte in UTF-8, windows-1252 typographic quotes, GBK.
  for (const bytes of [
    Buffer.concat([
      Buffer.from([0xff]),
      Buffer.from('\n测试床说明，没有凭据。\n'.repeat(20)),
    ]),
    Buffer.from([0x93, 0x61, 0x62, 0x94, 0x20, 0x63]),
    GBK_NOTE.subarray(0, 6),
  ]) {
    assert.equal(
      scanForCredentials(bytes).inspected,
      true,
      bytes.toString('hex').slice(0, 20),
    );
  }
});

test('positions found in other views map back to byte offsets of the original', () => {
  const wide = scanForCredentials(
    Buffer.from('x password=Synth3tic9x', 'utf16le'),
  );
  assert.deepEqual(
    wide.findings.map((f) => [f.offset, f.line, f.column]),
    [[4, 1, 3]],
  );
  const nul = scanForCredentials(
    Buffer.from(`ab${NUL}c\nd pass${NUL}word=Synth3tic9x`),
  );
  assert.deepEqual(
    nul.findings.map((f) => [f.offset, f.line, f.column]),
    [[7, 2, 3]],
  );
  const gbk = scanForCredentials(Buffer.concat([Buffer.from('x '), GBK_NOTE]));
  assert.deepEqual(
    gbk.findings.map((f) => f.offset),
    [2],
  );
  // Lossy UTF-8: an ill-formed part is one U+FFFD; offsets still count the original bytes (E0 80 is two of them).
  const lossyPrefix = Buffer.concat([
    Buffer.from([0xe0, 0x80, 0xf0, 0x9f, 0x98, 0x80]),
    Buffer.from('用 '),
  ]);
  const lossy = scanForCredentials(
    Buffer.concat([lossyPrefix, Buffer.from('密码：Admin@2026')]),
  );
  assert.deepEqual(
    lossy.findings.map((f) => f.offset),
    [lossyPrefix.byteLength],
  );
  // A hit inside an escaped JSON string is reported at the string's opening quote.
  const json = asciiJson({ id: 'n1', note: '密码：Synth3tic!42' });
  const inJson = scanForCredentials(Buffer.from(json));
  assert.deepEqual(
    inJson.findings.map((f) => [f.detector, f.offset]),
    [['password_assignment', json.indexOf('"', json.indexOf('"note"') + 6)]],
  );
  assert.equal(JSON.stringify(inJson).includes('Synth3tic'), false);
});

test('32 MiB adversarial inputs: memory stays bounded and every scan is linear', () => {
  const MiB = 1024 * 1024;
  const fill = (unit: string) =>
    Buffer.from(
      unit.repeat(Math.ceil((32 * MiB) / Buffer.byteLength(unit))),
      'utf8',
    ).subarray(0, 32 * MiB);
  const units = [
    'password=Abc12345x\n',
    'PuTTY-User-Key-File-2: ',
    `${pemHeader('PRIVATE KEY')}${' '.repeat(800)}`,
    `${pemHeader('PRIVATE KEY')}\nA: ${pemHeader('PRIVATE KEY')}\n`,
    `Bearer ${' '.repeat(200)}`,
    `"a${BS}"password: ${BS}"Abc12345x${BS}"" `,
    'password:\n  ',
    'eyJabcdefgh.',
  ];
  let worst = 0;
  for (const unit of units) {
    const bytes = fill(unit);
    const rss = process.memoryUsage().rss;
    const started = performance.now();
    const scan = scanForCredentials(bytes);
    const elapsed = performance.now() - started;
    worst = Math.max(worst, elapsed);
    assert.ok(scan.findings.length <= 100);
    // Hits are capped per pattern, so memory does not grow with their number (it grew by about 450 MB before).
    assert.ok(
      process.memoryUsage().rss - rss < 200 * MiB,
      `${JSON.stringify(unit.slice(0, 20))}: rss grew by ${process.memoryUsage().rss - rss}`,
    );
  }
  // Measured at about 0.5 s on the development machine; the bound leaves room for slower runners.
  assert.ok(worst < 10_000, `slowest scan took ${Math.round(worst)} ms`);
  const many = scanForCredentials(fill('password=Abc12345x\n'));
  assert.deepEqual(
    { findings: many.findings.length, truncated: many.truncated },
    { findings: 100, truncated: true },
  );
});

// A fixed public seed gives reproducible, incompressible synthetic bytes. Random base64 can
// accidentally contain credential shapes; whether this negative is clean must not vary by run.
const largeSyntheticBytes = () =>
  createHash('shake256', { outputLength: 1_500_000 })
    .update('circle-hub scan large clean fixture v1')
    .digest();

test('many hits are capped and marked truncated; large inputs scan in linear time', () => {
  const many = Array.from({ length: 150 }, () => `t=${jwt()}`).join('\n');
  const capped = scanForCredentials(Buffer.from(many));
  assert.equal(capped.findings.length, 100);
  assert.equal(capped.truncated, true);
  assert.equal(capped.clean, false);
  const bytes = largeSyntheticBytes();
  assert.equal(bytes.byteLength, 1_500_000);
  assert.ok(gzipSync(bytes).byteLength > bytes.byteLength * 0.99);
  const blob = `![diagram](data:image/png;base64,${bytes.toString('base64')})`;
  const adversarial = [
    'password'.repeat(50_000),
    'x'.repeat(300_000) + 'token=' + 'y'.repeat(300_000),
    `${pemHeader('PRIVATE KEY')} `.repeat(5_000),
    'PuTTY-User-Key-File-2: '.repeat(5_000),
    'Bearer short '.repeat(50_000),
    'https://a:b'.repeat(30_000),
    'eyJabcdefgh.'.repeat(30_000),
  ].join('\n');
  const started = performance.now();
  const blobScan = scanForCredentials(Buffer.from(blob));
  const adversarialScan = scanForCredentials(Buffer.from(adversarial));
  const elapsed = performance.now() - started;
  assert.equal(blobScan.clean, true);
  assert.ok(adversarialScan.findings.length <= 100);
  assert.ok(elapsed < 5000, `scan took ${elapsed} ms`);
});

test('base64 image data containing a synthetic credential shape is still a cloud key finding', () => {
  const bytes = largeSyntheticBytes();
  // This 44-character base64 block encodes 33 bytes. Replacing bytes at a multiple
  // of three preserves the block verbatim in the image's base64, including word boundaries.
  // Assemble the synthetic shape at runtime; no credential-shaped literal is stored here.
  const collision = `/${'AI' + 'za'}${'Ab3'.repeat(11)}Z9/AAA`;
  const block = Buffer.from(collision, 'base64');
  assert.equal(block.byteLength, 33);
  bytes.set(block, 750_000);
  assert.equal(bytes.byteLength, 1_500_000);
  const encoded = bytes.toString('base64');
  assert.equal(encoded.slice(1_000_000, 1_000_044), collision);
  const scan = scanForCredentials(
    Buffer.from(`![diagram](data:image/png;base64,${encoded})`),
  );
  assert.equal(scan.inspected, true);
  assert.equal(scan.clean, false);
  assert.ok(scan.findings.some((finding) => finding.detector === 'cloud_key'));
});

test('scanWithContexts gives the same scan and, per kept finding, the text it was found in', () => {
  const value = `Synth${hex(4)}9x`;
  const cases: Array<[string, string | Uint8Array, string]> = [
    [
      'one line',
      `first line\nsecond line password=${value}\nthird line\nfourth line\n`,
      value,
    ],
    [
      'YAML value on the next line',
      `database:\n  password:\n    ${value}\n`,
      value,
    ],
    [
      'double-encoded JSON',
      JSON.stringify({ code: 1000, data: JSON.stringify({ password: value }) }),
      value,
    ],
    [
      'escaped Chinese (ensure_ascii), two levels down',
      asciiJson({ data: asciiJson({ note: `密码：${value}` }) }),
      `密码：${value}`,
    ],
    [
      'UTF-16LE without a byte order mark',
      Buffer.from(`# notes\npassword=${value}\n`, 'utf16le'),
      `password=${value}`,
    ],
    ['GBK Chinese', GBK_NOTE, '密码：Admin@2026'],
    [
      'NUL bytes inside the key',
      `pass${NUL}word=${value}`,
      `password=${value}`,
    ],
  ];
  for (const [label, input, expected] of cases) {
    const bytes =
      typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    const { scan, contexts } = scanWithContexts(bytes);
    assert.deepEqual(scan, scanForCredentials(bytes), label);
    assert.equal(contexts.length, scan.findings.length, label);
    assert.ok(
      scan.findings.length > 0 &&
        contexts.every((context) => context.includes(expected)),
      `${label}: ${JSON.stringify(contexts)}`,
    );
  }
  // The line of the hit and the next one, not the lines further on.
  assert.deepEqual(
    scanWithContexts(
      Buffer.from(
        `first line\nsecond line password=${value}\nthird line\nfourth line\n`,
      ),
    ).contexts,
    [`second line password=${value}\nthird line`],
  );
  // A key header: the key material after it, over several lines.
  const material =
    randomBytes(192)
      .toString('base64')
      .match(/.{1,64}/g) ?? [];
  const key = scanWithContexts(
    Buffer.from(
      `${pemHeader('PRIVATE KEY')}\n${material.join('\n')}\n${pemFooter('PRIVATE KEY')}\n`,
    ),
  );
  assert.ok(
    key.contexts.length === 1 &&
      material.every((line) => key.contexts[0]!.includes(line)),
  );
  // Many findings: one context per kept finding, and the same truncated scan.
  const many = Buffer.from(
    Array.from({ length: 150 }, () => `t=${jwt()}`).join('\n'),
  );
  const capped = scanWithContexts(many);
  assert.deepEqual(capped.scan, scanForCredentials(many));
  assert.equal(capped.contexts.length, 100);
});
