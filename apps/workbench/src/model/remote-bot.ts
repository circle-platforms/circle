import type { ChatFile } from '../../../../src/remote_bot_protocol.ts';
import { t } from '../i18n/index.ts';
import type { McpServer, Message, WorkbenchSnapshot } from './types.ts';

export const HUB_SERVER = 'Hub';

export type RemoteEvent = Pick<Message, 'id' | 'at' | 'role' | 'text'> & {
  files?: ChatFile[];
  cursor: number;
  delivery?: string | null;
};

export interface BotDiscovery {
  id: string;
  current: string;
  binding: string;
  name?: string;
}

export interface BotHistory {
  queued?: { request: string; at: string; text: string }[];
  fileDeliveries?: { id: string; slot: number; state: string }[];
  question?: string | null;
  events: RemoteEvent[];
  deliveries?: { id: string; state: string }[];
  active: { request: string; draft: string } | null;
}

export function findHubConnection(
  snapshot: Pick<WorkbenchSnapshot, 'mcp'>,
): McpServer | undefined {
  return snapshot.mcp.find((row) => row.name === HUB_SERVER);
}

export function isHubConnected(
  snapshot: Pick<WorkbenchSnapshot, 'mcp'>,
): boolean {
  return findHubConnection(snapshot)?.status === 'connected';
}

export function botIdentityKey(discovery: BotDiscovery): string {
  return JSON.stringify([discovery.binding, discovery.id, discovery.current]);
}

export function mergeDeliveryStates(
  history: Pick<BotHistory, 'deliveries' | 'fileDeliveries'>,
): Record<string, string> {
  return Object.fromEntries([
    ...(history.deliveries ?? []).map((row) => [row.id, row.state]),
    ...(history.fileDeliveries ?? []).map((row) => [
      `${row.id}:${row.slot}`,
      row.state,
    ]),
  ]);
}

export function deliveryText(state?: string | null): string | null {
  switch (state) {
    case 'sent':
      return t('private chat acknowledged');
    case 'unknown':
      return t('private chat delivery unknown');
    case 'refused':
      return t('private chat delivery refused');
    case 'unbound':
      return t('private chat not bound');
    case 'queued':
      return t('waiting for private chat delivery');
    default:
      return null;
  }
}
