import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureNetwork,
  currentNetworkStatus,
  networkSummary,
} from '../src/net.js';

test('the status names what chose the proxy and where it points, and keeps the key out of it', () => {
  const setup = configureNetwork({
    // NODE_USE_ENV_PROXY is for a Node.js too old to read the two above its own;
    // Circle reports the same host either way.
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: 'http://someone:secret@proxy.test:3128',
  });
  const status = currentNetworkStatus();
  setup.restore();
  assert.equal(status.proxy, true);
  assert.equal(status.proxyFrom, 'HTTPS_PROXY');
  assert.equal(status.proxyHost, 'proxy.test:3128');
  assert.doesNotMatch(JSON.stringify(status), /secret|someone/);
  assert.match(
    networkSummary(status),
    /proxy on \(HTTPS_PROXY at proxy\.test:3128\)/,
  );
  assert.match(
    networkSummary({ ...status, proxy: false, proxyFrom: undefined }),
    /proxy off/,
  );
});

test('a bare host and port is still a host, and a proxy that cannot be read is named', () => {
  const bare = configureNetwork({
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: '127.0.0.1:8899',
  });
  const status = currentNetworkStatus();
  bare.restore();
  assert.equal(status.proxyFrom, 'HTTP_PROXY');
  assert.equal(status.proxyHost, '127.0.0.1:8899');
});
