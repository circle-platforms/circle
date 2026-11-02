// Portable projections of personal-sync-object@1; runtime acceptance comes from the pinned contract.
export interface Revision {
  item_id: string;
  parents: string[];
}
export interface Ground {
  source: string;
  parser: string;
  selector: string;
  quotation: string;
}
export interface EntryContent {
  kind: string;
  statement: string;
  data: Record<string, unknown>;
  applicability: Record<string, unknown> | null;
}
export interface PackManifest {
  schema: 'pack@1';
  id: string;
  version: string;
  kind: 'workflow' | 'skill';
  title: string;
  description: string;
  dependencies?: { pack: string; space?: string; version?: string }[];
  files: { path: string; sha256: string; size: number }[];
}
export interface SyncItem {
  kind:
    | 'directory_revision'
    | 'entry_revision'
    | 'source_revision'
    | 'memory_revision'
    | 'pack_manifest';
  item_id: string;
  heads: string[];
}
interface Bodies {
  bytes: { bytes_base64: string };
  source_revision: Revision & {
    directory_id: string;
    name: string;
    media_type: string;
    raw_sha256: string;
    size: number;
    chunks: string[];
  };
  entry_revision: Revision & {
    directory_id: string;
    content: EntryContent;
    grounds: Ground[];
  };
  directory_revision: Revision & {
    parent_directory: string | null;
    name: string;
  };
  memory_revision: Revision & {
    directory_id: string;
    title: string;
    markdown: string;
    state: 'enabled' | 'disabled';
  };
  pack_manifest: Revision & { manifest: PackManifest };
  inventory_page: { items: SyncItem[] };
  snapshot: { parents: string[]; pages: string[] };
  deletion: Revision & { target_kind: SyncItem['kind'] };
}
export type ObjectKind = keyof Bodies;
export type SyncObject<K extends ObjectKind = ObjectKind> = {
  [P in K]: { schema: 'personal-sync-object@1'; kind: P; body: Bodies[P] };
}[K];
export type ItemObject = SyncObject<SyncItem['kind'] | 'deletion'>;
export function itemKind(object: ItemObject): SyncItem['kind'] {
  return object.kind === 'deletion' ? object.body.target_kind : object.kind;
}
