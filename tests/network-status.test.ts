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

// A bare host and port is not a URL. A Node that reads the variable itself refuses
// that value; an older one takes it because NODE_USE_ENV_PROXY asked it to. Either
// way the status tells the truth: it names a proxy only when one is in use, and a
// value it could not use is said so out loud.
test('a proxy is named only when it was applied, and a refused value is explained', () => {
  const setup = configureNetwork({
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: '127.0.0.1:8899',
  });
  const status = currentNetworkStatus();
  setup.restore();
  if (status.proxy) {
    assert.equal(status.proxyFrom, 'HTTP_PROXY');
    assert.equal(status.proxyHost, '127.0.0.1:8899');
  } else {
    assert.equal(status.proxyFrom, undefined);
    assert.ok(
      status.problems.some((problem) =>
        /proxy setting cannot be used/.test(problem),
      ),
      'a refused proxy value leaves no word about why',
    );
  }
});
