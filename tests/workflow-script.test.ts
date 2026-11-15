import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_FAN_OUT,
  ScriptWorker,
  WorkflowScriptError,
  prepareWorkflowScript,
  type ScriptHost,
} from '../src/workflow_script.js';
import {
  maxWorkflowAgents,
  schemaContradiction,
  structuredOutputAttempts,
  agentStallMs,
  workflowSummary,
} from '../src/workflows.js';

// A workflow script on its own: its meta, what it may not do, and its API, with a host that answers by hand

const META = `export const meta = { name: 'try', description: 'A script under test' }\n`;
/**
 * Runs a script in its worker against a host that answers each agent() call from `answer` (or fails it),
 * one at a time and only once the script waits, until the script ends.
 */
async function runScript(
  body: string,
  answer: (prompt: string, options: Record<string, unknown>) => unknown = (
    prompt,
  ) => `answer to ${prompt}`,
  options: {
    args?: unknown;
    sliceMs?: number;
    memoryMb?: number;
    fail?: (prompt: string) => string | undefined;
  } = {},
) {
  const prepared = prepareWorkflowScript(META + body, 'try.js');
  const asked: { prompt: string; options: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const phases: string[] = [];
  const pending: {
    id: number;
    prompt: string;
    options: Record<string, unknown>;
  }[] = [];
  let outcome: { json?: string } | { error: string } | undefined;
  let worker!: ScriptWorker;
  await new Promise<void>((resolve) => {
    const host: ScriptHost = {
      agent: (id, spec) => {
        const { prompt, options } = JSON.parse(spec);
        asked.push({ prompt, options });
        pending.push({ id, prompt, options });
      },
      phase: (title) => phases.push(title),
      log: (message) => logs.push(message),
      done: (json) => {
        outcome = { json };
        resolve();
      },
      failed: (message) => {
        outcome = { error: message };
        resolve();
      },
      idle: () => {
        const next = pending.shift();
        if (!next) return;
        const failure = options.fail?.(next.prompt);
        worker.settle(
          next.id,
          failure !== undefined
            ? { error: failure }
            : { json: JSON.stringify(answer(next.prompt, next.options)) },
          7,
        );
      },
    };
    worker = new ScriptWorker(prepared, host, {
      args: options.args,
      sliceMs: options.sliceMs ?? 5000,
      ...(options.memoryMb ? { memoryMb: options.memoryMb } : {}),
    });
    worker.start();
  });
  worker.end();
  return {
    asked,
    logs,
    phases,
    outcome,
    value: () => {
      assert.ok(outcome && 'json' in outcome, JSON.stringify(outcome));
      return outcome.json === undefined ? undefined : JSON.parse(outcome.json);
    },
  };
}

test('meta is read as a plain literal at the top, and its name, description and phases are checked', () => {
  const { meta } = prepareWorkflowScript(
    `// a saved workflow
export const meta = {
  name: 'audit-routes',
  description: "Audit every route",
  whenToUse: \`after a route changes\`,
  phases: [{ title: 'Find', detail: 'list them', model: 'small' }, 'Audit', { title: 'Find' }],
  'quoted key': [1, -2.5, 0x10, true, null,],
};
return 1
`,
    'audit.js',
  );
  assert.deepEqual(meta, {
    name: 'audit-routes',
    description: 'Audit every route',
    whenToUse: 'after a route changes',
    phases: [
      { title: 'Find', detail: 'list them', model: 'small' },
      { title: 'Audit' },
    ],
  });
  for (const [source, why] of [
    [
      `export const meta = { name: 'x', description: 'y', phases: [title] }`,
      /audit\.js:1: meta must be a plain literal, and the name title is not one/,
    ],
    [
      `export const meta = { name: 'x', description: 'y', ...more }`,
      /a spread is not one/,
    ],
    [
      `export const meta = { name: 'x', description: \`y \${1}\` }`,
      /a template with \$\{…\} is not one/,
    ],
    [
      `export const meta = { name: 'x', description: 'y', f() {} }`,
      /the method f\(\) is not one/,
    ],
    [
      `export const meta = { name: 'x', description: 'y', [k]: 1 }`,
      /a computed key is not one/,
    ],
    [
      `export const meta = { name: 'x', description: String(1) }`,
      /the name String is not one/,
    ],
    [
      `const x = 1\nexport const meta = { name: 'x', description: 'y' }`,
      /begins with export const meta/,
    ],
    [
      `export const meta = { name: 'two words', description: 'y' }`,
      /meta\.name must be a name/,
    ],
    [`export const meta = { name: 'x' }`, /meta\.description must say/],
    [
      `export const meta = { name: 'x', description: 'y', phases: [{}] }`,
      /needs a title/,
    ],
  ] as const)
    assert.throws(
      () => prepareWorkflowScript(source, 'audit.js'),
      (error: unknown) =>
        error instanceof WorkflowScriptError && why.test(error.message),
      source,
    );
});

test('a script that imports, or does not parse, is refused before it runs, with its line', () => {
  for (const body of [
    `const fs = await import('node:fs')`,
    `import fs from 'node:fs'`,
    `const where = import.meta.url`,
  ])
    assert.throws(
      () => prepareWorkflowScript(META + `\n${body}\n`, 'imports.js'),
      /^WorkflowScriptError: imports\.js:3: a workflow script cannot import/,
    );
  // A key, a property or a string named import is no import
  assert.ok(
    prepareWorkflowScript(
      META +
        `const o = { import: 1 }; const s = "import('x')"; const t = \`import(\${o.import})\`; return o.import`,
    ),
  );
  assert.throws(
    () =>
      prepareWorkflowScript(
        META + 'const a = {\n  b: 1\n  c: 2 }\n',
        'broken.js',
      ),
    /broken\.js:4: Unexpected identifier 'c'/,
  );
});

test('the API runs agents in the order they are called, parallel and pipeline give null for what threw, and the value comes back', async () => {
  const run = await runScript(
    `phase('Find')
const found = await agent('list', { schema: { type: 'object' }, label: 'lister' })
log({ found: found.files.length })
phase('Check')
const checked = await pipeline(
  found.files,
  (file) => agent('check ' + file, { phase: 'Check' }),
  (answer, file, index) => { if (index === 1) throw new Error('drop ' + file); return answer + '!' },
)
const both = await parallel([() => agent('one'), () => { throw new Error('two') }, 3])
return { checked, both, args, spent: budget.spent(), total: budget.total }`,
    (prompt) =>
      prompt === 'list' ? { files: ['a', 'b', 'c'] } : `ok ${prompt}`,
    { args: { since: '2026-11-15' } },
  );
  assert.deepEqual(
    run.asked.map((call) => call.prompt),
    ['list', 'check a', 'check b', 'check c', 'one'],
  );
  assert.deepEqual(run.asked[0]!.options, {
    schema: { type: 'object' },
    label: 'lister',
  });
  assert.deepEqual(run.phases, ['Find', 'Check']);
  assert.deepEqual(run.logs, ['{"found":3}']);
  assert.deepEqual(run.value(), {
    checked: ['ok check a!', null, 'ok check c!'],
    both: ['ok one', null, 3],
    args: { since: '2026-11-15' },
    spent: 7,
    total: null,
  });
});

test('an agent call that fails rejects: awaited directly it ends the script, inside parallel it is null', async () => {
  const direct = await runScript(
    `await agent('a'); return await agent('b')`,
    undefined,
    {
      fail: (prompt) =>
        prompt === 'b' ? 'agent stalled on all 6 attempts' : undefined,
    },
  );
  assert.match(
    (direct.outcome as { error: string }).error,
    /^agent stalled on all 6 attempts/,
  );
  const fanned = await runScript(
    `return await parallel([() => agent('a'), () => agent('b')])`,
    undefined,
    { fail: (prompt) => (prompt === 'b' ? 'no' : undefined) },
  );
  assert.deepEqual(fanned.value(), ['answer to a', null]);
});

test('calls that would make a run unrepeatable throw, and the script reaches nothing of Node or of the runtime', async () => {
  const run = await runScript(`
const tries = {
  now: () => Date.now(),
  date: () => new Date(),
  dateCall: () => Date(),
  random: () => Math.random(),
  intl: () => new Intl.DateTimeFormat('en').format(),
  intlParts: () => new Intl.DateTimeFormat('en').formatToParts(),
  require: () => require('node:fs'),
  process: () => process.env,
  timer: () => setTimeout(() => {}, 1),
  fetch: () => fetch('http://example.invalid'),
  escape: () => agent.constructor.constructor('return process')(),
  global: () => globalThis.constructor.constructor('return process')(),
  evalCode: () => eval('1 + 1'),
  wasm: () => WebAssembly,
  atomics: () => Atomics,
  workflow: () => workflow('other'),
}
const seen = {}
for (const [name, call] of Object.entries(tries)) {
  try {
    const value = call()
    seen[name] = value instanceof Promise ? 'promise' : 'ran'
  } catch (error) {
    seen[name] = error.constructor.name + ': ' + error.message.slice(0, 40)
  }
}
seen.fixedDate = new Date(0).toISOString()
seen.utc = Date.UTC(2026, 10, 15)
seen.formatted = new Intl.DateTimeFormat('en', { timeZone: 'UTC' }).format(new Date(0))
return seen`);
  const seen = run.value();
  assert.match(seen.now, /^Error: Date\.now\(\) is not available in a workf/);
  assert.match(seen.date, /^Error: new Date\(\) without an argument is/);
  assert.match(seen.dateCall, /^Error: Date\(\) is not available in a workflo/);
  assert.match(seen.random, /^Error: Math\.random\(\) is not available in a/);
  assert.match(seen.intl, /^Error: formatting the current time is not/);
  assert.match(seen.intlParts, /^Error: formatting the current time is not/);
  for (const name of [
    'require',
    'process',
    'timer',
    'fetch',
    'wasm',
    'atomics',
  ])
    assert.match(seen[name], /^ReferenceError: \w+ is not defined/, name);
  for (const name of ['escape', 'global', 'evalCode'])
    assert.match(
      seen[name],
      /^EvalError: Code generation from strings disallowed/,
      name,
    );
  assert.equal(seen.workflow, 'promise');
  assert.equal(seen.fixedDate, '1970-01-01T00:00:00.000Z');
  assert.equal(seen.utc, Date.UTC(2026, 10, 15));
  assert.equal(seen.formatted, '1/1/1970');
});

test('a script that runs on without waiting for an agent, or takes too much memory, is stopped, and a long list is refused', async () => {
  const loop = await runScript(`await agent('a')\nwhile (true) {}`, undefined, {
    sliceMs: 200,
  });
  assert.deepEqual(loop.outcome, {
    error:
      'the script ran for more than 200ms without waiting for an agent, so it was stopped',
  });
  const greedy = await runScript(
    `await agent('a')\nconst kept = []\nwhile (true) kept.push(new Array(100000).fill(kept.length))`,
    undefined,
    { memoryMb: 32, sliceMs: 60_000 },
  );
  assert.deepEqual(greedy.outcome, {
    error: 'the script used more than 32 MB of memory, so it was stopped',
  });
  const long = await runScript(
    `const items = Array.from({ length: ${MAX_FAN_OUT + 1} }, (_, i) => i)
try { await pipeline(items, (i) => agent('x' + i)) } catch (error) { log(error.message) }
try { await parallel(items.map((i) => () => agent('y' + i))) } catch (error) { log(error.message) }
return 'checked'`,
  );
  assert.deepEqual(long.asked, []);
  assert.deepEqual(long.logs, [
    `pipeline() takes at most ${MAX_FAN_OUT} items; this call has ${MAX_FAN_OUT + 1}`,
    `parallel() takes at most ${MAX_FAN_OUT} tasks; this call has ${MAX_FAN_OUT + 1}`,
  ]);
  assert.equal(long.value(), 'checked');
  const thrown = await runScript(`throw new TypeError('bad input')`);
  assert.match(
    (thrown.outcome as { error: string }).error,
    /^bad input \(try\.js:2:7\)$/,
  );
});

test('the limits read their variables, and a schema that contradicts itself is named', () => {
  assert.equal(maxWorkflowAgents({}, 64), 16);
  assert.equal(maxWorkflowAgents({}, 6), 4);
  assert.equal(maxWorkflowAgents({}, 2), 1);
  assert.equal(
    maxWorkflowAgents({ CIRCLE_WORKFLOW_MAX_CONCURRENT_AGENTS: '40' }, 4),
    40,
  );
  assert.equal(
    maxWorkflowAgents({ CIRCLE_WORKFLOW_MAX_CONCURRENT_AGENTS: '300' }, 64),
    16,
  );
  assert.equal(structuredOutputAttempts({}), 5);
  assert.equal(
    structuredOutputAttempts({ CIRCLE_MAX_STRUCTURED_OUTPUT_RETRIES: '2' }),
    2,
  );
  assert.equal(agentStallMs({}), 600_000);
  assert.equal(
    agentStallMs({ CIRCLE_ASYNC_AGENT_STALL_TIMEOUT_MS: '1800000' }),
    1_800_000,
  );
  assert.equal(
    schemaContradiction({
      type: 'object',
      properties: { a: { type: 'string' } },
    }),
    undefined,
  );
  assert.equal(
    schemaContradiction({
      type: 'object',
      required: ['b'],
      additionalProperties: false,
      properties: { a: { type: 'string' } },
    }),
    "schema: 'b' is required, and additionalProperties: false rules it out",
  );
  assert.equal(
    schemaContradiction({
      type: 'object',
      properties: { list: { type: 'array', minItems: 3, maxItems: 1 } },
    }),
    'schema.list: minItems 3 is above maxItems 1',
  );
  assert.match(
    String(schemaContradiction({ type: 'string' })),
    /type: 'object' at its root/,
  );
  assert.match(
    String(schemaContradiction({ type: 'object', properties: 3 })),
    /not valid JSON Schema/,
  );
  assert.equal(
    workflowSummary({
      agents: [
        { phase: 'Find', state: 'done' },
        { phase: 'Audit', state: 'running' },
        { phase: 'Audit', state: 'queued' },
        { phase: 'Audit', state: 'failed' },
      ],
    } as never),
    'Audit · 1 running · 1 waiting · 1 done · 1 failed',
  );
});

test('a run starts at most a thousand agents, and refuses the next one with why', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { WorkflowRun, MAX_RUN_AGENTS } = await import('../src/workflows.js');
  const folder = mkdtempSync(join(tmpdir(), 'circle-workflow-run-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const prepared = prepareWorkflowScript(
    META +
      `const results = await parallel(Array.from({ length: ${MAX_RUN_AGENTS} }, (_, i) => () => agent('job ' + i)))
let refused = ''
try { await agent('one too many') } catch (error) { refused = error.message }
return { done: results.filter(Boolean).length, refused }`,
    'cap.js',
  );
  const run = new WorkflowRun({
    id: 'w00000001',
    sessionId: 'session',
    prepared,
    folder,
    script: 'cap.js',
    scriptFile: join(folder, 'script.js'),
    maxConcurrent: 64,
    runner: async (request) => `ran ${request.index}`,
  });
  const result = JSON.parse(await run.run(new AbortController().signal));
  assert.deepEqual(result, {
    done: MAX_RUN_AGENTS,
    refused: `this run has started ${MAX_RUN_AGENTS} agents, the most one run may start`,
  });
  assert.equal(run.view.agents.length, MAX_RUN_AGENTS);
  assert.equal(run.view.status, 'done');
});

test('an agent() call with an option it cannot take is refused before anything starts', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { WorkflowRun } = await import('../src/workflows.js');
  const folder = mkdtempSync(join(tmpdir(), 'circle-workflow-run-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const prepared = prepareWorkflowScript(
    META +
      `const refused = []
for (const options of [{ effort: 'huge' }, { stallMs: -1 }, { label: 3 }, { isolation: 'worktree' }, { agentType: 'nobody' }, { schema: { type: 'array' } }]) {
  try { await agent('try', options) } catch (error) { refused.push(error.message) }
}
return refused`,
    'options.js',
  );
  const ran: string[] = [];
  const run = new WorkflowRun({
    id: 'w00000002',
    sessionId: 'session',
    prepared,
    folder,
    script: 'options.js',
    scriptFile: join(folder, 'script.js'),
    checkAgentType: (name) =>
      name === 'nobody'
        ? `agentType ${name} is not a subagent this session has`
        : undefined,
    runner: async (request) => {
      ran.push(request.prompt);
      return 'ran';
    },
  });
  assert.deepEqual(JSON.parse(await run.run(new AbortController().signal)), [
    'agent() option effort must be one of minimal, low, medium, high, xhigh, max',
    'agent() option stallMs must be a number of milliseconds',
    'agent() option label must be a string',
    "agent() option isolation: 'worktree' is not supported in Circle yet; agents work in the workspace",
    'agentType nobody is not a subagent this session has',
    "schema needs type: 'object' at its root, with properties",
  ]);
  assert.deepEqual(ran, []);
  assert.equal(run.view.agents.length, 0);
});
