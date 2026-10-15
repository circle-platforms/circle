import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import {
  RuntimeCredentialClient,
  executeCredentialRequest,
  validateCredentialRequest,
  type CredentialRequest,
  type RuntimeCredentialStore,
} from '../src/runtime-private-channel.ts';

test('private MessagePorts perform credential put/get/delete without runtime updates', async () => {
  const { port1, port2 } = new MessageChannel();
  const values = new Map<string, string>();
  const store: RuntimeCredentialStore = {
    get: async (key) => values.get(key),
    put: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
  const client = new RuntimeCredentialClient((message) =>
    port1.postMessage(message),
  );
  const privateTypes: string[] = [];
  port2.on('message', async (message) => {
    privateTypes.push(message.type);
    port2.postMessage(await executeCredentialRequest(message, store));
  });
  port1.on('message', (message) => client.receive(message));
  try {
    await client.put('github:fixture', 'fixture-secret');
    assert.equal(values.get('github:fixture'), 'fixture-secret');
    assert.equal(await client.get('github:fixture'), 'fixture-secret');
    await client.delete('github:fixture');
    assert.equal(await client.get('github:fixture'), undefined);
    assert.deepEqual(privateTypes, [
      'credential-request',
      'credential-request',
      'credential-request',
      'credential-request',
    ]);
  } finally {
    client.close();
    port1.close();
    port2.close();
  }
});
test('invalid keys/oversized values never reach the host and handler errors do not leak', async () => {
  const sent: CredentialRequest[] = [];
  const client = new RuntimeCredentialClient((message) => {
    sent.push(message);
  });
  await assert.rejects(client.get('invalid key'), /invalid/);
  await assert.rejects(
    client.put('fixture', 'x'.repeat(1024 * 1024 + 1)),
    /invalid/,
  );
  assert.equal(sent.length, 0);
  const reply = await executeCredentialRequest(
    { type: 'credential-request', id: 'one', operation: 'get', key: 'fixture' },
    {
      get: async () => {
        throw Error('fixture-secret');
      },
      put: async () => {},
      delete: async () => {},
    },
  );
  assert.deepEqual(reply, {
    type: 'credential-reply',
    id: 'one',
    ok: false,
    error: 'native credential operation failed',
  });
  assert.equal(JSON.stringify(reply).includes('fixture-secret'), false);
  assert.throws(
    () =>
      validateCredentialRequest({
        type: 'credential-request',
        id: 'x',
        operation: 'get',
        key: 'fixture',
        value: 'extraneous',
      }),
    /invalid/,
  );
  client.close();
});
test('timeouts, disconnects and stale private replies cannot complete another request', async () => {
  const requests: CredentialRequest[] = [];
  const client = new RuntimeCredentialClient(
    (request) => requests.push(request),
    10,
  );
  await assert.rejects(client.get('fixture'), /timed out/);
  assert.equal(
    client.receive({
      type: 'credential-reply',
      id: requests[0].id,
      ok: true,
      value: 'late',
    }),
    false,
  );
  const pending = client.get('fixture');
  assert.equal(
    client.receive({
      type: 'credential-reply',
      id: 'wrong',
      ok: true,
      value: 'wrong',
    }),
    false,
  );
  client.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(client.get('fixture'), /closed/);
  const broken = new RuntimeCredentialClient(() => {
    throw Error('transport');
  });
  await assert.rejects(broken.get('fixture'), /disconnected/);
  broken.close();
});
test('malformed matching reply rejects and duplicate replies are ignored', async () => {
  let request!: CredentialRequest;
  const client = new RuntimeCredentialClient((message) => {
    request = message;
  });
  const pending = client.get('fixture');
  assert.equal(
    client.receive({
      type: 'credential-reply',
      id: request.id,
      ok: true,
      value: 123,
    }),
    true,
  );
  await assert.rejects(pending, /invalid/);
  assert.equal(
    client.receive({
      type: 'credential-reply',
      id: request.id,
      ok: true,
      value: 'late',
    }),
    false,
  );
  client.close();
});
