import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressBarInput,
  hostOf,
  secretRefused,
} from '../src/browser/hosts.js';

test('a saved secret is refused only on a public address whose certificate was not trusted', () => {
  assert.equal(
    hostOf('https://Device.Example.net:8443/login'),
    'device.example.net:8443',
  );
  assert.equal(hostOf('not an address'), '');
  assert.match(
    secretRefused('device.example.net:8443', true),
    /^a saved secret goes into no page on device\.example\.net:8443: its certificate is not trusted and it is a public address/,
  );
  // This network, or a certificate the browser trusts: typed as before
  for (const host of [
    '172.16.6.215:8888',
    '192.168.1.1',
    '[::1]:8443',
    'nas.lan',
    'router',
  ])
    assert.equal(secretRefused(host, true), '', host);
  assert.equal(secretRefused('device.example.net', false), '');
  assert.equal(secretRefused('', true), '');
});

test('the address bar opens a full URL, completes a bare host with https, and refuses the rest (#67)', () => {
  assert.equal(addressBarInput('http://example.test/'), 'http://example.test/');
  assert.equal(addressBarInput('www.baidu.com'), 'https://www.baidu.com/');
  assert.equal(
    addressBarInput('baidu.com/path?q=1'),
    'https://baidu.com/path?q=1',
  );
  assert.equal(addressBarInput('localhost:8080'), 'https://localhost:8080/');
  assert.equal(addressBarInput(' 10.4.2.90:8443 '), 'https://10.4.2.90:8443/');
  assert.equal(addressBarInput('EXAMPLE.COM'), 'https://example.com/');
  for (const refused of [
    '',
    ' ',
    'hello world',
    'baidu',
    'user@host.example',
    'javascript:alert(1)',
    'mailto:someone@example.com',
    'file:///etc/passwd',
    'ftp://files.example.com',
    'data:text/html,<p>hi',
    '/just/a/path',
    'example.com:99999',
  ])
    assert.equal(addressBarInput(refused), undefined, refused);
});
