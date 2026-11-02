export {
  KnowledgeStore,
  KnowledgeVersionConflict,
  type SearchHit,
  type SearchOptions,
} from './store.js';
export {
  encodeSyncObject,
  decodeSyncObject,
  syncObjectId,
  normalizeSyncText,
} from './canonical.js';
export { validateSync, SYNC_LIMITS, SYNC_PROTOCOL } from './protocol.js';
export { knowledgeTokens } from './search.js';
export type {
  SyncObject,
  SyncItem,
  PackManifest,
  EntryContent,
  Ground,
} from './types.js';
