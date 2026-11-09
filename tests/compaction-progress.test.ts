import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CheckpointStore } from '../src/checkpoint_store.js';
import type { CompactionEvent } from '../src/compaction.js';
import { ContextManager } from '../src/context_middleware.js';
import { GatewayModel } from '../src/model.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { cleanup, cleanupServer, scratch } from './helpers.js';

// A summary written in two pieces, with a pause between them: the compaction's progress
// moves as it is written, never steps back, and is complete only once it succeeds.
test('compaction progress follows the summary as it is written', async (t) => {
  const home = scratch(t);
  const server = createServer(async (request, response) => {
    for await (const _ of request);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const piece = (text: string, finish: string | null) =>
      'data: ' +
      JSON.stringify({
        choices: [
          { index: 0, delta: { content: text }, finish_reason: finish },
        ],
        ...(finish
          ? { usage: { prompt_tokens: 3000, completion_tokens: 300 } }
          : {}),
      }) +
      '\n\n';
    response.write(piece('Summary first half. '.repeat(30), null));
    await delay(250);
    response.end(
      piece('Summary second half. '.repeat(30), 'stop') + 'data: [DONE]\n\n',
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
  settings.models.fixture = {
    context_window: 32000,
    input_limit: 32000,
    output_limit: 2048,
  };
  const model = new GatewayModel(settings, home, undefined, {
    wait: async () => {},
  });
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const session = store.create(home, 'fixture', 'synthetic progress');
  store.claimSession(session.id);
  store.append(session.id, [
    { id: 'old', role: 'user', content: 'history '.repeat(3000) },
    { id: 'answer', role: 'assistant', content: 'The old task is complete.' },
    { id: 'current', role: 'user', content: 'Continue.' },
  ]);
  const events: CompactionEvent[] = [];
  const context = new ContextManager(store, join(home, 'data'), {
    progress: (event) => events.push(event),
  });
  await context.compact(session.id, model, new AbortController().signal);
  const shown = events
    .map((event) => event.snapshot)
    .filter((snapshot) => snapshot !== undefined)
    .map((snapshot) => ({
      status: snapshot!.status,
      stage: snapshot!.stage,
      progress: snapshot!.progress ?? 0,
    }));
  assert.equal(shown.at(-1)!.status, 'succeeded');
  assert.equal(shown.at(-1)!.progress, 1);
  // Under way, the written half shows: more than nothing, less than complete
  const writing = shown.filter(
    (row) => row.status === 'running' && row.progress > 0 && row.progress < 1,
  );
  assert.ok(writing.length > 0, JSON.stringify(shown));
  // Never back, and complete only at success
  for (let index = 1; index < shown.length; index++)
    assert.ok(
      shown[index]!.progress >= shown[index - 1]!.progress,
      JSON.stringify(shown),
    );
  assert.ok(
    shown
      .filter((row) => row.status === 'running')
      .every((row) => row.progress < 1),
    JSON.stringify(shown),
  );
});
