import { wellFormedText } from './unicode.js';
// Safe desktop data and the explicit host operation vocabulary. No filesystem or network imports.
export type KnowledgeSection = 'knowledge' | 'memory' | 'workflows';
export type KnowledgeScope = 'personal' | 'team' | 'shared';
export type KnowledgeKind =
  'folder' | 'entry' | 'source' | 'memory' | 'workflow' | 'skill';
export interface KnowledgeRow {
  id: string;
  token: string;
  kind: KnowledgeKind;
  title: string;
  path: string;
  status:
    | 'verified'
    | 'unverified'
    | 'conflicted'
    | 'enabled'
    | 'disabled'
    | 'deleted';
  sources: number;
  availability?:
    'available' | 'manifest-only' | 'disabled' | 'conflicted' | 'unavailable';
  installed?: boolean;
  enabled?: boolean;
  loaded?: boolean;
  loadState?: 'loaded' | 'partial' | 'earlier' | 'not-loaded';
}
export interface KnowledgeSource {
  id: string;
  name: string;
  location: string;
  quotation: string;
  truncated?: boolean;
  available: boolean;
}
export interface KnowledgeDetail extends KnowledgeRow {
  /** A recorded local commit time; unknown for old or remote revisions without a supplied time. */
  updatedAt?: string | null;
  text: string;
  truncated: boolean;
  sourcesList: KnowledgeSource[];
  candidates: { token: string; title: string; text: string }[];
  history: { token: string; title: string; current: boolean }[];
  historyMore?: boolean;
  files?: { name: string; bytes: number }[];
  description?: string;
  share: 'local' | 'waiting' | 'ready' | 'unavailable';
}
export interface KnowledgeSyncView {
  /** Explicit host binding state; optional for older preview snapshots. */
  bound?: boolean;
  condition:
    | 'synced'
    | 'pending'
    | 'offline'
    | 'login-required'
    | 'conflicted'
    | 'local'
    | 'paused'
    | 'capacity'
    | 'invalid';
  mode: 'hub' | 'local' | null;
  clearing: boolean;
  server: string;
  lastSyncedAt: string | null;
  /** The server's own text for the last refusal, shown as it came. */
  detail?: string | null;
  /** Where the account holder confirms a requested purge, until it expires. */
  confirmation?: { url: string; expiresAt: string } | null;
  /** `fallback`: the server has no discovery document and fixed v1 paths are used. */
  discovery?: 'document' | 'fallback' | null;
  syncing?: boolean;
}
export interface KnowledgeList {
  rows: KnowledgeRow[];
  total: number;
  more: boolean;
  folder: string;
  sync: KnowledgeSyncView;
  incomplete: boolean;
}
/** A refusal the server explained: its code, its text and its fix ('' when it gave none). */
export interface KnowledgeShareRefusal {
  code: string;
  message: string;
  fix: string;
  confirmation?: { url: string; expiresAt: string } | null;
}
export interface KnowledgePreview {
  ticket: string;
  action: string;
  title: string;
  text?: string;
  replaces?: boolean;
  impact?: {
    bytes: number;
    grants: number;
    pending: number | null;
    teamCopies: number;
  };
  files?: { name: string; bytes: number }[];
  /** Connecting: this account has never finished a sync on this device. */
  firstSync?: boolean;
}
export const KNOWLEDGE_OPERATIONS = [
  'list',
  'detail',
  'edit-body',
  'source',
  'history',
  'settings',
  'sync',
  'refresh-memory',
  'login',
  'disconnect',
  'prepare',
  'confirm',
  'cancel',
  'install-pick',
  'prepare-install',
  'pack-pick',
  'prepare-register',
  'import-pick',
  'prepare-import',
] as const;
export type KnowledgeOperation = (typeof KNOWLEDGE_OPERATIONS)[number];
const fields: Record<KnowledgeOperation, readonly string[]> = {
  list: [
    'section',
    'scope',
    'query',
    'filter',
    'folder',
    'offset',
    'sort',
    'direction',
  ],
  detail: ['id', 'token'],
  'edit-body': ['id', 'token'],
  source: ['id'],
  history: ['id', 'token'],
  settings: [],
  sync: [],
  'refresh-memory': [],
  login: [],
  disconnect: [],
  prepare: [
    'action',
    'id',
    'token',
    'title',
    'text',
    'destination',
    'candidate',
    'server',
    'mode',
    'enabled',
    'teamPath',
  ],
  confirm: ['ticket', 'confirmed'],
  cancel: ['ticket'],
  'install-pick': ['id', 'token'],
  'prepare-install': ['id', 'token', 'directory'],
  'pack-pick': [],
  'prepare-register': ['directory'],
  'import-pick': ['destination'],
  'prepare-import': ['path', 'destination'],
};
/** Public invocations cannot supply a home, path, SQL, URL, reference or trusted native selection. */
export function validateKnowledgeRequest(
  value: unknown,
  nativeSelection = false,
): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid knowledge request');
  const p = value as Record<string, any>,
    op = p.op as KnowledgeOperation;
  if (
    !KNOWLEDGE_OPERATIONS.includes(op) ||
    (['prepare-install', 'prepare-register', 'prepare-import'].includes(op) &&
      !nativeSelection)
  )
    throw Error('invalid knowledge operation');
  if (JSON.stringify(value).length > 1500000)
    throw Error('knowledge request too large');
  for (const [key, part] of Object.entries(p)) {
    if (key === 'op') continue;
    if (!fields[op].includes(key)) throw Error('invalid knowledge field');
    if (['confirmed', 'enabled'].includes(key)) {
      if (typeof part !== 'boolean') throw Error('invalid knowledge flag');
    } else if (key === 'offset') {
      if (!Number.isSafeInteger(part) || part < 0 || part > 100000)
        throw Error('invalid knowledge offset');
    } else if (
      typeof part !== 'string' ||
      part.length >
        (key === 'text'
          ? 300000
          : ['directory', 'path'].includes(key)
            ? 8000
            : 4000) ||
      !wellFormedText(part)
    )
      throw Error('invalid knowledge text');
  }
  if (p.sort !== undefined && !['title', 'kind', 'status'].includes(p.sort))
    throw Error('invalid knowledge sort');
  if (p.direction !== undefined && !['asc', 'desc'].includes(p.direction))
    throw Error('invalid knowledge direction');
  if (
    p.section !== undefined &&
    !['knowledge', 'memory', 'workflows'].includes(p.section)
  )
    throw Error('invalid knowledge section');
  if (
    p.scope !== undefined &&
    !['personal', 'team', 'shared'].includes(p.scope)
  )
    throw Error('invalid knowledge scope');
  if (p.mode !== undefined && !['hub', 'local'].includes(p.mode))
    throw Error('invalid sync mode');
  if (p.query !== undefined && p.query.length > 200)
    throw Error('knowledge search too long');
  return p;
}
