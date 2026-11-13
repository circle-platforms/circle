import type { LampState } from '../ink/theme.js';
import type { CardLine } from '../ink/components/dialog_card.js';
import type { KnowledgeConnectionStatus } from '../knowledge/connection.js';
import { terminalText } from '../ink/components/markdown_renderer.js';

export const modeWord = (mode: 'hub' | 'local' | null | undefined): string =>
  mode === 'hub' ? 'synced' : mode === 'local' ? 'local only' : 'unknown';
export function modeArgument(word: string): 'hub' | 'local' | null {
  return word === 'synced' ? 'hub' : word === 'local' ? 'local' : null;
}

const two = (n: number) => String(n).padStart(2, '0');
export function shortTime(iso: string): string {
  const at = new Date(iso);
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}
const clock = (iso: string): string => {
  const at = new Date(iso);
  return `${two(at.getHours())}:${two(at.getMinutes())}`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const teamCopies = (n: number) => `${n} team ${n === 1 ? 'copy' : 'copies'}`;
const oneLine = (text: string) =>
  terminalText(text).replace(/\s+/g, ' ').trim();
const HASH = /\b[0-9a-f]{64}\b/;

export function conditionWord(status: KnowledgeConnectionStatus): string {
  if (status.confirmation) return 'paused · purge waits for you';
  if (status.syncing && ['pending', 'synced'].includes(status.condition))
    return 'syncing';
  return (
    {
      synced: 'synced',
      pending: 'pending',
      conflicted: 'conflict',
      offline: 'offline',
      'login-required': 'paused · login required',
      paused: 'paused',
      local: 'local only',
      capacity: 'paused · server space full',
      invalid: 'paused · needs attention',
    } as const
  )[status.condition];
}

/**
 * The `/knowledge status` block: where sync stands on the first line, what is here and
 * the next step on the second, then the server's own words when it refused something.
 */
export function knowledgeStatusLines(
  status: KnowledgeConnectionStatus,
  counts: { items: number; conflicts: number },
): string[] {
  const items = plural(counts.items, 'item');
  if (!status.server)
    return [
      'knowledge · local only · no sync server',
      `  ${items} · /knowledge connect to choose a sync server`,
    ];
  const head = [
    'knowledge',
    conditionWord(status),
    oneLine(status.server),
    ...(status.lastSyncedAt
      ? [`last synced ${shortTime(status.lastSyncedAt)}`]
      : []),
  ].join(' · ');
  let next: string;
  if (status.confirmation)
    next = `confirm the purge in the server's console before ${clock(status.confirmation.expiresAt)}: ${status.confirmation.url}`;
  else if (status.condition === 'login-required')
    next = 'run /knowledge login to sign in again';
  else if (counts.conflicts)
    next = `${items} · ${plural(counts.conflicts, 'conflict')} · /knowledge conflicts`;
  else
    next =
      items +
      (
        {
          synced: '',
          pending: status.syncing ? '' : ' · /knowledge sync to sync now',
          conflicted: ' · /knowledge conflicts',
          offline: ' · retrying · /knowledge sync to try now',
          paused: ' · /knowledge sync to resume',
          local: ' · /knowledge mode synced to sync again',
          capacity: " · ask the server's administrator for more space",
          invalid: ' · /knowledge sync to try again',
          'login-required': '',
        } as const
      )[status.condition];
  return [
    head,
    '  ' + next,
    ...(status.detail ? ['  refused: ' + oneLine(status.detail)] : []),
    ...(status.discovery === 'fallback'
      ? [
          '  the server publishes no discovery document · fixed v1 paths · no team sharing or team memory',
        ]
      : []),
  ];
}

/** `showing 100 of 342 · …` when a list holds back the rest; nothing when all fit. */
export function truncationLine(shown: number, total: number): string | null {
  return total > shown
    ? `showing ${shown} of ${total} · narrow with /knowledge search <words>`
    : null;
}

/**
 * The footer status of the bound server, lit as the contract's lamps are: yellow only while
 * it talks to the server, cyan when it waits for you, red when it failed, green when synced,
 * unlit while changes only wait to be sent.
 */
export function knowledgeLamp(status: KnowledgeConnectionStatus): {
  text: string;
  lamp: LampState;
} {
  if (status.confirmation) return { text: 'purge waits for you', lamp: 'wait' };
  if (status.syncing && ['pending', 'synced'].includes(status.condition))
    return { text: 'syncing', lamp: 'running' };
  const table: Record<
    KnowledgeConnectionStatus['condition'],
    [string, LampState]
  > = {
    synced: ['synced', 'ok'],
    pending: ['sync pending', 'none'],
    conflicted: ['sync conflict', 'wait'],
    offline: ['sync offline', 'error'],
    'login-required': ['sync login required', 'wait'],
    paused: ['sync paused', 'none'],
    local: ['local only', 'none'],
    capacity: ['sync space full', 'error'],
    invalid: ['sync needs attention', 'error'],
  };
  const [text, lamp] = table[status.condition];
  return { text, lamp };
}

/**
 * The notice a runtime `knowledge_sync` change leaves in the transcript: only the changes
 * the person has to act on (a conflict, a login, a pause, a purge to confirm), once each.
 */
export function knowledgeSyncNotice(
  previous: string | undefined,
  status: KnowledgeConnectionStatus,
): { key: string; text: string | null } {
  const key = status.server
    ? `${status.condition}${status.confirmation ? ':confirm' : ''}`
    : 'none';
  if (key === previous || !status.server) return { key, text: null };
  const text = status.confirmation
    ? "knowledge · paused · confirm the purge in the server's console · /knowledge status"
    : status.condition === 'conflicted'
      ? 'knowledge · conflict · /knowledge conflicts'
      : status.condition === 'login-required'
        ? 'knowledge · paused · login required · /knowledge login'
        : status.condition === 'paused' && previous !== undefined
          ? 'knowledge · sync paused · /knowledge status'
          : null;
  return { key, text };
}

type Shown = Record<string, any>;
const KIND_WORDS: Record<string, string> = {
  entry_revision: 'entry',
  source_revision: 'source',
  directory_revision: 'folder',
  memory_revision: 'memory',
  pack_manifest: 'workflow',
};
function objectLine(
  object: Shown,
  path: (directory: string) => string | undefined,
): string | null {
  const kind = object?.kind,
    body = object?.body ?? {};
  if (kind === 'deletion')
    return `delete · ${KIND_WORDS[body.target_kind] ?? 'item'}`;
  const word = KIND_WORDS[kind];
  if (!word) return null;
  const action =
    Array.isArray(body.parents) && body.parents.length ? 'edit' : 'new';
  const name =
    kind === 'entry_revision'
      ? body.content?.statement
      : kind === 'memory_revision'
        ? body.title
        : kind === 'directory_revision'
          ? body.name || '/'
          : kind === 'source_revision'
            ? body.name
            : body.manifest?.title;
  const where =
    typeof body.directory_id === 'string' ? path(body.directory_id) : undefined;
  const label = oneLine(String(name ?? ''));
  return [
    action,
    word,
    ...(where && where !== '/'
      ? [oneLine(where.replace(/^\//, '').split('/').join(' / '))]
      : []),
    ...(label && !HASH.test(label) ? [label] : []),
  ].join(' · ');
}
const lineCount = (text: string) =>
  text ? text.replace(/\n$/, '').split('\n').length : 0;
const MAX_PREVIEW = 12;
function textPreview(text: string): CardLine[] {
  const lines = text.replace(/\n$/, '').split('\n');
  return [
    ...lines.slice(0, MAX_PREVIEW).map((line) => ({
      text: '+ ' + terminalText(line),
      tone: 'added' as const,
    })),
    ...(lines.length > MAX_PREVIEW
      ? [
          {
            text: `… +${lines.length - MAX_PREVIEW} lines`,
            tone: 'faint' as const,
          },
        ]
      : []),
  ];
}

export const KNOWLEDGE_ACTIONS = new Set([
  'knowledge_write',
  'memory_write',
  'knowledge_share',
  'knowledge_connect',
  'knowledge_mode',
  'knowledge_login',
]);
/**
 * The approval card of a knowledge action: a short title saying what it does, then what
 * changes in words. Names and paths are shown, never object IDs, heads or references.
 * `path` resolves a folder's item ID to its path in the current local snapshot.
 */
export function knowledgeApproval(
  name: string,
  args: Shown,
  path: (directory: string) => string | undefined = () => undefined,
): { title: string; body: string; preview: CardLine[] } | null {
  const change: Shown = args.change ?? {};
  if (name === 'memory_write' || name === 'knowledge_write') {
    const objects: Shown[] = Array.isArray(change.objects)
      ? change.objects.map((o: Shown) => o.object ?? o)
      : Array.isArray(args.objects)
        ? args.objects
        : [];
    const shown = objects
      .map((object) => objectLine(object, path))
      .filter((line): line is string => line !== null);
    const memory = objects.find((o) => o?.kind === 'memory_revision');
    const chunks = objects.filter((o) => o?.kind === 'bytes').length;
    if (name === 'memory_write') {
      const body = memory?.body ?? {};
      const deleted = objects.some((o) => o?.kind === 'deletion');
      const markdown = typeof body.markdown === 'string' ? body.markdown : '';
      const where =
        typeof body.directory_id === 'string'
          ? path(body.directory_id)
          : undefined;
      const action = deleted
        ? 'delete'
        : !body.parents?.length
          ? 'new'
          : args.state === 'disabled'
            ? 'disable'
            : args.state === 'enabled'
              ? 'enable'
              : 'edit';
      const title = oneLine(String(body.title ?? args.title ?? ''));
      return {
        title: 'write memory',
        body: [
          action,
          [
            'mine',
            ...(where && where !== '/'
              ? [oneLine(where.replace(/^\//, '').split('/').join(' / '))]
              : []),
            ...(title ? [title] : []),
          ].join(' / '),
          ...(deleted ? [] : [plural(lineCount(markdown), 'line')]),
        ].join(' · '),
        preview:
          deleted || action === 'disable' || action === 'enable'
            ? []
            : textPreview(markdown),
      };
    }
    return {
      title: 'write knowledge',
      body: shown.length ? shown.slice(0, 8).join('\n') : 'no readable change',
      preview: [
        ...(shown.length > 8
          ? [{ text: `… +${shown.length - 8} more`, tone: 'faint' as const }]
          : []),
        ...(chunks
          ? [
              {
                text: `with ${plural(chunks, 'byte chunk')} of original text`,
                tone: 'faint' as const,
              },
            ]
          : []),
      ],
    };
  }
  if (name === 'knowledge_share') {
    const title = oneLine(String(args.title ?? ''));
    return {
      title: 'share to team',
      body: [
        title && !HASH.test(title) ? title : 'the selected entry',
        ...(typeof args.team_path === 'string' && args.team_path
          ? [`to team ${oneLine(args.team_path)}`]
          : []),
      ].join('\n'),
      preview: args.replaces
        ? [{ text: 'replaces the team copy it was shared as' }]
        : [],
    };
  }
  if (name === 'knowledge_connect')
    return {
      title: 'connect sync server',
      body: `${oneLine(String(change.server ?? ''))} · ${oneLine(String(change.origin ?? ''))}`,
      preview: [
        {
          text: `${plural(Number(change.retained_local_items) || 0, 'local item')} will sync with this account`,
        },
        // The first time this account syncs on this device: where its content goes, and how to keep it here (#502)
        ...(change.first_sync === true
          ? [
              { text: 'first sync on this device' },
              { text: 'local only any time: /knowledge mode local' },
            ]
          : []),
        { text: 'local files stay', tone: 'faint' as const },
      ],
    };
  if (name === 'knowledge_mode') {
    const local = change.mode === 'local';
    const kb = Math.ceil((Number(change.personal_bytes) || 0) / 1024);
    return {
      title: 'change sync mode',
      body: `to ${modeWord(change.mode)}`,
      preview: local
        ? [
            { text: `removes ${kb} KB of personal content from the server` },
            {
              text: `ends ${plural(Number(change.directory_grants) || 0, 'folder grant')} · pending shares ${change.pending_shares ?? 'unknown'}`,
            },
            {
              text: `the local copy stays · ${teamCopies(Number(change.team_copies_preserved) || 0)} stay`,
              tone: 'faint' as const,
            },
          ]
        : [
            {
              text: 'starts a new sync of the local copy',
              tone: 'faint' as const,
            },
          ],
    };
  }
  if (name === 'knowledge_login')
    return {
      title: 'sign in again',
      body: oneLine(String(change.server ?? '')),
      preview: [
        {
          text: 'forgets the old sign-in · choose the account again before syncing',
          tone: 'faint' as const,
        },
      ],
    };
  return null;
}

/** The transcript row's phrase for a knowledge tool: a title or path, never a hash. */
export function knowledgeArgSummary(
  name: string,
  args: Shown,
): string | undefined {
  const clean = (value: unknown) => {
    const text = typeof value === 'string' ? oneLine(value) : '';
    return text && !HASH.test(text) ? text : '';
  };
  if (name === 'knowledge_search') return clean(args.query);
  if (name === 'knowledge_read')
    return args.object === 'schema' ? 'write format' : '';
  if (name === 'memory_write')
    return (
      clean(args.title) ||
      (args.delete
        ? 'delete'
        : args.state === 'disabled'
          ? 'disable'
          : args.state === 'enabled'
            ? 'enable'
            : '')
    );
  if (name === 'knowledge_share')
    return clean(args.title) || clean(args.team_path);
  if (name === 'knowledge_write') {
    const objects: Shown[] = Array.isArray(args.objects) ? args.objects : [];
    const lines = objects
      .map((object) => objectLine(object, () => undefined))
      .filter((line): line is string => line !== null);
    if (!lines.length) return '';
    return lines.length > 1
      ? `${lines[0]} · +${lines.length - 1} more`
      : lines[0];
  }
  return undefined;
}

/**
 * The `⎿` lines of a knowledge tool's result, in words: what was saved or shared, the
 * matches by statement and path, a read by its kind. Errors keep their text (a refusal is
 * `refused: {detail}`); any hash left in a text is shortened to `…`.
 */
export function knowledgeResultLines(
  name: string,
  content: string,
  error: boolean,
): string[] | undefined {
  if (!KNOWLEDGE_TOOLS.has(name)) return undefined;
  const unhash = (text: string) => text.replace(/\b[0-9a-f]{64}\b/g, '…');
  if (error) return unhash(content).split('\n');
  let value: Shown;
  try {
    value = JSON.parse(content);
  } catch {
    return unhash(content).split('\n');
  }
  if (name === 'knowledge_write' || name === 'memory_write')
    return ['saved locally · not yet on the sync server'];
  if (name === 'knowledge_share')
    return [
      value.shared
        ? 'shared to team'
        : unhash(String(value.reason ?? 'not shared')),
    ];
  if (name === 'knowledge_search') {
    const items: Shown[] = Array.isArray(value.items) ? value.items : [];
    if (!items.length) return ['no matches'];
    return [
      ...items.map((hit) =>
        [oneLine(String(hit.statement ?? '')), hit.path, hit.status]
          .filter(Boolean)
          .join(' · '),
      ),
      ...(value.next ? ['more matches · ask for the next page'] : []),
    ];
  }
  if (name === 'knowledge_read') {
    if (value.schema)
      return [
        'write format · ' +
          plural(String(value.text ?? '').length, 'character'),
      ];
    return [
      [KIND_WORDS[value.kind] ?? value.kind, value.verification?.status]
        .filter(Boolean)
        .join(' · ') || 'read',
    ];
  }
  return undefined;
}
const KNOWLEDGE_TOOLS = new Set([
  'knowledge_search',
  'knowledge_read',
  'knowledge_write',
  'memory_write',
  'knowledge_share',
]);
