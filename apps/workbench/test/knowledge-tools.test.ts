import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { Tooltip } from 'radix-ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLanguage } from '../src/i18n/index.ts';
import {
  knowledgeChangePreview,
  knowledgeChangeText,
  knowledgeConfirmLabel,
  knowledgeToolResult,
  knowledgeToolTarget,
  knowledgeToolTitle,
  writtenMemoryItem,
} from '../src/model/knowledge-tools.ts';
import { approvalHeading } from '../src/model/reasons.ts';
import { toolSummary } from '../src/model/tool-summary.ts';
import { ToolMessage } from '../src/components/ToolMessage.tsx';
import { RuntimeProvider } from '../src/app/context.tsx';
import { PreviewRuntime } from '../src/model/state.ts';
import type { Message, ToolCall } from '../src/model/types.ts';

const storage = {
  length: 0,
  getItem: () => null,
  setItem: () => {},
  clear: () => {},
  removeItem: () => {},
  key: () => null,
};
const head = 'a'.repeat(64);
const folder = 'f'.repeat(64);
// A prepared memory_write: the model's arguments plus the change the core attached.
const memoryInput = {
  expected_head: head,
  title: 'sync notes',
  markdown: 'one\ntwo\nthree',
  change: {
    expected_head: head,
    snapshot: 'b'.repeat(64),
    objects: [
      {
        id: 'c'.repeat(64),
        object: {
          schema: 'personal-sync-object@1',
          kind: 'directory_revision',
          body: {
            item_id: folder,
            parents: [],
            parent_directory: null,
            name: 'deploy',
          },
        },
      },
      {
        id: 'd'.repeat(64),
        object: {
          schema: 'personal-sync-object@1',
          kind: 'memory_revision',
          body: {
            item_id: 'e'.repeat(64),
            parents: [],
            directory_id: folder,
            title: 'sync notes',
            markdown: 'one\ntwo\nthree',
            state: 'enabled',
          },
        },
      },
    ],
  },
};

test('knowledge tools go by the tool list titles in cards, approvals and group lines', () => {
  setLanguage('zh-CN', storage);
  assert.equal(knowledgeToolTitle('memory_write'), '写入记忆');
  assert.equal(knowledgeToolTitle('knowledge_search'), '搜索知识');
  assert.equal(knowledgeToolTitle('knowledge_share'), '分享到团队');
  assert.equal(
    approvalHeading({ title: 'memory_write', tool: 'memory_write' }),
    '写入记忆',
  );
  const rows = [
    {
      id: 'm1',
      role: 'tool',
      text: '',
      tool: {
        id: 't1',
        name: 'memory_write',
        status: 'success',
        input: memoryInput,
        output: JSON.stringify({ snapshot: head, scope: 'local' }),
        elapsed: '1s',
      },
    },
  ] as unknown as Message[];
  assert.match(toolSummary(rows).text, /写入记忆/);
  assert.doesNotMatch(toolSummary(rows).text, /memory_write/);
  setLanguage('en', storage);
  assert.equal(knowledgeToolTitle('memory_write'), 'write memory');
  assert.equal(knowledgeToolTitle('not_a_tool'), 'not_a_tool');
});

test('a memory write reads as a change preview without hashes, and its button names the action', () => {
  setLanguage('zh-CN', storage);
  const preview = knowledgeChangePreview('memory_write', memoryInput)!;
  const text = knowledgeChangeText(preview);
  assert.equal(text, '新建 · 我的 › deploy › sync notes · 3 行');
  assert.doesNotMatch(text, /[a-f0-9]{16}/);
  assert.equal(knowledgeConfirmLabel('memory_write', memoryInput), '确认写入');
  assert.equal(
    knowledgeConfirmLabel('memory_write', {
      expected_head: head,
      item_id: 'e'.repeat(64),
      delete: true,
    }),
    '确认删除',
  );
  assert.equal(
    knowledgeChangeText(
      knowledgeChangePreview('memory_write', {
        expected_head: head,
        item_id: 'e'.repeat(64),
        state: 'disabled',
      })!,
    ),
    '停用 · 我的',
  );
  assert.equal(
    knowledgeConfirmLabel('knowledge_share', { title: 'notes' }),
    '确认分享到团队',
  );
  assert.equal(
    knowledgeConfirmLabel('knowledge_share', {
      title: 'notes',
      replaces: true,
    }),
    '确认替换',
  );
  assert.equal(
    knowledgeChangeText(
      knowledgeChangePreview('knowledge_share', {
        snapshot: head,
        object: head,
        title: 'notes',
        team_path: '/ops',
      })!,
    ),
    '分享到团队 · 团队 › ops › notes',
  );
  setLanguage('en', storage);
  assert.equal(
    knowledgeChangeText(knowledgeChangePreview('memory_write', memoryInput)!),
    'new · mine › deploy › sync notes · 3 lines',
  );
});

test('a finished memory write says so and names the item its link opens', () => {
  setLanguage('zh-CN', storage);
  const output = JSON.stringify({ snapshot: head, scope: 'local' });
  assert.equal(
    knowledgeToolResult('memory_write', output, 'success'),
    '已写入我的记忆',
  );
  assert.equal(
    writtenMemoryItem('memory_write', memoryInput, output, 'success'),
    'e'.repeat(64),
  );
  assert.equal(
    writtenMemoryItem('memory_write', memoryInput, output, 'rejected'),
    undefined,
  );
  assert.equal(
    writtenMemoryItem('knowledge_write', memoryInput, output, 'success'),
    undefined,
  );
  assert.equal(
    knowledgeToolResult(
      'knowledge_search',
      JSON.stringify({ items: [{}, {}], next: null }),
      'success',
    ),
    '2 条结果',
  );
  assert.equal(
    knowledgeToolTarget('knowledge_search', { query: 'deploy  steps' }),
    '“deploy steps”',
  );
  assert.equal(
    knowledgeToolTarget(
      'knowledge_read',
      { object: head },
      JSON.stringify({
        kind: 'memory_revision',
        text: JSON.stringify({
          kind: 'memory_revision',
          body: { title: 'sync notes' },
        }),
        next: null,
      }),
    ),
    'sync notes',
  );
  setLanguage('en', storage);
});

test('a knowledge card shows its title and item, with the JSON folded under technical details', () => {
  const runtime = new PreviewRuntime(storage);
  const tool = {
    id: 'tool-1',
    name: 'memory_write',
    status: 'success',
    input: memoryInput,
    output: JSON.stringify({ snapshot: head, scope: 'local' }),
    elapsed: '1s',
  } as unknown as ToolCall;
  for (const language of ['zh-CN', 'en'] as const) {
    setLanguage(language, storage);
    const html = renderToStaticMarkup(
      createElement(
        Tooltip.Provider,
        null,
        createElement(RuntimeProvider, {
          runtime,
          children: createElement(ToolMessage, {
            tool,
            expanded: true,
            onFile: () => {},
            onAgent: () => {},
          }),
        }),
      ),
    );
    const headLine = html.match(
      /<button class="tool-head"[\s\S]*?<\/button>/,
    )![0];
    assert.ok(
      headLine.includes(language === 'zh-CN' ? '写入记忆' : 'write memory'),
    );
    assert.ok(headLine.includes('sync notes'));
    assert.doesNotMatch(headLine, /[a-f0-9]{16}|expected_head/);
    const details = html.match(/<details[\s\S]*<\/details>/)![0];
    assert.ok(
      details.includes(language === 'zh-CN' ? '技术详情' : 'technical details'),
    );
    assert.ok(details.includes('expected_head'));
    assert.doesNotMatch(
      html.replace(details, ''),
      /expected_head|[a-f0-9]{64}/,
    );
  }
  setLanguage('en', storage);
});
