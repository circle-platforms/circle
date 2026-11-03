// Runtime acceptance is always delegated to the committed protocol mirror.
export interface SyncState {
  epoch: string;
  mode: 'hub' | 'local';
  status: 'idle' | 'syncing' | 'conflicted' | 'purging' | 'complete';
  state_version: string;
  snapshot: string | null;
  last_synced_at: string | null;
  used_bytes: number;
  capacity_bytes: number;
  limits: {
    object_bytes: number;
    batch_bytes: number;
    batch_objects: number;
    page_items: number;
    session_seconds: number;
  };
}
export interface SyncReceipt {
  operation_id: string;
  epoch: string;
  request: string;
  previous_state: string | null;
  state_version: string;
  counts: {
    accepted: number;
    existing: number;
    downloaded: number;
    bytes: number;
  };
  at: string;
}
export interface SyncResult {
  state: SyncState;
  receipt: SyncReceipt;
  verification: unknown[];
  conflicts: { item_id: string; heads: string[]; structural?: boolean }[];
  projections?: unknown[];
  next: string | null;
}
export interface SyncSession {
  session_id: string;
  expires_at: string;
  state: SyncState;
  inventory_cursor: string | null;
}
export interface SyncDescriptor {
  id: string;
  kind: string;
  bytes: number;
}
export interface SyncInventory {
  snapshot: string;
  objects: SyncDescriptor[];
  next: string | null;
}
export interface SyncTransfer {
  objects: { id: string; bytes_base64: string }[];
  missing: string[];
}
export interface ModeImpact {
  check: string;
  expected_state: string;
  mode: 'local' | 'hub';
  personal_bytes: number;
  directory_grants: number;
  pending_shares: number | null;
  team_copies_preserved: number;
}
export type SyncCondition =
  | 'pending'
  | 'synced'
  | 'conflicted'
  | 'offline'
  | 'login-required'
  | 'paused'
  | 'local'
  | 'capacity'
  | 'invalid';
