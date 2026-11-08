// The device authorization grant on Circle's side (RFC 8628): which servers offer it, what a device code answer must
// hold, and how polling waits, slows down and ends. A scripted fetch answers; waiting and time are injected, so
// nothing here sleeps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEVICE_CODE_GRANT,
  DeviceSignInEnded,
  deviceEndpoint,
  pollDeviceToken,
  startDeviceAuthorization,
  type DeviceAuthorization,
} from '../src/mcp_device.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A fetch that answers from a list and keeps what it was sent. */
function scripted(answers: Response[]) {
  const sent: { url: string; body: URLSearchParams }[] = [];
  const fetcher = async (url: string | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: new URLSearchParams(String(init?.body)),
    });
    const answer = answers.shift();
    if (!answer) throw new Error('no answer left');
    return answer;
  };
  return { sent, fetcher };
}

test('only a server whose metadata names the endpoint and the grant offers the device code', () => {
  const metadata = (fields: Record<string, unknown>) => ({
    authorizationServerUrl: 'https://as.example.test',
    authorizationServerMetadata: {
      issuer: 'https://as.example.test',
      authorization_endpoint: 'https://as.example.test/authorize',
      token_endpoint: 'https://as.example.test/token',
      response_types_supported: ['code'],
      ...fields,
    },
  });
  assert.equal(
    deviceEndpoint(
      metadata({
        device_authorization_endpoint: 'https://as.example.test/device',
        grant_types_supported: ['authorization_code', DEVICE_CODE_GRANT],
      }) as never,
    ),
    'https://as.example.test/device',
  );
  for (const fields of [
    { grant_types_supported: ['authorization_code', DEVICE_CODE_GRANT] },
    {
      device_authorization_endpoint: 'https://as.example.test/device',
      grant_types_supported: ['authorization_code'],
    },
    {
      device_authorization_endpoint: 'javascript:alert(1)',
      grant_types_supported: [DEVICE_CODE_GRANT],
    },
    {
      device_authorization_endpoint:
        'https://user:secret@as.example.test/device',
      grant_types_supported: [DEVICE_CODE_GRANT],
    },
  ])
    assert.equal(deviceEndpoint(metadata(fields) as never), undefined);
  assert.equal(deviceEndpoint(undefined), undefined);
});

test('a device code answer is read with its defaults, and an unreadable or refused one is an error', async () => {
  const { sent, fetcher } = scripted([
    json(200, {
      device_code: 'dc',
      user_code: 'BCDF-GHJK',
      verification_uri: 'https://as.example.test/device',
      expires_in: 600,
    }),
  ]);
  const started = await startDeviceAuthorization(
    'https://as.example.test/device',
    'client-1',
    'https://as.example.test/mcp',
    fetcher,
    undefined,
    () => 1000,
  );
  assert.deepEqual(started, {
    deviceCode: 'dc',
    userCode: 'BCDF-GHJK',
    verificationUri: 'https://as.example.test/device',
    expiresAt: 601_000,
    interval: 5,
  });
  assert.equal(sent[0]!.body.get('client_id'), 'client-1');
  assert.equal(sent[0]!.body.get('resource'), 'https://as.example.test/mcp');

  const good = {
    device_code: 'dc',
    user_code: 'BCDF-GHJK',
    verification_uri: 'https://as.example.test/device',
    expires_in: 600,
  };
  for (const answer of [
    { ...good, verification_uri: 'javascript:alert(1)' },
    { ...good, user_code: '' },
    { ...good, user_code: 'two\nlines' },
    { ...good, expires_in: 0 },
    { ...good, interval: 0 },
    { ...good, device_code: 7 },
  ])
    await assert.rejects(
      startDeviceAuthorization(
        'https://as.example.test/device',
        'client-1',
        undefined,
        scripted([json(200, answer)]).fetcher,
      ),
      /unreadably/,
    );
  await assert.rejects(
    startDeviceAuthorization(
      'https://as.example.test/device',
      'client-1',
      undefined,
      scripted([json(400, { error: 'unauthorized_client' })]).fetcher,
    ),
    /no device code: unauthorized_client/,
  );
  // A long lifetime is cut to thirty minutes
  const long = await startDeviceAuthorization(
    'https://as.example.test/device',
    'client-1',
    undefined,
    scripted([json(200, { ...good, expires_in: 86400 })]).fetcher,
    undefined,
    () => 0,
  );
  assert.equal(long.expiresAt, 30 * 60 * 1000);
});

const authorization = (fields: Partial<DeviceAuthorization> = {}) => ({
  deviceCode: 'dc',
  userCode: 'BCDF-GHJK',
  verificationUri: 'https://as.example.test/device',
  expiresAt: 1_000_000,
  interval: 5,
  ...fields,
});

test('polling waits the interval, five seconds more after each slow_down, and takes the tokens', async () => {
  const waits: number[] = [];
  const { sent, fetcher } = scripted([
    json(400, { error: 'authorization_pending' }),
    json(400, { error: 'slow_down' }),
    json(400, { error: 'authorization_pending' }),
    json(200, { access_token: 'access', token_type: 'Bearer' }),
  ]);
  const tokens = await pollDeviceToken(
    'https://as.example.test/token',
    'client-1',
    'https://as.example.test/mcp',
    authorization(),
    fetcher,
    undefined,
    () => 0,
    async (ms) => void waits.push(ms),
  );
  assert.deepEqual(tokens, { access_token: 'access', token_type: 'Bearer' });
  assert.deepEqual(waits, [5000, 5000, 10000, 10000]);
  assert.equal(sent.length, 4);
  for (const { body } of sent) {
    assert.equal(body.get('grant_type'), DEVICE_CODE_GRANT);
    assert.equal(body.get('device_code'), 'dc');
    assert.equal(body.get('client_id'), 'client-1');
    assert.equal(body.get('resource'), 'https://as.example.test/mcp');
  }
});

test('polling ends on a refusal, an expiry said by the server or by the clock, and any other error', async () => {
  const poll = (answers: Response[], now = () => 0) =>
    pollDeviceToken(
      'https://as.example.test/token',
      'client-1',
      undefined,
      authorization(),
      scripted(answers).fetcher,
      undefined,
      now,
      async () => {},
    );
  await assert.rejects(
    poll([json(400, { error: 'access_denied' })]),
    (error) =>
      error instanceof DeviceSignInEnded && /refused/.test(error.message),
  );
  await assert.rejects(
    poll([json(400, { error: 'expired_token' })]),
    (error) =>
      error instanceof DeviceSignInEnded && /expired/.test(error.message),
  );
  // Past the lifetime it stops without asking the server again
  await assert.rejects(
    poll([], () => 2_000_000),
    DeviceSignInEnded,
  );
  await assert.rejects(
    poll([json(400, { error: 'invalid_grant' })]),
    /refused the code: invalid_grant/,
  );
  await assert.rejects(
    poll([new Response('not json', { status: 502 })]),
    /refused the code: HTTP 502/,
  );
});

test('a sign-in that is stopped stops polling', async () => {
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(
    pollDeviceToken(
      'https://as.example.test/token',
      'client-1',
      undefined,
      authorization(),
      scripted([]).fetcher,
      stop.signal,
      () => 0,
      async () => {},
    ),
    { name: 'AbortError' },
  );
});
