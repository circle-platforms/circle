import test from 'node:test';
import assert from 'node:assert/strict';
import {
  privateHost,
  WARNING_SCHEME,
  warningPage,
} from '../src/browser-warning.ts';
import { nativeText } from '../src/native-text.ts';

test('only a host on this network can have its certificate trusted for good', () => {
  for (const host of [
    '172.16.6.215:8888',
    '10.0.0.1',
    '192.168.1.20:443',
    '127.0.0.1:8766',
    '169.254.10.1',
    '100.64.0.9',
    '[::1]:8443',
    '[fd12:3456::1]',
    'nas.lan:8443',
    'router',
    'printer.local',
    'NAS.HOME.ARPA',
  ])
    assert.equal(privateHost(host), true, host);
  for (const host of [
    '8.8.8.8',
    '172.32.0.1',
    '192.169.1.1',
    'example.com',
    'device.example.lan.com',
    '[2001:db8::1]',
    '',
  ])
    assert.equal(privateHost(host), false, host);
});

test('the certificate warning shows the certificate safely and carries only its own decisions', () => {
  const page = warningPage({
    token: 'abc123',
    certificate: {
      url: 'https://172.16.6.215:8888/login',
      host: '172.16.6.215:8888',
      error: 'net::ERR_CERT_AUTHORITY_INVALID',
      subject: 'CN=<script>alert(1)</script>',
      issuer: 'CN="RSAWebRoot" & co',
      validStart: 1655806886,
      validExpiry: 2284675286,
      fingerprint: 'AB:CD',
    },
    dark: true,
    text: nativeText('zh-CN'),
    lang: 'zh-CN',
    nonce: 'n0nce',
  });
  assert.equal(page.includes('<script>alert(1)</script>'), false);
  assert(page.includes('CN=&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert(page.includes('CN=&quot;RSAWebRoot&quot; &amp; co'));
  assert(page.includes('NET::ERR_CERT_AUTHORITY_INVALID'));
  assert(page.includes('您的连接不是私密连接'));
  assert(page.includes('继续前往 172.16.6.215:8888（不安全）'));
  assert(page.includes(`href="${WARNING_SCHEME}://abc123/proceed"`));
  assert(page.includes(`${WARNING_SCHEME}://abc123/back`));
  assert(page.includes('data-circle-action="proceed"'));
  // The details and the link to proceed stay hidden until "Advanced"
  assert.match(page, /<section id="details" hidden>/);
  // The only script is the page's own, by nonce
  assert.equal(page.match(/<script/g)?.length, 1);
  assert(page.includes('<script nonce="n0nce">'));
  assert(page.includes('2042-05-26'));
});
