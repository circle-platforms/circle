import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { GatewayModel } from '../src/model.js';
import { ModelCompletionFailure } from '../src/model_completion.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { cleanup, cleanupServer, scratch } from './helpers.js';

// An endpoint whose context is far smaller than its model's catalog window, and that says
// so the way OpenAI does: "too long", with no limit in it.
const LIMIT = 40_000;
const REFUSAL = {
  error: {
    message:
      'Your input exceeds the context window of this model. Please adjust your input and try again.',
    type: 'invalid_request_error',
    code: 'context_length_exceeded',
  },
};
const summarizing = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes(
    'Keep the visible summary within approximately',
  );

// Usage as an endpoint reports it: about a token for every four characters sent
function answer(response: ServerResponse, text: string, size: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    'data: ' +
      JSON.stringify({
        choices: [
          { index: 0, delta: { content: text }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: Math.ceil(size / 4), completion_tokens: 5 },
      }) +
      '\n\ndata: [DONE]\n\n',
  );
}

async function world(t: TestContext, refuseEveryTurn = false) {
  const home = scratch(t);
  const workspace = scratch(t);
  const turns: { size: number; refused: boolean }[] = [];
  let summaries = 0;
  const server = createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    const body = JSON.parse(data) as Record<string, unknown>;
    const size = JSON.stringify(body.messages).length;
    const summary = summarizing(body);
    const refused = summary ? size > LIMIT : refuseEveryTurn || size > LIMIT;
    if (!summary) turns.push({ size, refused });
    else if (!refused) summaries++;
    if (refused) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify(REFUSAL));
    } else
      answer(
        response,
        summary ? 'Summary of the synthetic history.' : 'done',
        size,
      );
  });
  cleanupServer(t, server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  saveCredentials({ api_key: 'synthetic-only' }, home);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    protocol: 'openai',
    base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    model: 'fixture',
  };
  // The catalog's window: five times what the endpoint takes
  settings.models.fixture = {
    context_window: 200_000,
    input_limit: 200_000,
    output_limit: 2048,
  };
  const model = new GatewayModel(settings, home, undefined, {
    wait: async () => {},
  });
  // A conversation over the endpoint's limit, and well under the catalog's compaction point
  const store = new CheckpointStore(home);
  const session = store.create(workspace, 'fixture', 'synthetic refusal');
  store.append(session.id, [
    { id: 'old', role: 'user', content: 'history '.repeat(12_000) },
    { id: 'done-before', role: 'assistant', content: 'The old task is done.' },
  ]);
  store.close();
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings,
    model,
    session: session.id,
    headless: true,
    localContext: false,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  return { runtime, model, turns, summaries: () => summaries };
}

test('a request the endpoint refuses as too long is compacted and sent once more, and the context is known smaller', async (t) => {
  const { runtime, model, turns, summaries } = await world(t);
  assert.ok(model.contextWindow >= 200_000);
  const { answer } = await runtime.harness.run('go on');
  assert.equal(answer, 'done');
  // Refused once at full size; the conversation was summarized; the same step then fit
  assert.equal(turns.length, 2, JSON.stringify(turns));
  assert.equal(turns[0]!.refused, true);
  assert.equal(turns[1]!.refused, false);
  assert.ok(turns[1]!.size < LIMIT, JSON.stringify(turns));
  assert.ok(summaries() > 0);
  // The model now holds no larger a context than the request it saw refused
  assert.ok(model.contextWindow < 200_000, String(model.contextWindow));
  const compaction = runtime.store.compactions
    .operations(runtime.session.id)
    .at(-1);
  assert.equal(compaction?.snapshot.status, 'succeeded');
  assert.equal(compaction?.snapshot.trigger, 'auto');
});

test('a step refused again and again ends the turn once compaction can make it no smaller', async (t) => {
  const { runtime, turns } = await world(t, true);
  await assert.rejects(
    runtime.harness.run('go on'),
    (error: unknown) =>
      error instanceof ModelCompletionFailure && error.code === 'context_limit',
  );
  // Each try was compacted to less than the one refused before it, and the turn stopped
  // within the bound instead of trying forever
  assert.ok(turns.length >= 2 && turns.length <= 6, JSON.stringify(turns));
  assert.ok(turns.every((turn) => turn.refused));
  for (let index = 1; index < turns.length; index++)
    assert.ok(
      turns[index]!.size < turns[index - 1]!.size,
      JSON.stringify(turns),
    );
});

test('a failed turn carries the words the endpoint said, for the person to read and report', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  // A model that refuses as too long and learns nothing from it: the same request goes
  // again, is refused again, and the turn ends with the endpoint's own words
  const refuse = async () => {
    const failure = new ModelCompletionFailure('context_limit');
    failure.providerError = {
      code: REFUSAL.error.code,
      message: `400 ${REFUSAL.error.message}`,
    };
    throw failure;
  };
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings: defaultSettings(),
    model: new ScriptedModel([refuse, refuse]),
    headless: true,
    localContext: false,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  const errors: Record<string, unknown>[] = [];
  runtime.harness.bus.subscribe((event) => {
    if (event.kind === 'run_error') errors.push(event.payload);
  });
  await assert.rejects(runtime.harness.run('go on'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.completion_failure, 'context_limit');
  assert.deepEqual(errors[0]!.provider_error, {
    code: 'context_length_exceeded',
    message: `400 ${REFUSAL.error.message}`,
  });
});
