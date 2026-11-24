// A format a schema names that its validator has no check for is for whoever wrote the schema to check (JSON Schema
// treats a format as an annotation), and the validator's notice for it is printed to standard error, over the screen
// of the terminal, for every such format of every schema it compiles: nothing of it is written. These are the
// validators that read the documents of Circle's own sync protocol, and the one that checks the structure of an MCP
// tool's result against the output schema its server listed. A format the validator does check stays checked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, realpathSync } from 'node:fs';
import { McpManager, UNDECLARED_STRUCTURE } from '../src/mcp_loader.js';
import { parseDiscovery } from '../src/server_resolution.js';
import { validateAnswer, validateSync } from '../src/knowledge/protocol.js';
import {
  QuietJsonSchemaValidator,
  ajvLogger,
  isUnknownFormatNotice,
  withoutUnknownFormatNotices,
} from '../src/schema_formats.js';
import { scratch } from './helpers.js';
import { mcpStub } from './mcp-stub.js';

const vector = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `./fixtures/knowledge-sync/v1-capabilities/${name}`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
/**
 * The text a run writes to the terminal: what reaches either stream, the console's included. Every write goes on to
 * the stream as it did, and only text counts: the test runner reports on standard output in bytes of its own.
 */
async function captured<T>(
  run: () => T | Promise<T>,
): Promise<{ result: T; written: string[] }> {
  const written: string[] = [];
  const restore: (() => void)[] = [];
  for (const [name, stream] of [
    ['stdout', process.stdout],
    ['stderr', process.stderr],
  ] as const) {
    const write = stream.write;
    stream.write = function (this: unknown, chunk: unknown, ...rest: never[]) {
      if (typeof chunk === 'string') written.push(`${name}: ${chunk}`);
      return (write as (...args: unknown[]) => boolean).call(
        stream,
        chunk,
        ...rest,
      );
    } as typeof stream.write;
    restore.push(() => {
      stream.write = write;
    });
  }
  try {
    return { result: await run(), written };
  } finally {
    for (const undo of restore) undo();
  }
}
const context = () => ({
  sessionId: 'one',
  signal: new AbortController().signal,
});

// This test is the first in its process to read these documents: a compiled schema is kept, so a notice would be
// printed only for the first.
test('the documents of the sync protocol name `uri`, which Circle has no check for, and reading them writes nothing', async () => {
  const discovery = vector('discovery.json');
  const found = await captured(() =>
    parseDiscovery(discovery, 'https://192.0.2.10/mcp'),
  );
  assert.equal(found.result.source, 'document');
  assert.deepEqual(found.written, []);
  // The same schema compiled for what Circle sends, and another document that names a `uri`
  assert.deepEqual(
    (
      await captured(() =>
        validateSync('knowledge-sync-discovery@1', discovery),
      )
    ).written,
    [],
  );
  const refusal = vector('errors.json').errors.find(
    (error: { name: string }) => error.name === 'purge-confirmation-required',
  ).body;
  assert.deepEqual(
    (await captured(() => validateAnswer('personal-sync-error@1', refusal)))
      .written,
    [],
  );
});

test('a format the sync protocol does check, a time, is still checked, and a document that fails still fails', async () => {
  const refusal = structuredClone(
    vector('errors.json').errors.find(
      (error: { name: string }) => error.name === 'purge-confirmation-required',
    ).body,
  );
  validateAnswer('personal-sync-error@1', refusal);
  refusal.confirmation.expires_at = 'tomorrow';
  const { written } = await captured(() => {
    assert.throws(
      () => validateAnswer('personal-sync-error@1', refusal),
      /invalid personal sync: schema personal-sync-error@1/,
    );
  });
  assert.deepEqual(written, []);
  assert.throws(
    () =>
      parseDiscovery(
        { issuer: 'https://192.0.2.10' },
        'https://192.0.2.10/mcp',
      ),
    /not knowledge-sync-discovery@1/,
  );
});

const OUTPUT = {
  type: 'object',
  properties: {
    issuer: { type: 'string', format: 'uri' },
    // Neither the library's validator nor Circle has a check for this one
    handle: { type: 'string', format: 'x-circle-handle' },
  },
  required: ['issuer'],
};
async function hubWith(
  t: Parameters<typeof scratch>[0],
  structuredContent: unknown,
) {
  const stub = await mcpStub(t, {
    tools: [
      {
        name: 'hub_info',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: OUTPUT,
      },
    ],
    call: () => ({
      content: [{ type: 'text', text: 'hub info' }],
      structuredContent,
    }),
  });
  const mcp = new McpManager(realpathSync.native(scratch(t)));
  t.after(() => mcp.close());
  return { stub, mcp };
}

test('a tool whose output schema names formats is listed and called through the client, and formats nobody checks write nothing', async (t) => {
  const { stub, mcp } = await hubWith(t, {
    issuer: 'https://192.0.2.10',
    handle: 'h1',
  });
  const { result, written } = await captured(async () => {
    await mcp.load({ hub: { url: stub.url, type: 'http' } });
    return mcp.tools[0]!.run({}, context());
  });
  assert.equal(mcp.status[0]?.error, '', mcp.describe());
  assert.equal(result, 'hub info');
  assert.deepEqual(written, []);
});

test('a result that does not match the listed schema is still said so, also by a format the library checks', async (t) => {
  const { stub, mcp } = await hubWith(t, { issuer: 'not a uri' });
  const { result, written } = await captured(async () => {
    await mcp.load({ hub: { url: stub.url, type: 'http' } });
    return mcp.tools[0]!.run({}, context());
  });
  assert.equal(
    result,
    `hub info\n\n${UNDECLARED_STRUCTURE}\n{"issuer":"not a uri"}`,
  );
  assert.deepEqual(written, []);
});

test('only the notice for a format with no check is left out: any other message, and every error, reaches the console and the caller', async (t) => {
  const notice =
    'unknown format "iri" ignored in schema at path "#/properties/a"';
  assert.equal(isUnknownFormatNotice([notice]), true);
  for (const other of [
    'unknown keyword "x"',
    'strict mode: unknown keyword',
    'unknown format "iri" is not ignored',
    `${notice}\nand more`,
  ])
    assert.equal(isUnknownFormatNotice([other]), false, other);
  assert.equal(isUnknownFormatNotice([notice, 'second']), false);
  assert.equal(isUnknownFormatNotice([42]), false);

  const seen: string[] = [];
  for (const name of ['log', 'warn', 'error'] as const)
    t.mock.method(console, name, (...args: unknown[]) => {
      seen.push(`${name}: ${args.join(' ')}`);
    });
  ajvLogger.warn(notice);
  ajvLogger.warn('another notice');
  ajvLogger.error('Error compiling schema, function code:', 'code');
  ajvLogger.log('plain');
  assert.deepEqual(seen, [
    'warn: another notice',
    'error: Error compiling schema, function code: code',
    'log: plain',
  ]);

  seen.length = 0;
  const value = withoutUnknownFormatNotices(() => {
    console.warn(notice);
    console.warn('from the same call');
    return 'compiled';
  });
  assert.equal(value, 'compiled');
  assert.deepEqual(seen, ['warn: from the same call']);
  const before = console.warn;
  assert.throws(
    () =>
      withoutUnknownFormatNotices(() => {
        throw new Error('does not compile');
      }),
    /does not compile/,
  );
  assert.equal(console.warn, before, 'the console is given back after a throw');

  // A schema that cannot be compiled still throws; one that names a format compiles and checks what it knows
  const validator = new QuietJsonSchemaValidator();
  assert.throws(() =>
    validator.getValidator({
      type: 'object',
      properties: { a: { $ref: '#/definitions/missing' } },
    } as never),
  );
  const check = validator.getValidator({
    type: 'object',
    properties: {
      a: { type: 'string', format: 'uri' },
      b: { type: 'string', format: 'x-unknown' },
    },
  } as never);
  assert.equal(check({ a: 'https://192.0.2.10', b: 'anything' }).valid, true);
  assert.equal(check({ a: 'no' }).valid, false);
});
