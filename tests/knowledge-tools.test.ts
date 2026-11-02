import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeService } from '../src/knowledge/service.js';
import { KnowledgeStore } from '../src/knowledge/store.js';
import { knowledgeTools } from '../src/knowledge/tools.js';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { Harness } from '../src/harness.js';
import { ScriptedModel } from '../src/testing.js';
import type { ToolCall, Message } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
const reply = (calls: ToolCall[] = [], content = ''): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content,
  tool_calls: calls,
});
for (const mode of ['manual', 'accept-edits', 'auto'] as const)
  for (const decision of ['approve', 'reject', 'always'] as const)
    test(`memory write in ${mode} with ${decision} requires person confirmation despite hook allows`, async (t) => {
      const root = scratch(t),
        service = new KnowledgeService(join(root, 'home')),
        store = new CheckpointStore(join(root, 'session'));
      cleanup(t, () => store.close());
      const session = store.create(root, 'scripted');
      const policy = new ApprovalPolicy(
        new ApprovalStore(join(root, 'approvals')),
        root,
      );
      policy.setMode(session.id, mode);
      const call: ToolCall = {
        id: 'memory',
        name: 'memory_write',
        args: {
          expected_head: null,
          title: 'Synthetic note',
          markdown: 'Synthetic memory',
        },
      };
      const model = new ScriptedModel([
        { message: reply([call]) },
        { message: reply([], 'done') },
      ]);
      let asked = 0;
      const harness = new Harness({
        model,
        store,
        session,
        policy,
        system: 'synthetic',
        tools: knowledgeTools(service),
        hooks: {
          loaded: {
            projectChanged: [],
            projectIgnored: false,
            hooks: [],
            errors: [],
          },
          active: () => [],
          run: async () => ({
            decision: 'allow',
            notices: [],
            outcomes: [],
            context: '',
          }),
        } as never,
        approve: async (c) => {
          asked++;
          assert.ok(c.args.change);
          return decision;
        },
      });
      await harness.run('remember this');
      assert.equal(
        asked,
        1,
        JSON.stringify(
          model.requests[1]?.messages.filter((m) => m.role === 'tool'),
        ),
      );
      const knowledge = new KnowledgeStore(service.home);
      try {
        assert.equal(!!knowledge.head, decision === 'approve');
        if (decision !== 'approve') {
          assert.deepEqual(knowledge.items(), []);
          assert.deepEqual(knowledge.history(), []);
          assert.deepEqual(
            readdirSync(join(knowledge.directory, 'objects')),
            [],
          );
        }
      } finally {
        knowledge.close();
      }
      const result = model.requests[1]!.messages.find((m) => m.role === 'tool');
      assert.equal(
        result?.status,
        decision === 'approve' ? 'success' : 'error',
      );
    });
test('headless auto mode cannot write personal memory without a person', async (t) => {
  const root = scratch(t),
    store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'scripted'),
    policy = new ApprovalPolicy(
      new ApprovalStore(join(root, 'approvals')),
      root,
    );
  policy.setMode(session.id, 'auto');
  const service = new KnowledgeService(join(root, 'knowledge-home'));
  const model = new ScriptedModel([
    {
      message: reply([
        {
          id: 'write',
          name: 'memory_write',
          args: { expected_head: null, title: 'x', markdown: 'synthetic' },
        },
      ]),
    },
    { message: reply([], 'done') },
  ]);
  await new Harness({
    model,
    store,
    session,
    policy,
    system: 'test',
    headless: true,
    tools: knowledgeTools(service),
  }).run('remember');
  assert.equal(service.search('x').snapshot, null);
  assert.match(
    model.requests[1]!.messages.find((m) => m.role === 'tool')!.content,
    /always asks/,
  );
});
test('credential and oversize proposals are absent from durable history, model replay and tool events', async (t) => {
  const root = scratch(t),
    store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'scripted'),
    policy = new ApprovalPolicy(
      new ApprovalStore(join(root, 'approvals')),
      root,
    ),
    service = new KnowledgeService(join(root, 'personal'));
  const secret = 'Password' + '=Syn9thetic' + 'RejectedValue';
  const markdown = JSON.stringify(secret).replace('Password', 'Pass\\u0077ord');
  let asked = 0;
  const message = reply([
    {
      id: 'credential',
      name: 'memory_write',
      args: { expected_head: null, title: 'synthetic', markdown },
      raw_args: JSON.stringify({ markdown }),
    },
  ]);
  message.provider_content = [{ text: markdown }];
  const model = new ScriptedModel([
    { message },
    { message: reply([], 'done') },
  ]);
  const harness = new Harness({
    model,
    store,
    session,
    policy,
    system: 'test',
    tools: knowledgeTools(service),
    approve: async () => {
      asked++;
      return 'approve';
    },
  });
  const events: unknown[] = [];
  harness.bus.subscribe((e) => events.push(e));
  await harness.run('remember');
  assert.equal(asked, 0);
  for (const value of [store.messages(session.id), model.requests[1], events]) {
    assert.equal(JSON.stringify(value).includes(markdown), false);
    assert.equal(JSON.stringify(value).includes('RejectedValue'), false);
  }
  const knowledge = new KnowledgeStore(service.home);
  try {
    assert.equal(knowledge.head, null);
    assert.deepEqual(readdirSync(join(knowledge.directory, 'objects')), []);
  } finally {
    knowledge.close();
  }
});
test('approval-time concurrent changes require a new confirmation and never overwrite the newer memory', async (t) => {
  const root = scratch(t),
    store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'scripted'),
    policy = new ApprovalPolicy(
      new ApprovalStore(join(root, 'approvals')),
      root,
    ),
    service = new KnowledgeService(join(root, 'personal'));
  const model = new ScriptedModel([
    {
      message: reply([
        {
          id: 'write',
          name: 'memory_write',
          args: { expected_head: null, title: 'stale', markdown: 'stale body' },
        },
      ]),
    },
    { message: reply([], 'done') },
  ]);
  await new Harness({
    model,
    store,
    session,
    policy,
    system: 'test',
    tools: knowledgeTools(service),
    approve: async () => {
      service
        .prepareMemory({
          expected_head: null,
          title: 'newer',
          markdown: 'newer body',
        })
        .commit(new AbortController().signal);
      return 'approve';
    },
  }).run('remember');
  assert.match(
    model.requests[1]!.messages.find((m) => m.role === 'tool')!.content,
    /version changed/,
  );
  const knowledge = new KnowledgeStore(service.home);
  try {
    assert.equal(
      knowledge.items().filter((row) => row.kind === 'memory_revision').length,
      1,
    );
    assert.equal(knowledge.history().length, 1);
    const item = knowledge
      .items()
      .find((row) => row.kind === 'memory_revision')!;
    assert.equal((knowledge.read(item.heads[0]!) as any).body.title, 'newer');
  } finally {
    knowledge.close();
  }
});
test('a runtime offers the reserved knowledge tools and reads their real stored effect on the next request', async (t) => {
  const { AgentRuntime } = await import('../src/runtime.js');
  const { defaultSettings } = await import('../src/settings.js');
  const root = scratch(t),
    home = join(root, 'home');
  let asked = 0;
  const model = new ScriptedModel([
    {
      message: reply([
        {
          id: 'memory',
          name: 'memory_write',
          args: {
            expected_head: null,
            title: 'Runtime note',
            markdown: 'synthetic runtime memory',
          },
        },
      ]),
    },
    { message: reply([], 'done') },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home,
    userHome: root,
    model,
    settings: defaultSettings(),
    localContext: false,
    approve: async () => {
      asked++;
      return 'approve';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('remember');
  assert.equal(asked, 1);
  for (const name of [
    'knowledge_search',
    'knowledge_read',
    'knowledge_write',
    'knowledge_share',
    'memory_write',
  ])
    assert.ok(model.requests[0]!.tools.some((tool) => tool.name === name));
  assert.equal(
    model.requests[1]!.messages.find((m) => m.role === 'tool')!.status,
    'success',
  );
  const k = new KnowledgeStore(home);
  try {
    assert.ok(k.head);
    assert.equal(
      k.items().filter((row) => row.kind === 'memory_revision').length,
      1,
    );
  } finally {
    k.close();
  }
});

test('model-supplied confirm cannot authorize a write and cancelling the person card publishes nothing', async (t) => {
  const root = scratch(t),
    store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'scripted'),
    policy = new ApprovalPolicy(
      new ApprovalStore(join(root, 'approvals')),
      root,
    ),
    service = new KnowledgeService(join(root, 'personal'));
  const model = new ScriptedModel([
    {
      message: reply([
        {
          id: 'fake',
          name: 'memory_write',
          args: {
            expected_head: null,
            title: 'x',
            markdown: 'synthetic',
            confirm: true,
          },
        },
      ]),
    },
    { message: reply([], 'done') },
    {
      message: reply([
        {
          id: 'cancel',
          name: 'memory_write',
          args: { expected_head: null, title: 'x', markdown: 'synthetic' },
        },
      ]),
    },
    { message: reply([], 'done') },
  ]);
  let asked = 0;
  const harness = new Harness({
    model,
    store,
    session,
    policy,
    system: 'test',
    tools: knowledgeTools(service),
    approve: async () => {
      asked++;
      throw new Error('person cancelled');
    },
  });
  await harness.run('remember');
  assert.equal(asked, 0);
  assert.equal(service.search('x').snapshot, null);
  await harness.run('remember again');
  assert.equal(asked, 1);
  assert.equal(service.search('x').snapshot, null);
  assert.deepEqual(readdirSync(join(service.home, 'knowledge', 'objects')), []);
});

test('an empty greeting keeps one address/schema discovery tool and promotes the full set after a read', async (t) => {
  const { AgentRuntime } = await import('../src/runtime.js'),
    { defaultSettings } = await import('../src/settings.js');
  const { tokenLen } = await import('../src/middleware/tool_result_prune.js');
  const root = scratch(t);
  const model = new ScriptedModel([
    {
      message: reply([
        {
          id: 'format',
          name: 'knowledge_read',
          args: { object: 'schema', limit: 1000 },
        },
      ]),
    },
    { message: reply([], 'done') },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: join(root, 'home'),
    userHome: root,
    model,
    settings: defaultSettings(),
    localContext: false,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('hello');
  const first = model.requests[0]!,
    second = model.requests[1]!;
  assert.ok(first.tools.some((tool) => tool.name === 'knowledge_read'));
  for (const name of [
    'knowledge_search',
    'knowledge_write',
    'memory_write',
    'knowledge_share',
  ]) {
    assert.equal(
      first.tools.some((tool) => tool.name === name),
      false,
    );
    assert.ok(second.tools.some((tool) => tool.name === name));
  }
  const result = second.messages.find((message) => message.role === 'tool')!;
  const data = JSON.parse(result.content);
  assert.equal(data.schema, 'personal-sync-object@1');
  assert.equal(data.text.length, 1000);
  assert.equal(data.next, 1000);
  const cost = (tools: typeof first.tools) =>
    tokenLen(first.system) +
    tokenLen(
      JSON.stringify(
        tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      ),
    );
  t.diagnostic(
    `runtime total ${cost(first.tools)}, without knowledge reader ${cost(first.tools.filter((tool) => tool.name !== 'knowledge_read'))}`,
  );
});

test('the knowledge write tool publishes a confirmed revision and the next model request reads its exact effect', async (t) => {
  const { syncObjectId } = await import('../src/knowledge/canonical.js');
  const { randomUUID } = await import('node:crypto');
  const root = scratch(t),
    service = new KnowledgeService(join(root, 'personal')),
    store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'scripted'),
    policy = new ApprovalPolicy(
      new ApprovalStore(join(root, 'approvals')),
      root,
    );
  policy.setMode(session.id, 'auto');
  const directory = randomUUID(),
    objects = [
      {
        schema: 'personal-sync-object@1',
        kind: 'directory_revision',
        body: {
          item_id: directory,
          parents: [],
          parent_directory: null,
          name: '',
        },
      },
      {
        schema: 'personal-sync-object@1',
        kind: 'entry_revision',
        body: {
          item_id: randomUUID(),
          parents: [],
          directory_id: directory,
          content: {
            kind: 'observation',
            statement: 'synthetic tool entry',
            data: {},
            applicability: null,
          },
          grounds: [],
        },
      },
    ];
  const id = syncObjectId(objects[1]);
  let asked = 0;
  const model = new ScriptedModel([
    {
      message: reply([
        {
          id: 'write',
          name: 'knowledge_write',
          args: { expected_head: null, objects },
        },
      ]),
    },
    { message: reply([], 'done') },
  ]);
  await new Harness({
    model,
    store,
    session,
    policy,
    system: 'synthetic',
    tools: knowledgeTools(service),
    approve: async (call) => {
      asked++;
      assert.equal((call.args.change as any).objects[1].id, id);
      return 'approve';
    },
  }).run('save this knowledge');
  assert.equal(asked, 1);
  const result = model.requests[1]!.messages.find(
    (message) => message.tool_call_id === 'write',
  )!;
  assert.equal(result.status, 'success');
  const snapshot = JSON.parse(result.content).snapshot;
  assert.equal(service.read(snapshot, id).object, id);
  assert.equal(service.search('synthetic').items[0]!.objectId, id);
  assert.equal(service.search('synthetic').items[0]!.status, 'unverified');
});
