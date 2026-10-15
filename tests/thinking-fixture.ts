import { createServer, type ServerResponse } from 'node:http';

export function thinkingStream(
  response: ServerResponse,
  model: string,
  signature: string,
  text = 'accepted',
) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'fixture',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'thinking',
        thinking: 'fixture reasoning',
        signature,
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];
  response.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  );
}
export async function thinkingGateway(alwaysReject?: string) {
  const requests: {
    path: string;
    key: string;
    body: any;
    rejected: boolean;
  }[] = [];
  const server = createServer(async (req, res) => {
    let bytes = '';
    for await (const chunk of req) bytes += chunk;
    if (!bytes) {
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const body = JSON.parse(bytes);
    const key = String(req.headers['x-api-key']);
    const signature = `signed:${req.url}:${key}:${body.model}`;
    const rejected = body.messages.some(
      (m: any) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b: any) =>
            (b.type === 'thinking' && b.signature !== signature) ||
            (b.type === 'redacted_thinking' && b.data !== signature),
        ),
    );
    requests.push({ path: req.url!, key, body, rejected });
    if (rejected || alwaysReject) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              alwaysReject ??
              'messages.1.content.0: Invalid `signature` in `thinking` block',
          },
        }),
      );
    } else thinkingStream(res, body.model, signature);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Read the stored JSON verbatim, so history checks also catch serialization edits. */
export async function checkpointRows(home: string, sessionId: string) {
  const { DatabaseSync } = await import('node:sqlite');
  const { join } = await import('node:path');
  const db = new DatabaseSync(join(home, 'circle.sqlite'), { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT id, parent, message, created FROM checkpoints WHERE session_id = ? ORDER BY created, rowid',
      )
      .all(sessionId);
  } finally {
    db.close();
  }
}
