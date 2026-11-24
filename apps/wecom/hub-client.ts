import type { Channel } from './protocol.ts';

export const DEFAULT_TRANSFER_TOTAL_TIMEOUT_MS = 900_000;
export const DEFAULT_TRANSFER_STALL_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSFER_CHUNK_BYTES = 64 * 1024;

export interface TransferFileOptions {
  stallTimeoutMs?: number;
  totalTimeoutMs?: number;
  chunkBytes?: number;
}

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
  options?: TransferFileOptions,
) {
  return transferHubFile(
    fetcher,
    channel,
    subject,
    sha256,
    undefined,
    receipt,
    options,
  );
}

export function transferHubFile(
  fetcher: typeof fetch,
  channel: Channel,
  subject: string,
  sha: string,
  buffer?: Buffer,
  receipt?: string,
  options?: TransferFileOptions,
): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('文件不可用');
  if (!buffer && !receipt) throw new Error('缺少投递回执');
  const totalTimeoutMs =
    options?.totalTimeoutMs ?? DEFAULT_TRANSFER_TOTAL_TIMEOUT_MS;
  const stallTimeoutMs = Math.max(
    1,
    options?.stallTimeoutMs ?? DEFAULT_TRANSFER_STALL_TIMEOUT_MS,
  );
  const chunkBytes = Math.max(
    1,
    options?.chunkBytes ?? DEFAULT_TRANSFER_CHUNK_BYTES,
  );

  const controller = new AbortController();
  const totalSignal = AbortSignal.timeout(totalTimeoutMs);
  const signal = AbortSignal.any([controller.signal, totalSignal]);

  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const clearStallTimer = () => {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  };
  const armStallTimer = () => {
    clearStallTimer();
    if (signal.aborted) return;
    stallTimer = setTimeout(() => {
      controller.abort(
        new DOMException(
          'File transfer stalled without progress',
          'TimeoutError',
        ),
      );
    }, stallTimeoutMs);
    stallTimer.unref?.();
  };

  let offset = 0;
  const requestBody = buffer
    ? new ReadableStream<Uint8Array>(
        {
          pull(streamController) {
            armStallTimer();
            if (offset >= buffer.length) {
              streamController.close();
              return;
            }
            const end = Math.min(offset + chunkBytes, buffer.length);
            streamController.enqueue(
              new Uint8Array(
                buffer.buffer,
                buffer.byteOffset + offset,
                end - offset,
              ),
            );
            offset = end;
            if (offset >= buffer.length) {
              streamController.close();
            }
          },
          cancel() {
            // Request cancelled or aborted; finally clears the stall timer.
          },
        },
        { highWaterMark: 0 },
      )
    : undefined;

  return (async () => {
    armStallTimer();
    let response: Response;
    try {
      response = await fetcher(
        new URL('/api/bot-channel/v1/files/' + sha, channel.hub),
        {
          method: buffer ? 'PUT' : 'GET',
          redirect: 'error',
          signal,
          headers: {
            authorization: 'Bearer ' + channel.token,
            'Bot-Member-Subject': Buffer.from(subject).toString('base64url'),
            ...(receipt ? { 'Bot-Delivery-Receipt': receipt } : {}),
            ...(buffer ? { 'content-length': String(buffer.length) } : {}),
          },
          ...(requestBody
            ? { body: requestBody, duplex: 'half' as const }
            : {}),
        },
      );
    } finally {
      clearStallTimer();
    }
    if (!response.body) {
      return response;
    }
    const reader = response.body.getReader();
    let streamClosed = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let onAbort = () => {};
    const finishStream = () => {
      if (streamClosed) return;
      streamClosed = true;
      clearStallTimer();
      signal.removeEventListener('abort', onAbort);
    };
    onAbort = () => {
      const reason =
        signal.reason ??
        new DOMException(
          'File transfer stalled without progress',
          'TimeoutError',
        );
      finishStream();
      try {
        streamController.error(reason);
      } catch {
        // Ignore if stream is already closed or errored.
      }
      void reader.cancel(reason).catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const monitoredBody = new ReadableStream<Uint8Array>(
      {
        start(c) {
          streamController = c;
          if (signal.aborted) onAbort();
        },
        async pull(c) {
          if (streamClosed) return;
          armStallTimer();
          try {
            const { done, value } = await reader.read();
            if (streamClosed) return;
            if (done) {
              finishStream();
              c.close();
              return;
            }
            armStallTimer();
            c.enqueue(value);
          } catch (error) {
            if (streamClosed) return;
            finishStream();
            c.error(error);
          }
        },
        async cancel(reason) {
          finishStream();
          await reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(monitoredBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  })();
}
