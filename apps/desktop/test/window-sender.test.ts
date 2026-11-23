import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAppWindowSender } from '../src/window-sender';

function makeCandidate(overrides?: {
  destroyed?: boolean;
  crashed?: boolean;
  routingId?: number;
  processId?: number;
}) {
  return {
    webContents: {
      isDestroyed: () => overrides?.destroyed ?? false,
      isCrashed: () => overrides?.crashed ?? false,
      mainFrame: {
        routingId: overrides?.routingId ?? 10,
        processId: overrides?.processId ?? 20,
      },
    },
  };
}

const TRUSTED_URL = 'circle://workbench/index.html#/session/s1';

test('verifyAppWindowSender accepts only an alive un-crashed main frame at the trusted app URL', () => {
  const main = makeCandidate();
  const matched = verifyAppWindowSender([main], {
    sender: main.webContents,
    senderFrame: { routingId: 10, processId: 20, url: TRUSTED_URL },
  });
  assert.equal(matched, main);

  const other = makeCandidate();
  assert.throws(
    () =>
      verifyAppWindowSender([main], {
        sender: other.webContents,
        senderFrame: { routingId: 10, processId: 20, url: TRUSTED_URL },
      }),
    /untrusted IPC sender/,
  );

  const destroyed = makeCandidate({ destroyed: true });
  assert.throws(
    () =>
      verifyAppWindowSender([destroyed], {
        sender: destroyed.webContents,
        senderFrame: { routingId: 10, processId: 20, url: TRUSTED_URL },
      }),
    /untrusted IPC sender/,
  );

  const crashed = makeCandidate({ crashed: true });
  assert.throws(
    () =>
      verifyAppWindowSender([crashed], {
        sender: crashed.webContents,
        senderFrame: { routingId: 10, processId: 20, url: TRUSTED_URL },
      }),
    /untrusted IPC sender/,
  );

  assert.throws(
    () =>
      verifyAppWindowSender([main], {
        sender: main.webContents,
        senderFrame: null,
      }),
    /untrusted IPC sender/,
  );

  assert.throws(
    () =>
      verifyAppWindowSender([main], {
        sender: main.webContents,
        senderFrame: { routingId: 11, processId: 20, url: TRUSTED_URL },
      }),
    /untrusted IPC sender/,
  );

  assert.throws(
    () =>
      verifyAppWindowSender([main], {
        sender: main.webContents,
        senderFrame: { routingId: 10, processId: 21, url: TRUSTED_URL },
      }),
    /untrusted IPC sender/,
  );

  assert.throws(
    () =>
      verifyAppWindowSender([main], {
        sender: main.webContents,
        senderFrame: {
          routingId: 10,
          processId: 20,
          url: 'https://example.invalid/index.html',
        },
      }),
    /untrusted IPC sender/,
  );
});
