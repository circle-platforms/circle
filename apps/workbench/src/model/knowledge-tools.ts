import { t, tn } from '../i18n/index.ts';
import { BUILTIN_TOOL_INFO } from './tool-info.ts';

// Readable words for the knowledge and memory tools in a conversation: what the call
// does, to which item, and what a person confirms. Hashes, object ids and snapshots
// stay in the technical details.

export const KNOWLEDGE_TOOLS = [
  'knowledge_search',
  'knowledge_read',
  'knowledge_write',
  'knowledge_share',
  'memory_write',
] as const;
export type KnowledgeToolName = (typeof KNOWLEDGE_TOOLS)[number];
export const isKnowledgeTool = (name?: string): name is KnowledgeToolName =>
  !!name && (KNOWLEDGE_TOOLS as readonly string[]).includes(name);

/** The card title the tool list gives the call: "write memory", not memory_write. */
export function knowledgeToolTitle(name: string): string {
  const info = BUILTIN_TOOL_INFO.find((tool) => tool.name === name) as
    { title?: string } | undefined;
  return info?.title ?? name;
}

type Input = Record<string, unknown> | undefined;
const record = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
const words = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const lines = (value: unknown): number =>
  typeof value === 'string' && value ? value.split(/\r\n|\r|\n/).length : 0;
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

interface ChangeObject {
  kind: string;
  body: Record<string, any>;
}
/** The proposed objects, from the prepared preview when the core attached one. */
function changeObjects(input: Input): ChangeObject[] {
  const prepared = record(input?.change)?.objects;
  const raw = Array.isArray(prepared)
    ? prepared.map((item: any) => item?.object)
    : Array.isArray(input?.objects)
      ? input.objects
      : [];
  return raw
    .map(record)
    .filter(
      (object): object is ChangeObject =>
        typeof object?.kind === 'string' && !!record(object.body),
    );
}
const objectLabel = (object: ChangeObject): string =>
  words(object.body.title) ||
  words(object.body.content?.statement) ||
  words(object.body.name) ||
  words(object.body.manifest?.title);

export interface KnowledgeChangePreview {
  /** new, update, delete, enable, disable or share */
  verb: string;
  /** Where it lands, joined with " › " */
  location: string;
  lines: number;
  more: number;
  replaces: boolean;
}
/**
 * What a write or share would do, in words: "new · mine › deploy › sync notes · 12 lines".
 * Folders named in the same change are part of the location; other folders are not known here.
 */
export function knowledgeChangePreview(
  name: string,
  input: Input,
): KnowledgeChangePreview | undefined {
  if (name === 'knowledge_share') {
    const title = words(input?.title);
    const team = words(input?.team_path).split('/').filter(Boolean);
    return {
      verb: t('share to team'),
      location: [t('team'), ...team, ...(title ? [title] : [])].join(' › '),
      lines: 0,
      more: 0,
      replaces: input?.replaces === true,
    };
  }
  if (name !== 'memory_write' && name !== 'knowledge_write') return undefined;
  const objects = changeObjects(input);
  const folders = new Map(
    objects
      .filter((object) => object.kind === 'directory_revision')
      .map((object) => [String(object.body.item_id), object.body]),
  );
  const items = objects.filter(
    (object) => object.kind !== 'directory_revision' && object.kind !== 'bytes',
  );
  const main = items[0] ?? objects[0];
  const path: string[] = [];
  for (
    let folder = folders.get(String(main?.body.directory_id));
    folder && path.length < 16;
    folder = folders.get(String(folder.parent_directory))
  )
    if (words(folder.name)) path.unshift(words(folder.name));
  const title =
    (main && objectLabel(main)) ||
    (name === 'memory_write' ? words(input?.title) : '');
  const deleting = input?.delete === true || main?.kind === 'deletion';
  const state = main?.body.state ?? input?.state;
  const fresh = Array.isArray(main?.body.parents)
    ? main.body.parents.length === 0
    : name === 'memory_write' && !input?.item_id;
  const verb = deleting
    ? t('delete')
    : fresh
      ? t('new')
      : name === 'memory_write' &&
          typeof input?.markdown !== 'string' &&
          (state === 'enabled' || state === 'disabled')
        ? state === 'enabled'
          ? t('enable')
          : t('disable')
        : t('update');
  return {
    verb,
    location: [t('mine'), ...path, ...(title ? [title] : [])].join(' › '),
    lines: deleting
      ? 0
      : lines(main?.body.markdown ?? input?.markdown) ||
        lines(main?.body.content?.statement),
    more: Math.max(0, items.length - 1),
    replaces: false,
  };
}
export function knowledgeChangeText(preview: KnowledgeChangePreview): string {
  return [
    preview.verb,
    preview.location,
    ...(preview.lines ? [tn(preview.lines, '{n} line', '{n} lines')] : []),
    ...(preview.more
      ? [tn(preview.more, '{n} more item', '{n} more items')]
      : []),
  ].join(' · ');
}
/** The approval button names the action. */
export function knowledgeConfirmLabel(name: string, input: Input): string {
  if (name === 'knowledge_share')
    return input?.replaces === true
      ? t('confirm replace')
      : t('confirm share to team');
  const preview = knowledgeChangePreview(name, input);
  return preview?.verb === t('delete')
    ? t('confirm delete')
    : t('confirm write');
}

/** The short target beside a call's title: the words searched for, or the item's title. */
export function knowledgeToolTarget(
  name: string,
  input: Input,
  output = '',
): string {
  if (name === 'knowledge_search') {
    const query = words(input?.query);
    return query ? '“' + query + '”' : '';
  }
  if (name === 'knowledge_read') {
    const read = record(parse(output));
    const object = record(
      typeof read?.text === 'string' && read.next === null
        ? parse(read.text)
        : undefined,
    );
    const body = record(object?.body);
    return body ? objectLabel({ kind: String(object!.kind), body }) : '';
  }
  const preview = knowledgeChangePreview(name, input);
  return preview ? preview.location : '';
}
/** What a finished call came to, when its output says so plainly. */
export function knowledgeToolResult(
  name: string,
  output: string,
  status: string,
): string {
  if (status !== 'success') return '';
  const result = record(parse(output));
  if (name === 'knowledge_search' && Array.isArray(result?.items))
    return result.items.length
      ? tn(result.items.length, '{n} match', '{n} matches') +
          (result.next ? ' · ' + t('more available') : '')
      : t('no matches');
  if (name === 'memory_write' && typeof result?.snapshot === 'string')
    return t('written to my memory');
  if (name === 'knowledge_write' && typeof result?.snapshot === 'string')
    return t('written to my knowledge');
  if (name === 'knowledge_share' && result?.shared === true)
    return t('shared to team');
  return '';
}
/** The memory item a finished memory write created or changed, for its link. */
export function writtenMemoryItem(
  name: string,
  input: Input,
  output: string,
  status: string,
): string | undefined {
  if (name !== 'memory_write' || !knowledgeToolResult(name, output, status))
    return undefined;
  if (input?.delete === true) return undefined;
  const memory = changeObjects(input).find(
    (object) => object.kind === 'memory_revision',
  );
  const id = memory?.body.item_id ?? input?.item_id;
  return typeof id === 'string' && id ? id : undefined;
}
