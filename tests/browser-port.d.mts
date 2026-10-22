import type { Server } from 'node:net';

export const REFUSED_PORTS: ReadonlySet<number>;
export function listenForBrowser(
  server: Server,
  refused?: ReadonlySet<number>,
): Promise<number>;
