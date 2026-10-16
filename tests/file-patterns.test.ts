import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CREDENTIAL_FILES,
  matchPattern,
} from '../src/file_patterns.js';
import { wildcard, classifyCommand, defaultPolicy } from '../src/approvals.js';
import { Sandbox } from '../src/sandbox.js';

test('the file name patterns match the whole name, with * and ?', () => {
  assert.equal(matchPattern('*.pem', 'server.pem'), true);
  assert.equal(matchPattern('*.pem', 'server.key'), false);
  assert.equal(matchPattern('.env', 'prod.env'), false);
  assert.equal(matchPattern('.env.*', '.env.local'), true);
  assert.equal(matchPattern('id_rsa?', 'id_rsa1'), true);
  assert.equal(matchPattern('id_rsa?', 'id_rsa12'), false);
  // A dot and a plus are part of the name, not a regular expression.
  assert.equal(matchPattern('a.pem', 'axpem'), false);
  assert.equal(matchPattern('a+b', 'a+b'), true);
  assert.equal(matchPattern('*.pem', 'SERVER.PEM'), false);
  assert.equal(matchPattern('*.pem', 'SERVER.PEM', true), true);
});

test('approvals and the sandbox read a pattern the way this module matches it', () => {
  assert.equal(wildcard('*.pem', 'server.pem'), true);
  const root = '/tmp/circle-file-patterns';
  const sandbox = new Sandbox(root, undefined, [
    ...DEFAULT_CREDENTIAL_FILES,
    '*.key',
  ]);
  assert.throws(
    () => sandbox.checkCredentialPath('/elsewhere/deploy.key'),
    /credential file/,
  );
  assert.equal(
    classifyCommand('cat deploy.key', [...DEFAULT_CREDENTIAL_FILES, '*.key'])
      .verdict,
    'DENY',
  );
  // A pattern is matched against the name, so a folder in front of it matches nothing.
  assert.equal(
    classifyCommand('cat secrets/deploy.key', ['secrets/*.key']).verdict,
    'ASK',
  );
});

test('the always protected list cannot be narrowed by what a person adds', () => {
  const policy = defaultPolicy('/tmp/circle-file-patterns', undefined, [
    ...DEFAULT_CREDENTIAL_FILES,
    'id_ed25519',
  ]);
  assert.equal(
    policy.review('execute', { command: 'cat id_ed25519' }).verdict,
    'DENY',
  );
  assert.ok(DEFAULT_CREDENTIAL_FILES.includes('.env'));
});
