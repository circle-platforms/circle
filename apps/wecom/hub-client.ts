import type { Channel } from './protocol.ts';

export function postHub(
  fetcher: typeof fetch,
  channel: Channel,
  body: unknown,
) {
  return fetcher(new URL('/api/bot-channel/v1', channel.hub), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      authorization: 'Bearer ' + channel.token,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

export function getFile(
  fetcher: typeof fetch,
  channel: Channel,
  sha256: string,
  subject: string,
  receipt: string,
) {
  return transferHubFile(fetcher, channel, subject, sha256, undefined, receipt);
}

export function transferHubFile(
  fetcher: typeof fetch,
  channel: Channel,
  subject: string,
  sha: string,
  buffer?: Buffer,
  receipt?: string,
) {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('文件不可用');
  if (!buffer && !receipt) throw new Error('缺少投递回执');
  return fetcher(new URL('/api/bot-channel/v1/files/' + sha, channel.hub), {
    method: buffer ? 'PUT' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(900000),
    headers: {
      authorization: 'Bearer ' + channel.token,
      'Bot-Member-Subject': Buffer.from(subject).toString('base64url'),
      ...(receipt ? { 'Bot-Delivery-Receipt': receipt } : {}),
      ...(buffer ? { 'content-length': String(buffer.length) } : {}),
    },
    ...(buffer ? { body: new Uint8Array(buffer) } : {}),
  });
}
