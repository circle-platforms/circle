import type { Server } from 'node:net';

export const REFUSED_PORTS: ReadonlySet<number>;
export function listenForBrowser(
  server: Server,
  refused?: ReadonlySet<number>,
): Promise<number>;

export interface LoopbackEvent {
  /** Milliseconds since the server began to listen. */
  at: number;
  event: 'connection' | 'request' | 'answered' | 'closed unanswered';
  /** The browser's own port, for a connection. */
  from?: number;
  method?: string;
  /** The request's path, without its query. */
  path?: string;
  status?: number;
}
export interface LoopbackEvidence {
  port: number;
  since: string;
  events: LoopbackEvent[];
}
export function loopbackEvidence(server?: Server): LoopbackEvidence[];
