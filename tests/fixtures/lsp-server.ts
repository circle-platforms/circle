import { renameSync, writeFileSync } from 'node:fs';
let buffer: Buffer = Buffer.alloc(0);
const log = process.env.LSP_TEST_LOG;
if (process.argv.includes('--process-observation'))
  process.stderr.write('x'.repeat(10000) + '\ntoken=fixture-secret\n');
const records: Record<string, unknown>[] = [];
const heldRenames: (() => void)[] = [];
const texts = new Map<string, string>();
const heldDiagnostics: (() => void)[] = [];
const send = (id: unknown, result: unknown): void => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(header.subarray(0, 7));
  process.stdout.write(Buffer.concat([header.subarray(7), body]));
};
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const size = Number(
      buffer
        .subarray(0, end)
        .toString()
        .match(/Content-Length:\s*(\d+)/i)![1],
    );
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(
      buffer.subarray(end + 4, end + 4 + size).toString(),
    ) as Record<string, unknown>;
    buffer = buffer.subarray(end + 4 + size);
    records.push(message);
    if (log) {
      writeFileSync(log + '.tmp', JSON.stringify(records));
      // Windows refuses to replace a file another process is reading: the test polls
      // this log, so wait the read out instead of crashing the server.
      for (let attempt = 0; ; attempt++)
        try {
          renameSync(log + '.tmp', log);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 200)
            throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
    }
    if (message.method === 'textDocument/didChange')
      for (const reply of heldRenames.splice(0)) reply();
    if (message.method === 'textDocument/didOpen')
      texts.set(
        (message.params as any).textDocument.uri,
        (message.params as any).textDocument.text,
      );
    if (message.method === 'textDocument/didChange') {
      texts.set(
        (message.params as any).textDocument.uri,
        (message.params as any).contentChanges[0].text,
      );
      for (const reply of heldDiagnostics.splice(0)) reply();
    }
    if (message.method === 'initialize')
      send(message.id, { capabilities: { textDocumentSync: 1 } });
    else if (message.method === 'textDocument/hover')
      send(message.id, {
        contents: { kind: 'plaintext', value: '文档 hover' },
      });
    else if (message.method === 'textDocument/definition')
      send(message.id, [
        {
          uri: 'file:///definition.ts',
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 1 },
          },
        },
      ]);
    else if (message.method === 'textDocument/completion')
      send(message.id, [{ label: 'unsaved', insertText: 'unsaved', kind: 6 }]);
    else if (message.method === 'textDocument/formatting')
      send(message.id, [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          newText: 'formatted',
        },
      ]);
    else if (message.method === 'textDocument/diagnostic') {
      const text = texts.get((message.params as any).textDocument.uri);
      const history = process.argv.includes('--diagnostic-history');
      const result = {
        kind: 'full',
        items:
          history && text === 'clean'
            ? []
            : [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 },
                  },
                  message: history
                    ? '诊断🙂"\\\n'.repeat(50000)
                    : 'overlay diagnostic',
                  severity: 1,
                },
              ],
      };
      const reply = () => send(message.id, result);
      if (history && text === 'hold') heldDiagnostics.push(reply);
      else reply();
    } else if (message.method === 'textDocument/references')
      setTimeout(() => send(message.id, []), 80);
    else if (
      message.method === 'textDocument/rename' &&
      String((message.params as any).newName).startsWith('held')
    ) {
      const target = new URL(
        'other.py',
        (message.params as any).textDocument.uri,
      ).href;
      const edits = [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          newText: 'renamed',
        },
      ];
      const reply = () =>
        send(
          message.id,
          (message.params as any).newName === 'held-null'
            ? {
                documentChanges: [
                  { textDocument: { uri: target, version: null }, edits },
                ],
              }
            : { changes: { [target]: edits } },
        );
      if ((message.params as any).newName === 'held-stable') reply();
      else heldRenames.push(reply);
    } else if (message.method === 'textDocument/rename')
      send(message.id, {
        changes: {
          [(message.params as any).textDocument.uri]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              newText: (message.params as any).newName,
            },
          ],
        },
      });
    else if (message.method === 'never/respond') {
      /* Deliberately no response to exercise an actual read deadline. */
    } else if (message.id !== undefined) send(message.id, null);
  }
});
