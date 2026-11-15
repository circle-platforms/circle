import { createInterface } from 'node:readline';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
// How it answers Circle's question for its revision (server/discover): with the 2026-07-28 revision (TEST_MODERN),
// by exiting as some servers of the older revision do (TEST_EXIT_ON_PROBE), not at all (TEST_SILENT_PROBE), or as
// a method it does not know, as any request it has no answer for. TEST_PROBE_LOG names a file each question is noted
// in.
const modern = process.env.TEST_MODERN === '1';
const pending = new Map<unknown, NodeJS.Timeout>();
const input = createInterface({ input: process.stdin, terminal: false });
// A result on the 2026-07-28 revision names its kind, and a list says how long it stays good
let revision = '';
let method = '';
const send = (id: unknown, result: unknown): void => {
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      result:
        revision && result && typeof result === 'object'
          ? {
              resultType: 'complete',
              ...(method === 'tools/list'
                ? { ttlMs: 0, cacheScope: 'private' }
                : {}),
              ...result,
            }
          : result,
    }) + '\n',
  );
};
const fail = (id: unknown, code: number, message: string): void => {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
  );
};
for await (const line of input) {
  const request = JSON.parse(line) as {
    id?: number;
    method: string;
    params?: Record<string, unknown>;
  };
  const meta = request.params?._meta as Record<string, unknown> | undefined;
  revision =
    typeof meta?.['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? String(meta['io.modelcontextprotocol/protocolVersion'])
      : '';
  method = request.method;
  if (request.method === 'server/discover') {
    if (process.env.TEST_PROBE_LOG)
      appendFileSync(process.env.TEST_PROBE_LOG, `${process.pid}\n`);
    if (process.env.TEST_EXIT_ON_PROBE === '1') process.exit(1);
    if (process.env.TEST_SILENT_PROBE === '1') continue;
    if (modern)
      send(request.id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: 'test-server',
            version: '1',
          },
        },
      });
    else fail(request.id, -32601, 'Method not found');
  } else if (request.method === 'initialize')
    send(request.id, {
      protocolVersion: request.params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'test-server', version: '1' },
      // Read at each start, so a test can change them between connections
      ...(process.env.TEST_INSTRUCTIONS_FILE
        ? {
            instructions: readFileSync(
              process.env.TEST_INSTRUCTIONS_FILE,
              'utf8',
            ),
          }
        : {}),
    });
  else if (request.method === 'tools/list')
    send(request.id, {
      tools: [
        {
          name: 'media',
          description: 'Return image and PDF fixtures.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'write_receipt',
          description: 'Write an observable test receipt.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              delay: { type: 'integer' },
            },
            required: ['path'],
          },
        },
        {
          name: 'environment',
          description: 'Inspect the isolated test process.',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'failure',
          description: 'Return an MCP error.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'login.wait',
          description: 'Answer once a file exists, however long that takes.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              started: { type: 'string' },
            },
            required: ['path'],
          },
        },
        {
          name: 'checksum',
          description: 'Say how long a file is, and which process read it.',
          inputSchema: {
            type: 'object',
            properties: { file: { type: 'string', contentEncoding: 'base64' } },
            required: ['file'],
          },
          annotations: { idempotentHint: true },
        },
      ],
    });
  else if (request.method === 'tools/call') {
    const name = request.params?.name;
    const args =
      (request.params?.arguments as {
        path?: string;
        delay?: number;
        started?: string;
      }) || {};
    if (name === 'environment')
      send(request.id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              pid: process.pid,
              ambient: process.env.OPENAI_API_KEY,
              supplied: process.env.TEST_SUPPLIED,
              project: process.env.CIRCLE_PROJECT_DIR,
              args: process.argv.slice(2),
            }),
          },
        ],
      });
    else if (name === 'media')
      send(request.id, {
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xkAAAAASUVORK5CYII=',
          },
          {
            type: 'resource',
            resource: {
              uri: 'file:///fixture.pdf',
              mimeType: 'application/pdf',
              blob: Buffer.from('%PDF-1.4\nfixture\n%%EOF').toString('base64'),
            },
          },
        ],
      });
    else if (name === 'failure')
      send(request.id, {
        isError: true,
        content: [{ type: 'text', text: 'fixture error' }],
      });
    else if (name === 'checksum')
      send(request.id, {
        content: [
          {
            type: 'text',
            text: `${Buffer.from(String((args as { file?: string }).file), 'base64').length} bytes read by ${process.pid}`,
          },
        ],
      });
    else if (name === 'login.wait') {
      if (args.started) writeFileSync(args.started, '');
      const poll = setInterval(() => {
        if (!existsSync(args.path!)) return;
        clearInterval(poll);
        pending.delete(request.id);
        send(request.id, { content: [{ type: 'text', text: 'logged in' }] });
      }, 10);
      pending.set(request.id, poll);
    } else if (name === 'write_receipt') {
      const finish = (): void => {
        writeFileSync(args.path!, 'MCP wrote this');
        pending.delete(request.id);
        send(request.id, { content: [{ type: 'text', text: 'written' }] });
      };
      if (args.delay) pending.set(request.id, setTimeout(finish, args.delay));
      else finish();
    }
  } else if (request.method === 'notifications/cancelled') {
    const id = request.params?.requestId;
    const timer = pending.get(id);
    if (timer) clearTimeout(timer);
    pending.delete(id);
  } else if (request.id !== undefined)
    fail(request.id, -32601, 'Method not found');
}
for (const timer of pending.values()) clearTimeout(timer);
