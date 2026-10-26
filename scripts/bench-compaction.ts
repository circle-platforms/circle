import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { CheckpointStore, emptyContextState } from '../src/checkpoint_store.js';
import { ContextManager } from '../src/context_middleware.js';
import { summaryTranscript } from '../src/compaction_engine.js';
import { summaryMessages } from '../src/media.js';
import { tokenLen } from '../src/middleware/tool_result_prune.js';
import type { ChatModel, Message } from '../src/types.js';
import { requestBudget, contentHash } from '../src/request_budget.js';

// Offline mechanism benchmark. The scripted summaries validate named-fact
// transport and coverage, not the quality or latency of any real model.
const root = mkdtempSync(join(tmpdir(), 'circle-compaction-bench-'));
const store = new CheckpointStore(root);
const session = store.create(root, 'synthetic-benchmark');
store.claimSession(session.id);
const messages: Message[] = [];
for (let n = 0; n < 1200; n++) {
  const fact = n % 100 === 0 ? ` FACT_${n} ` : '';
  messages.push(
    { id: 'u-' + n, role: 'user', content: 'Continue synthetic work.' },
    {
      id: 'a-' + n,
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-' + n,
          name: 'read_file',
          args: { path: `fixture-${n}.ts` },
        },
      ],
      provider_content: [
        {
          type: 'tool_use',
          id: 'call-' + n,
          name: 'read_file',
          input: { path: `fixture-${n}.ts` },
        },
      ],
      thinking: 'private synthetic reasoning '.repeat(15),
      usage: {
        input_tokens: 500000 + n,
        output_tokens: 100,
        cache_read_tokens: 400000,
      },
      completion: {
        reason: 'tool_calls',
        provider_reason: 'tool_use',
        output_limit: 32000,
      },
    },
    {
      id: 'r-' + n,
      role: 'tool',
      tool_call_id: 'call-' + n,
      name: 'read_file',
      status: 'success',
      content:
        'synthetic source '.repeat(180) + fact + ' synthetic tail '.repeat(40),
    },
  );
}
messages.push({
  id: 'current',
  role: 'user',
  content: 'Continue and retain every FACT marker.',
});
store.append(session.id, messages);
const originalChecksum = contentHash(store.messages(session.id));
let requests = 0,
  inputBytes = 0,
  maximumFrame = 0,
  maximumSnapshot = 0;
const model: ChatModel = {
  model: 'synthetic-benchmark',
  contextWindow: 1000000,
  outputLimit: 128000,
  outputBudget: 32000,
  sideRequests: true,
  complete: async (request) => {
    requests++;
    const text = request.messages.map((m) => m.content).join('\n');
    const bytes = Buffer.byteLength(
      JSON.stringify({
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        maxTokens: request.maxTokens,
      }),
    );
    inputBytes += bytes;
    maximumFrame = Math.max(maximumFrame, bytes);
    const budget = requestBudget(model, request);
    assert.equal(budget.fits, true);
    const facts = [...new Set(text.match(/FACT_\d+/g))];
    const summary =
      facts.join(' ') ||
      'No additional named facts in this synthetic fragment.';
    request.token(summary);
    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: summary,
        completion: { reason: 'stop' },
      },
      usage: {
        input_tokens: tokenLen(text),
        output_tokens: tokenLen(summary),
        cache_read_tokens: 0,
      },
    };
  },
};
const manager = new ContextManager(store, join(root, 'data'), {
  progress: (event) => {
    maximumSnapshot = Math.max(
      maximumSnapshot,
      Buffer.byteLength(JSON.stringify(event.snapshot)),
    );
  },
});
try {
  const before = performance.now();
  await manager.compact(session.id, model, new AbortController().signal);
  const elapsed = performance.now() - before;
  const firstRequests = requests;
  const summary = store.contextState(session.id).summary!;
  const projected = manager
    .project(session.id)
    .map((m) => m.content)
    .join('\n');
  const requiredFacts = [
    ...new Set(
      messages
        .map((m) => m.content)
        .join('\n')
        .match(/FACT_\d+/g),
    ),
  ].filter((f) => f !== 'FACT_');
  assert.ok(requiredFacts.every((f) => projected.includes(f)));
  assert.ok(
    maximumSnapshot < 4096,
    'progress transport is independent of history size',
  );
  store.setContextState(session.id, emptyContextState());
  const replayStart = performance.now();
  await manager.compact(session.id, model, new AbortController().signal);
  const report = {
    kind: 'offline synthetic benchmark; not a real-model quality or network-latency comparison',
    messages: messages.length,
    sourceBytes: Buffer.byteLength(JSON.stringify(messages)),
    legacySummarySerializationBytes: Buffer.byteLength(
      JSON.stringify(summaryMessages(messages)),
    ),
    contentOnlySerializationBytes: Buffer.byteLength(
      messages.map(summaryTranscript).join('\n\n'),
    ),
    firstRun: {
      localMilliseconds: elapsed,
      requests: firstRequests,
      totalRequestBytes: inputBytes,
      maximumRequestBytes: maximumFrame,
    },
    repeatSameHistory: {
      localMilliseconds: performance.now() - replayStart,
      requests: requests - firstRequests,
    },
    maximumProgressSnapshotBytes: maximumSnapshot,
    namedFactsPreserved: requiredFacts.length,
    allNamedFactsPreserved: true,
    rawMessagesPreserved:
      contentHash(store.messages(session.id)) === originalChecksum,
    originalChecksum,
    summaryCharacters: summary.text.length,
  };
  assert.equal(requests - firstRequests, 0, 'same successful work is reused');
  assert.equal(
    report.rawMessagesPreserved,
    true,
    'raw history is unchanged byte for byte',
  );
  assert.ok(
    report.contentOnlySerializationBytes <
      report.legacySummarySerializationBytes,
  );
  mkdirSync('outputs', { recursive: true });
  writeFileSync(
    'outputs/compaction-benchmark.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
