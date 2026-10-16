import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  installOwnedBrowserWitness,
  removeOwnedBrowserWitness,
} from './helpers/native-devtools-bridge-handoff.mjs';

const partition = {};
function guest(id, url = 'http://127.0.0.1:32101/', type = 'window') {
  const target = new EventEmitter();
  return Object.assign(target, {
    id,
    session: partition,
    getURL: () => url,
    getType: () => type,
    isDestroyed: () => false,
    isDevToolsOpened: () => target.opened === true,
    closeDevTools: () => {
      target.closed = true;
    },
  });
}
const host = (...targets) => ({
  session: {
    fromPartition: (name) => {
      assert.equal(name, 'circle-browser-owner');
      return partition;
    },
  },
  webContents: { getAllWebContents: () => targets },
});

test('owned actual guest requires exact normalized fixture URL and unique owned WebContentsView window', () => {
  const main = guest(1, 'http://127.0.0.1:32101/', 'window');
  main.session = {};
  const other = guest(2, 'http://127.0.0.1:32102/');
  const owned = guest(3);
  assert.deepEqual(
    installOwnedBrowserWitness(host(main, other, owned), {
      id: 'unique',
      sessionId: 'owner',
      pageURL: 'http://127.0.0.1:32101',
    }),
    { guestId: 3, sessionId: 'owner', pageURL: 'http://127.0.0.1:32101/' },
  );
  assert.equal(main.listenerCount('console-message'), 0);
  assert.equal(other.listenerCount('console-message'), 0);
  removeOwnedBrowserWitness(null, 'unique');
  assert.throws(
    () =>
      installOwnedBrowserWitness(host(main, other), {
        id: 'missing',
        sessionId: 'owner',
        pageURL: 'http://127.0.0.1:32101/',
      }),
    /not unique/,
  );
  assert.throws(
    () =>
      installOwnedBrowserWitness(host(owned, guest(4)), {
        id: 'duplicate',
        sessionId: 'owner',
        pageURL: 'http://127.0.0.1:32101/',
      }),
    /not unique/,
  );
});

test('gap witness observes real console effect and removes only owned listeners/DevTools', () => {
  const owned = guest(5);
  const unrelated = () => {};
  owned.on('console-message', unrelated);
  installOwnedBrowserWitness(host(owned), {
    id: 'effect',
    sessionId: 'owner',
    pageURL: owned.getURL(),
  });
  const witness = globalThis.__circleOwnedBrowserWitnesses.get('effect');
  owned.emit('console-message', { message: 'JOURNEY_BROWSER_DEBUG_RESULT 40' });
  assert.equal(witness.result, undefined);
  owned.emit('devtools-opened');
  assert.equal(witness.opened, true);
  owned.emit('console-message', { message: 'JOURNEY_BROWSER_DEBUG_RESULT 4' });
  assert.equal(witness.result, 4);
  assert.equal(witness.messages.length, 1);
  owned.opened = true;
  removeOwnedBrowserWitness(null, 'effect');
  assert.equal(owned.closed, true);
  assert.equal(owned.listenerCount('console-message'), 1);
  assert.equal(owned.listenerCount('devtools-opened'), 0);
  assert.equal(globalThis.__circleOwnedBrowserWitnesses, undefined);
});
