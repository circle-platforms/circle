import test from 'node:test';
import { createCollaborationTools } from '../../desktop/src/workspace/collaboration-tools.ts';
import { agentTools } from '../src/i18n/zh-CN/agent-tools.ts';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AgentToolLinks,
  mappedToolAgents,
  agentToolTitle,
} from '../src/components/ToolMessage.tsx';
import { toolSummary } from '../src/components/ToolGroup.tsx';
import type { AgentRecord, Message, ToolCall } from '../src/model/types.ts';

const child = (id: string, state: string): AgentRecord =>
  ({
    id,
    sessionId: 'parent',
    name: `child ${id}`,
    description: '',
    status: 'completed',
    model: '',
    tokens: 0,
    messages: [],
    task: {
      id: `task-${id}`,
      attempt: 1,
      state,
      access: 'readonly',
      baseline: 'abc',
    },
  }) as AgentRecord;
const call = (name: string, extra = {}): ToolCall => ({
  id: 'call',
  name,
  status: 'success',
  input: {},
  output: 'actual scheduler result',
  ...extra,
});
const summary = (name: string, status = 'success') =>
  toolSummary([
    {
      id: 'row',
      parentId: null,
      role: 'tool',
      text: '',
      at: 'now',
      tool: call(name, { status }),
    } as Message,
  ]).text;

test('native dispatch reports scheduling, while queries never claim another agent ran', () => {
  for (const name of [
    'native_tasks_enqueue',
    'native_tasks_analyze',
    'native_tasks_adopt_proposal',
  ]) {
    assert.match(summary(name), /scheduled agents/);
    assert.doesNotMatch(summary(name), /completed|ran a subagent|used native/);
    assert.doesNotMatch(summary(name, 'error'), /scheduled/);
  }
  for (const name of [
    'native_tasks_list',
    'native_tasks_wait',
    'native_tasks_events',
  ]) {
    assert.match(summary(name), /checked agent progress/);
    assert.doesNotMatch(summary(name), /scheduled|ran.*agent/);
  }
  assert.equal(
    agentToolTitle('native_tasks_analyze'),
    'schedule read-only agents',
  );
});

test('only actual projected IDs create links, preserving legacy and deduplicating IDs', () => {
  const agents = [child('a', 'failed'), child('b', 'cancelled')];
  const tool = call('native_tasks_enqueue', {
    agentIds: ['a', 'b', 'a', 'invented'],
    agentId: 'a',
    output: '{"agentIds":["untrusted-text"]}',
  });
  assert.deepEqual(
    mappedToolAgents(tool, agents, 'parent').map((a) => a.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    mappedToolAgents(call('native_tasks_enqueue'), agents, 'parent'),
    [],
  );
  assert.deepEqual(
    mappedToolAgents(call('task', { agentId: 'b' }), agents, 'parent').map(
      (a) => a.id,
    ),
    ['b'],
  );
});

test('pure React child controls preserve actual state and invoke each actual child ID', () => {
  const agents = [child('a', 'failed'), child('b', 'cancelled')];
  const selected: string[] = [];
  const element = AgentToolLinks({
    agents,
    onAgent: (id) => selected.push(id),
  });
  const markup = renderToStaticMarkup(element);
  assert.match(markup, /child a/);
  assert.match(markup, /child b/);
  assert.match(markup, /failed/);
  assert.match(markup, /cancelled/);
  assert.doesNotMatch(markup, />completed</);
  for (const button of element.props.children) button.props.onClick();
  assert.deepEqual(selected, ['a', 'b']);
});

test('new agent card words include Chinese translations', () => {
  for (const key of [
    'schedule agents',
    'schedule read-only agents',
    'agent progress',
    'cancel agent task',
    'retry agent task',
    'agent artifacts',
    'scheduled agents',
    'checked agent progress',
    'updated agent scheduling',
  ])
    assert.match(agentTools[key]!, /[\u3400-\u9fff]/);
});

test('matching trusted IDs cannot link a different parent owner, including duplicated legacy IDs', () => {
  const own = child('same-child-id', 'running');
  const foreign = {
    ...own,
    sessionId: 'foreign-parent',
    name: 'foreign child',
  };
  const tool = call('native_tasks_enqueue', {
    agentIds: ['same-child-id'],
    agentId: 'same-child-id',
  });
  assert.deepEqual(mappedToolAgents(tool, [foreign], 'parent'), []);
  const selected: string[] = [];
  const deniedLinks = AgentToolLinks({
    agents: mappedToolAgents(tool, [foreign], 'parent'),
    onAgent: (id) => selected.push(id),
  });
  assert.doesNotMatch(
    renderToStaticMarkup(deniedLinks),
    /button|foreign child/,
  );
  for (const button of deniedLinks.props.children) button.props.onClick();
  assert.deepEqual(selected, []);
  assert.deepEqual(mappedToolAgents(tool, [foreign, own], 'parent'), [own]);
  assert.deepEqual(mappedToolAgents(tool, [foreign, own], 'foreign-parent'), [
    foreign,
  ]);
  assert.deepEqual(mappedToolAgents(tool, [foreign, own], ''), []);
});

test('proposal cards never navigate child agents and adoption uses only actual projected owner IDs', () => {
  const hostTools = createCollaborationTools({
    sessionId: 'parent',
    service: () => ({
      call: async () => {
        throw Error('schema-only test must not execute tasks');
      },
    }),
  });
  const adoption = hostTools.find(
    (tool) => tool.name === 'native_tasks_adopt_proposal',
  );
  assert(adoption, 'the card name must be an actual exported host tool');
  assert.equal(
    hostTools.some((tool) => tool.name === 'native_tasks_adopt'),
    false,
  );
  assert.equal(agentToolTitle(adoption.name), 'schedule agents');
  assert.equal(summary(adoption.name), 'scheduled agents');
  const agents = [child('a', 'running')];
  assert.equal(
    agentToolTitle('native_tasks_propose'),
    'propose follow-up tasks',
  );
  assert.equal(
    agentToolTitle('native_tasks_adopt_proposal'),
    'schedule agents',
  );
  assert.equal(summary('native_tasks_propose'), 'proposed follow-up tasks');
  const proposal = call('native_tasks_propose', {
    agentIds: ['a'],
    output: '{"agentIds":["a"],"tasks":[{"prompt":"only a proposal"}]}',
  });
  const original = proposal.output;
  assert.deepEqual(mappedToolAgents(proposal, agents, 'parent'), []);
  assert.equal(
    proposal.output,
    original,
    'human naming does not change original tool output',
  );
  assert.deepEqual(
    mappedToolAgents(
      call('native_tasks_adopt_proposal', { output: '{"agentIds":["a"]}' }),
      agents,
      'parent',
    ),
    [],
    'raw output cannot create navigation',
  );
  assert.deepEqual(
    mappedToolAgents(
      call('native_tasks_adopt_proposal', { agentIds: ['a', 'invented'] }),
      agents,
      'parent',
    ),
    agents,
  );
  assert.deepEqual(
    mappedToolAgents(
      call('native_tasks_adopt_proposal', { agentIds: ['a'] }),
      agents,
      'other-parent',
    ),
    [],
  );
});
