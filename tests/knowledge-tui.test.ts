// The terminal's knowledge surfaces: /knowledge status lines, list truncation, the footer
// lamp, sync notices, approval cards and transcript rows. Rows are compared as plain text
// at 60 columns, with Chinese names, on a dark and a light palette.
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conditionWord,
  knowledgeApproval,
  knowledgeArgSummary,
  knowledgeLamp,
  knowledgeResultLines,
  knowledgeStatusLines,
  knowledgeSyncNotice,
  modeArgument,
  modeWord,
  truncationLine,
} from '../src/tui/knowledge_view.js';
import { refusalLines } from '../src/tui/knowledge_commands.js';
import { KnowledgeShareRefused } from '../src/knowledge/sharing.js';
import type { KnowledgeConnectionStatus } from '../src/knowledge/connection.js';
import { ApprovalCard } from '../src/ink/components/approval_card.js';
import { dialogRows } from '../src/ink/components/dialog_card.js';
import { approvalRequest } from '../src/tui/approval_preview.js';
import { defaultPolicy } from '../src/approvals.js';
import { toolArgSummary } from '../src/tui/display_lexicon.js';
import { resultRows, toolRow } from '../src/tui/tool_rows.js';
import { stripAnsi, stringWidth } from '../src/ink/string_width.js';
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  setPalette,
} from '../src/ink/theme.js';
import { scratch } from './helpers.js';

const status = (
  over: Partial<KnowledgeConnectionStatus> = {},
): KnowledgeConnectionStatus => ({
  condition: 'synced',
  mode: 'hub',
  clearing: false,
  lastSyncedAt: '2026-11-03T14:20:00.000Z',
  server: 'team server',
  detail: null,
  confirmation: null,
  discovery: 'document',
  syncing: false,
  ...over,
});
const HASH = /[0-9a-f]{64}/;
const palettes = [
  buildPalette(...DEFAULT_DARK),
  buildPalette(...DEFAULT_LIGHT),
] as const;

test('status lines say where sync stands and the next step, as the design writes them', () => {
  assert.deepEqual(
    knowledgeStatusLines(status(), { items: 12, conflicts: 1 }),
    [
      'knowledge · synced · team server · last synced 11-03 14:20',
      '  12 items · 1 conflict · /knowledge conflicts',
    ],
  );
  assert.deepEqual(
    knowledgeStatusLines(
      status({ condition: 'login-required', lastSyncedAt: null }),
      { items: 3, conflicts: 0 },
    ),
    [
      'knowledge · paused · login required · team server',
      '  run /knowledge login to sign in again',
    ],
  );
  assert.deepEqual(
    knowledgeStatusLines(status({ server: '', mode: null }), {
      items: 1,
      conflicts: 0,
    }),
    [
      'knowledge · local only · no sync server',
      '  1 item · /knowledge connect to choose a sync server',
    ],
  );
  assert.deepEqual(
    knowledgeStatusLines(
      status({
        condition: 'offline',
        detail: '合成的较新错误说明。',
        discovery: 'fallback',
      }),
      { items: 2, conflicts: 0 },
    ),
    [
      'knowledge · offline · team server · last synced 11-03 14:20',
      '  2 items · retrying · /knowledge sync to try now',
      '  refused: 合成的较新错误说明。',
      '  the server publishes no discovery document · fixed v1 paths',
    ],
  );
  assert.deepEqual(
    knowledgeStatusLines(
      status({
        condition: 'paused',
        confirmation: {
          url: 'https://192.0.2.10/console/knowledge?sync=settings',
          expiresAt: '2026-11-03T14:30:00.000Z',
        },
      }),
      { items: 2, conflicts: 0 },
    )[1],
    "  confirm the purge in the server's console before 14:30: https://192.0.2.10/console/knowledge?sync=settings",
  );
  assert.equal(
    knowledgeStatusLines(status({ condition: 'local', mode: 'local' }), {
      items: 2,
      conflicts: 0,
    })[1],
    '  2 items · /knowledge mode synced to sync again',
  );
  assert.equal(
    conditionWord(status({ condition: 'pending', syncing: true })),
    'syncing',
  );
});

test('a held-back list says how much it shows', () => {
  assert.equal(
    truncationLine(100, 342),
    'showing 100 of 342 · narrow with /knowledge search <words>',
  );
  assert.equal(truncationLine(12, 12), null);
});

test('modes are synced and local on screen; the wire keeps hub', () => {
  assert.equal(modeArgument('synced'), 'hub');
  assert.equal(modeArgument('local'), 'local');
  assert.equal(modeArgument('hub'), null);
  assert.equal(modeWord('hub'), 'synced');
  assert.equal(modeWord('local'), 'local only');
});

test('the footer lamp is yellow only while syncing, cyan when it waits for you, unlit when pending', () => {
  const lamp = (over: Partial<KnowledgeConnectionStatus>) =>
    knowledgeLamp(status(over));
  assert.deepEqual(lamp({}), { text: 'synced', lamp: 'ok' });
  assert.deepEqual(lamp({ condition: 'pending', syncing: true }), {
    text: 'syncing',
    lamp: 'running',
  });
  assert.equal(lamp({ condition: 'pending' }).lamp, 'none');
  assert.equal(lamp({ condition: 'paused' }).lamp, 'none');
  assert.equal(lamp({ condition: 'local' }).lamp, 'none');
  assert.equal(lamp({ condition: 'conflicted' }).lamp, 'wait');
  assert.equal(lamp({ condition: 'login-required' }).lamp, 'wait');
  assert.deepEqual(
    lamp({
      condition: 'paused',
      confirmation: {
        url: 'https://192.0.2.10/c',
        expiresAt: '2026-11-03T14:30:00Z',
      },
    }),
    { text: 'purge waits for you', lamp: 'wait' },
  );
  for (const condition of ['offline', 'capacity', 'invalid'] as const)
    assert.equal(lamp({ condition }).lamp, 'error');
});

test('a sync change leaves one notice when the person has to act, and none otherwise', () => {
  let key: string | undefined;
  const step = (over: Partial<KnowledgeConnectionStatus>) => {
    const next = knowledgeSyncNotice(key, status(over));
    key = next.key;
    return next.text;
  };
  assert.equal(step({ condition: 'pending' }), null);
  assert.equal(step({ condition: 'synced' }), null);
  assert.equal(
    step({ condition: 'conflicted' }),
    'knowledge · conflict · /knowledge conflicts',
  );
  assert.equal(step({ condition: 'conflicted' }), null);
  assert.equal(
    step({ condition: 'login-required' }),
    'knowledge · paused · login required · /knowledge login',
  );
  assert.equal(
    step({ condition: 'paused' }),
    'knowledge · sync paused · /knowledge status',
  );
  assert.equal(
    step({
      condition: 'paused',
      confirmation: {
        url: 'https://192.0.2.10/c',
        expiresAt: '2026-11-03T14:30:00Z',
      },
    }),
    "knowledge · paused · confirm the purge in the server's console · /knowledge status",
  );
  // No bound server: nothing to say.
  assert.equal(
    knowledgeSyncNotice(undefined, status({ server: '', condition: 'paused' }))
      .text,
    null,
  );
});

const policy = (t: Parameters<typeof scratch>[0]) => {
  const root = scratch(t);
  return defaultPolicy(root, root);
};
function card(
  t: Parameters<typeof scratch>[0],
  name: string,
  args: Record<string, unknown>,
  paths: Record<string, string> = {},
): string[] {
  const rows: string[][] = [];
  for (const colours of palettes) {
    setPalette(colours);
    const drawn = dialogRows(
      new ApprovalCard(
        approvalRequest(
          { id: 'c', name, args },
          policy(t).review(name, args),
          undefined,
          '',
          (directory) => paths[directory],
        ),
      ).state(),
      60,
      24,
    );
    for (const row of drawn) assert.equal(stringWidth(row), 60, stripAnsi(row));
    rows.push(drawn.map((row) => stripAnsi(row).slice(1, -1).trimEnd()));
  }
  setPalette(palettes[0]);
  // The same words on both palettes.
  assert.deepEqual(rows[0], rows[1]);
  return rows[0]!;
}
const content = (rows: string[]) =>
  rows
    .slice(
      1,
      rows.findIndex((row, i) => i > 1 && !row.trim()),
    )
    .map((row) => row.trim());
const id = (n: number) => String(n).repeat(64).slice(0, 64);
const memoryPreview = (parents: string[], markdown: string) => ({
  expected_head: id(1),
  snapshot: id(2),
  objects: [
    {
      id: id(3),
      object: {
        schema: 'personal-sync-object@1',
        kind: 'memory_revision',
        body: {
          item_id: '00000000-0000-4000-8000-000000000001',
          parents,
          directory_id: 'folder-1',
          title: '同步注意事项.md',
          markdown,
          state: 'enabled',
        },
      },
    },
  ],
});

test('a memory write card names the memory by path and shows its text, never a hash', (t) => {
  const rows = card(
    t,
    'memory_write',
    {
      expected_head: id(1),
      title: '同步注意事项.md',
      markdown: '先同步再分享\n冲突要人工解决',
      change: memoryPreview([], '先同步再分享\n冲突要人工解决'),
    },
    { 'folder-1': '/部署' },
  );
  assert.deepEqual(content(rows), [
    '● write memory',
    'new · mine / 部署 / 同步注意事项.md · 2 lines',
    '+ 先同步再分享',
    '+ 冲突要人工解决',
    'changes personal knowledge or memory and always needs',
    'your confirmation',
  ]);
  assert.match(rows.join('\n'), /Allow once/);
  assert.match(rows.join('\n'), /Reject and explain/);
  assert.doesNotMatch(rows.join('\n'), HASH);
  assert.doesNotMatch(rows.join('\n'), /for this session/);
  // An edit, a disable and a deletion say so.
  assert.match(
    card(t, 'memory_write', { change: memoryPreview([id(4)], 'x') }).join('\n'),
    /edit · mine \/ 同步注意事项\.md · 1 line/,
  );
  assert.match(
    card(t, 'memory_write', {
      state: 'disabled',
      change: memoryPreview([id(4)], 'x'),
    }).join('\n'),
    /disable · mine/,
  );
});

test('a knowledge write card lists its changes by kind and name', (t) => {
  const rows = card(t, 'knowledge_write', {
    expected_head: null,
    objects: [],
    change: {
      expected_head: null,
      snapshot: id(5),
      objects: [
        {
          id: id(6),
          object: {
            kind: 'directory_revision',
            body: { parents: [], name: '' },
          },
        },
        {
          id: id(7),
          object: {
            kind: 'source_revision',
            body: { parents: [], directory_id: 'root', name: '合成原文.txt' },
          },
        },
        {
          id: id(8),
          object: { kind: 'bytes', body: { bytes_base64: 'YQ==' } },
        },
        {
          id: id(9),
          object: {
            kind: 'entry_revision',
            body: {
              parents: [id(1)],
              directory_id: 'root',
              content: { statement: '合成事实支持本机副本保留' },
            },
          },
        },
      ],
    },
  });
  assert.deepEqual(content(rows).slice(0, 5), [
    '● write knowledge',
    'new · folder · /',
    'new · source · 合成原文.txt',
    'edit · entry · 合成事实支持本机副本保留',
    'with 1 byte chunk of original text',
  ]);
  assert.doesNotMatch(rows.join('\n'), HASH);
});

test('sync connection, mode and login cards are their own actions, not knowledge writes', (t) => {
  const connect = card(t, 'knowledge_connect', {
    change: {
      action: 'select sync connection',
      server: '团队服务器',
      origin: 'https://192.0.2.10',
      retained_local_items: 12,
    },
  });
  assert.deepEqual(content(connect).slice(0, 4), [
    '● connect sync server',
    '团队服务器 · https://192.0.2.10',
    '12 local items will sync with this account',
    'local files stay',
  ]);
  const mode = card(t, 'knowledge_mode', {
    change: {
      mode: 'local',
      personal_bytes: 4096,
      directory_grants: 2,
      pending_shares: 'unknown',
      team_copies_preserved: 1,
    },
  });
  assert.deepEqual(content(mode).slice(0, 5), [
    '● change sync mode',
    'to local only',
    'removes 4 KB of personal content from the server',
    'ends 2 folder grants · pending shares unknown',
    'the local copy stays · 1 team copy stay',
  ]);
  const login = card(t, 'knowledge_login', {
    change: { server: 'team server' },
  });
  assert.equal(content(login)[0], '● sign in again');
  for (const rows of [connect, mode, login]) {
    assert.doesNotMatch(rows.join('\n'), /knowledge_write|KnowledgeWrite/);
    assert.match(rows.join('\n'), /changes the knowledge sync connection/);
  }
});

test('a share card names the entry and the team path', (t) => {
  const rows = card(t, 'knowledge_share', {
    snapshot: id(1),
    object: id(2),
    team_path: '/部署',
    action: 'share to team',
    title: '合成事实支持本机副本保留',
    replaces: true,
  });
  assert.deepEqual(content(rows).slice(0, 4), [
    '● share to team',
    '合成事实支持本机副本保留',
    'to team /部署',
    'replaces the team copy it was shared as',
  ]);
  assert.doesNotMatch(rows.join('\n'), HASH);
});

test('transcript rows show titles and paths, never hashes, at 60 columns', () => {
  const row = (name: string, args: Record<string, unknown>, result?: any) =>
    stripAnsi(
      toolRow({ id: 'r', name, args }, result, { width: 60 }),
    ).trimEnd();
  assert.equal(
    row('memory_write', { expected_head: id(1), title: '同步注意事项' }),
    ' ● MemoryWrite(同步注意事项)',
  );
  assert.equal(
    row('knowledge_write', {
      expected_head: id(1),
      objects: [
        {
          kind: 'entry_revision',
          body: { parents: [], content: { statement: '合成事实' } },
        },
        { kind: 'bytes', body: {} },
      ],
    }),
    ' ● KnowledgeWrite(new · entry · 合成事实)',
  );
  assert.equal(
    row('knowledge_read', { snapshot: id(1), object: id(2) }),
    ' ● KnowledgeRead()',
  );
  assert.equal(
    row('knowledge_share', { snapshot: id(1), object: id(2) }),
    ' ● KnowledgeShare()',
  );
  assert.equal(
    toolArgSummary({
      name: 'knowledge_share',
      args: { object: id(2), title: '合成事实' },
    }),
    '合成事实',
  );
  assert.equal(
    toolArgSummary({ name: 'knowledge_read', args: { object: 'schema' } }),
    'write format',
  );
  for (const name of [
    'knowledge_write',
    'knowledge_read',
    'knowledge_share',
    'memory_write',
  ])
    assert.doesNotMatch(
      toolArgSummary({ name, args: { expected_head: id(1), object: id(2) } }),
      HASH,
    );
});

test('knowledge results read as words; a refused share shows the server text', () => {
  const rows = (name: string, text: string, error = false) =>
    resultRows(
      { id: 'r', name, args: {} },
      {
        id: 'm',
        role: 'tool',
        content: text,
        ...(error ? { status: 'error' } : {}),
      } as any,
      { width: 60, expanded: false },
    ).map((row) => stripAnsi(row).trimEnd());
  assert.deepEqual(
    rows(
      'memory_write',
      JSON.stringify({
        snapshot: id(1),
        scope: 'local',
        server_verified: false,
      }),
    ),
    ['   ⎿ saved locally · not yet on the sync server'],
  );
  assert.deepEqual(
    rows(
      'knowledge_share',
      JSON.stringify({ shared: true, reference: 'tree:' + id(1) }),
    ),
    ['   ⎿ shared to team'],
  );
  const refused = rows(
    'knowledge_share',
    'refused: 上传原文需上传人署名 请上传人署名后重试',
    true,
  );
  assert.match(refused.join('\n'), /refused: 上传原文需上传人署名/);
  assert.deepEqual(
    refusalLines(
      new KnowledgeShareRefused({
        code: 'SHARE_UPLOAD_UNSIGNED',
        message: '上传原文需上传人署名',
        fix: '请上传人署名后重试',
        confirmation: {
          url: 'https://192.0.2.10/console/upload',
          expiresAt: '2026-11-03T14:30:00.000Z',
        },
      }),
    ),
    [
      'refused: 上传原文需上传人署名 请上传人署名后重试',
      "confirm the source upload in the server's console before 14:30: https://192.0.2.10/console/upload",
    ],
  );
  assert.deepEqual(
    rows(
      'knowledge_search',
      JSON.stringify({
        snapshot: id(1),
        items: [
          {
            itemId: 'i',
            objectId: id(2),
            path: '/部署',
            kind: 'entry',
            status: 'verified',
            statement: '合成事实',
          },
        ],
        next: null,
      }),
    ),
    ['   ⎿ 合成事实 · /部署 · verified'],
  );
  assert.equal(knowledgeResultLines('read_file', 'x', false), undefined);
  for (const line of rows(
    'knowledge_read',
    JSON.stringify({
      snapshot: id(1),
      object: id(2),
      kind: 'entry_revision',
      text: '{}',
      next: null,
      verification: { status: 'verified' },
    }),
  ))
    assert.doesNotMatch(line, HASH);
});

test('every knowledge action has an approval preview; other tools keep theirs', () => {
  for (const name of [
    'knowledge_write',
    'memory_write',
    'knowledge_share',
    'knowledge_connect',
    'knowledge_mode',
    'knowledge_login',
  ])
    assert.ok(knowledgeApproval(name, {}), name);
  assert.equal(knowledgeApproval('write_file', {}), null);
  assert.equal(knowledgeArgSummary('read_file', {}), undefined);
});
