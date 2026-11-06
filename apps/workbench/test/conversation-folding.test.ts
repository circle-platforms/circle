import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as Tooltip from '@radix-ui/react-tooltip';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeProvider } from '../src/app/context.tsx';
import { ToolGroup } from '../src/components/ToolGroup.tsx';
import { ToolMessage } from '../src/components/ToolMessage.tsx';
import { PreviewRuntime } from '../src/model/state.ts';
import type { AgentRecord, Message, ToolCall } from '../src/model/types.ts';

const toolRow = (tool: Partial<ToolCall>): Message => ({
  id: 'row-' + (tool.id ?? 'call'),
  parentId: null,
  role: 'tool',
  text: '',
  at: '',
  tool: {
    id: 'call',
    name: 'execute',
    input: { command: 'git status' },
    output: 'clean',
    status: 'success',
    ...tool,
  },
});
const thinkingRow: Message = {
  id: 'quiet',
  parentId: null,
  role: 'assistant',
  text: '',
  at: '',
  thinking: '**Looking** at the private reasoning',
};
const noop = () => {};
const tips = (children: ReactNode) =>
  createElement(Tooltip.Provider, null, children);

function render(
  rows: Message[],
  options: { showThinking?: boolean; expanded?: boolean } = {},
  agents: AgentRecord[] = [],
) {
  const runtime = new PreviewRuntime();
  runtime.change((state) => {
    state.agents = agents;
    state.sessions[0]!.id = 'parent';
    state.activeSessionId = 'parent';
  });
  return renderToStaticMarkup(
    createElement(RuntimeProvider, {
      runtime,
      children: tips(
        createElement(ToolGroup, {
          rows,
          ownerSessionId: 'parent',
          expanded: options.expanded ?? false,
          showThinking: options.showThinking,
          onFile: noop,
          onAgent: noop,
        }),
      ),
    }),
  );
}

test('an opened line respects hidden thinking', () => {
  const rows = [thinkingRow, toolRow({})];
  assert.match(render(rows, { expanded: true }), /private reasoning/);
  assert.doesNotMatch(
    render(rows, { expanded: true, showThinking: false }),
    /private reasoning/,
  );
});

test('a step of hidden thinking alone draws no line', () => {
  assert.equal(render([thinkingRow], { showThinking: false }), '');
  assert.match(render([thinkingRow]), /tool-summary/);
});

test('the way into a subagent shows while its line is folded', () => {
  const agent = {
    id: 'child',
    sessionId: 'parent',
    name: 'reviewer child',
    description: '',
    status: 'running',
    model: '',
    tokens: 0,
    messages: [],
  } as unknown as AgentRecord;
  const html = render(
    [
      toolRow({
        name: 'task',
        input: {},
        status: 'running',
        agentId: 'child',
      }),
    ],
    {},
    [agent],
  );
  assert.match(html, /tool-agent-links/);
  assert.match(html, /reviewer child/);
  assert.equal(html.match(/reviewer child/g)?.length, 1);
});

test('a failed part of the line is marked and the rest is not', () => {
  const html = render([
    toolRow({ id: 'a' }),
    toolRow({ id: 'b', status: 'error', output: 'exit 1' }),
  ]);
  assert.match(html, /<span class="failed">failed to run a command<\/span>/);
  assert.match(html, /<span>, ran a command<\/span>/);
});

test('an opened command shows its command over its output, with no tabs', () => {
  const runtime = new PreviewRuntime();
  const html = renderToStaticMarkup(
    createElement(RuntimeProvider, {
      runtime,
      children: tips(
        createElement(ToolMessage, {
          tool: toolRow({}).tool!,
          expanded: true,
          onFile: noop,
          onAgent: noop,
        }),
      ),
    }),
  );
  assert.match(html, /\$ git status/);
  assert.match(html, /clean/);
  assert.doesNotMatch(html, /segmented/);
  assert.ok(html.indexOf('$ git status') < html.indexOf('clean'));
});

test('the summary can always give way, so a long line cannot leave the conversation', () => {
  const css = readFileSync(
    new URL('../src/styles/app.css', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(css, /\.tool-summary-text\s*\{[^}]*flex:\s*none/);
  assert.doesNotMatch(css, /\.tool-note/);
});
