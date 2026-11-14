// A server on the 2026-07-28 revision asks for input by answering a call with `input_required` rather than by a
// request of its own: Circle answers each question as it answers `elicitation/create` (the question panel, or a hook in
// the person's place, or a cancel where no one can be asked) and makes the call again with the answers and the
// server's `requestState` as it was. Checked on what the server received.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpManager } from '../src/mcp_loader.js';
import { cleanup, scratch } from './helpers.js';
import { mcpStub, type McpStub, type StubRequest } from './mcp-stub.js';

const confirm = {
  method: 'elicitation/create',
  params: {
    mode: 'form',
    message: 'Deploy to production?',
    requestedSchema: {
      type: 'object',
      properties: { approved: { type: 'boolean', title: 'Approved' } },
      required: ['approved'],
    },
  },
};
/** A server whose `deploy` asks first, then says what it was answered. */
async function deployer(t: Parameters<typeof scratch>[0]): Promise<McpStub> {
  return mcpStub(t, {
    modern: true,
    tools: [
      { name: 'deploy', inputSchema: { type: 'object', properties: {} } },
    ],
    call: (request: StubRequest) => {
      const params = request.message!.params!;
      if (!params.inputResponses)
        return {
          resultType: 'input_required',
          inputRequests: { confirm },
          requestState: 'state-1:opaque',
        } as never;
      return {
        content: [
          {
            type: 'text',
            text: `deployed with ${JSON.stringify(params.inputResponses)} and ${String(params.requestState)}`,
          },
        ],
      };
    },
  });
}
async function deploy(
  t: Parameters<typeof scratch>[0],
  stub: McpStub,
  services: ConstructorParameters<typeof McpManager>[3],
): Promise<string> {
  const manager = new McpManager(scratch(t), 10_000, undefined, services);
  cleanup(t, () => manager.close());
  await manager.load({ ops: { type: 'http', url: stub.url } });
  assert.equal(manager.status[0]!.error, '', manager.describe());
  return String(
    await manager.tools[0]!.run(
      {},
      { sessionId: 'one', signal: new AbortController().signal },
    ),
  );
}

test("a call answered with input_required is made again with the person's answer and the server's state as it was", async (t) => {
  const stub = await deployer(t);
  const asked: Record<string, any>[] = [];
  const text = await deploy(t, stub, {
    ask: async (args) => {
      asked.push(args);
      return JSON.stringify(['yes', 'send']);
    },
  });
  assert.match(
    text,
    /^deployed with \{"confirm":\{"action":"accept","content":\{"approved":true\}\}\} and state-1:opaque$/,
  );
  // Asked in the question panel as a server's question in a call always is
  assert.equal(asked.length, 1);
  assert.match(
    asked[0]!.questions[0].question,
    /^ops asks: Deploy to production\?/,
  );
  // Two calls: the first, then the same call again under a new id with the answers and the state
  const [first, again] = stub.calls();
  assert.equal(stub.calls().length, 2);
  assert.notEqual(first!.message!.id, again!.message!.id);
  assert.equal(first!.message!.params!.inputResponses, undefined);
  assert.deepEqual(again!.message!.params!.arguments, {});
  assert.equal(again!.message!.params!.requestState, 'state-1:opaque');
});

test("an Elicitation hook answers in the person's place; where no one can be asked the question is cancelled", async (t) => {
  const hooked = await deploy(t, await deployer(t), {
    ask: async () => {
      throw new Error('the person is not asked');
    },
    elicitationHooks: {
      before: async (request) => {
        assert.equal(request.server, 'ops');
        assert.equal(request.message, 'Deploy to production?');
        return { action: 'accept', content: { approved: false } };
      },
      after: async () => undefined,
    },
  });
  assert.match(
    hooked,
    /\{"confirm":\{"action":"accept","content":\{"approved":false\}\}\}/,
  );
  const nobody = await deploy(t, await deployer(t), {});
  assert.match(nobody, /\{"confirm":\{"action":"cancel"\}\}/);
});
