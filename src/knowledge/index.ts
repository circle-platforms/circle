export {
  KnowledgeStore,
  KnowledgeVersionConflict,
  type SearchHit,
  type SearchOptions,
} from './store.js';
export {
  encodeSyncObject,
  decodeSyncObject,
  computeObjectDigest,
  formatJcs,
  normalizeSyncText,
} from './canonical.js';
export { validateSync, SYNC_LIMITS, SYNC_PROTOCOL } from './protocol.js';
export { knowledgeTokens } from './search.js';
export {
  validateGraph,
  findLowestCommonAncestor,
  resolveEffectiveHead,
  type SnapshotGraph,
  type ValidateGraphOptions,
} from './graph.js';
export type {
  SyncObject,
  SyncItem,
  PackManifest,
  EntryContent,
  Ground,
} from './types.js';

export {
  KnowledgeService,
  type KnowledgeAccess,
  type PreparedKnowledgeChange,
} from './service.js';
export {
  verifyLocal,
  LOCAL_VERIFIER,
  WORKSPACE_VERIFIER,
  matchTextQuote,
  refineSelectorWithQuote,
  checkWorkspaceFreshness,
  type Verification,
} from './verification.js';
export {
  installPersonalPack,
  setPersonalPackEnabled,
  installedPersonalPacks,
} from './packs.js';

export { KnowledgeSync, type SyncOptions } from './sync.js';
export { SyncHttp, SyncHttpError, type SyncTransport } from './sync-http.js';
export { mergeSnapshots } from './merge.js';
export type {
  SyncState,
  SyncReceipt,
  SyncResult,
  SyncCondition,
  ModeImpact,
} from './sync-types.js';
