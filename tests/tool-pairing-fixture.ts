import { createServer } from 'node:http';
export type WireBody = { model: string; messages: any[] };
export function pairingError(
  body: WireBody,
  protocol: string,
): string | undefined {
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    const calls =
      protocol === 'anthropic' && Array.isArray(m.content)
        ? m.content
            .filter((b: any) => b.type === 'tool_use')
            .map((b: any) => b.id)
        : (m.tool_calls ?? []).map((c: any) => c.id);
    if (!calls.length) continue;
    const found: string[] = [];
    if (protocol === 'anthropic') {
      const next = body.messages[i + 1];
      if (next?.role === 'user' && Array.isArray(next.content))
        for (const b of next.content) {
          if (b.type !== 'tool_result') break;
          found.push(b.tool_use_id);
        }
    } else
      for (let j = i + 1; body.messages[j]?.role === 'tool'; j++)
        found.push(body.messages[j].tool_call_id);
    const missing = calls.filter((id: string) => !found.includes(id));
    if (missing.length)
      return `messages.${i}: tool_use ids were found without tool_result blocks immediately after: ${missing.join(', ')}`;
  }
}
export async function pairingGateway(
  protocol: string,
  modeTool = 'plan_enter',
) {
  const requests: { body: WireBody; error?: string }[] = [];
  const calls = [
    { id: 'call-mode', name: modeTool, args: {} },
    { id: 'call-a', name: 'read_file', args: { file_path: 'a.txt' } },
    { id: 'call-b', name: 'read_file', args: { file_path: 'b.txt' } },
  ];
  const server = createServer(async (req, res) => {
    let bytes = '';
    for await (const b of req) bytes += b;
    if (!bytes) {
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const body = JSON.parse(bytes);
    const error = pairingError(body, protocol);
    requests.push({ body, error });
    if (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: error },
        }),
      );
      return;
    }
    const first = requests.length === 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (protocol === 'anthropic') {
      const events: any[] = [
        {
          type: 'message_start',
          message: {
            id: 'fixture',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ];
      const blocks = first
        ? calls.map((c) => ({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: c.args,
          }))
        : [{ type: 'text', text: 'paired response' }];
      blocks.forEach((content_block, index) => {
        events.push(
          { type: 'content_block_start', index, content_block },
          { type: 'content_block_stop', index },
        );
      });
      events.push(
        {
          type: 'message_delta',
          delta: {
            stop_reason: first ? 'tool_use' : 'end_turn',
            stop_sequence: null,
          },
          usage: { output_tokens: 1 },
        },
        { type: 'message_stop' },
      );
      res.end(
        events
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(''),
      );
    } else {
      const delta = first
        ? {
            tool_calls: calls.map((c, index) => ({
              index,
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
        : { content: 'paired response' };
      res.end(
        'data: ' +
          JSON.stringify({
            model: body.model,
            choices: [
              { index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no address');
  return {
    requests,
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export async function pairingRows(home: string, sessionId: string) {
  const { DatabaseSync } = await import('node:sqlite');
  const { join } = await import('node:path');
  const db = new DatabaseSync(join(home, 'circle.sqlite'), { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT id,parent,message,created FROM checkpoints WHERE session_id=? ORDER BY created,rowid',
      )
      .all(sessionId);
  } finally {
    db.close();
  }
}
