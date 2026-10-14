import test from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, secretRefused } from '../src/browser/hosts.js';

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
