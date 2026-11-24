import { trustedAppUrl } from './policy';

export interface SenderFrameInfo {
  routingId: number;
  processId: number;
  url: string;
}

export interface SenderWebContentsInfo {
  isDestroyed: () => boolean;
  isCrashed: () => boolean;
  mainFrame: {
    routingId: number;
    processId: number;
  };
}

export interface SenderWindowCandidate {
  webContents: SenderWebContentsInfo;
}

/**
 * Returns only live, un-crashed application windows safe to broadcast IPC events to.
 */
export function liveBroadcastTargets<T extends SenderWindowCandidate>(
  windows: readonly T[],
): T[] {
  return windows.filter(
    (one) => !one.webContents.isDestroyed() && !one.webContents.isCrashed(),
  );
}

/**
 * Returns the owning application window only when an IPC event originates from
 * an alive, un-crashed main frame of one of our windows at a trusted app URL.
 */
export function verifyAppWindowSender<T extends SenderWindowCandidate>(
  windows: readonly T[],
  event: {
    sender: unknown;
    senderFrame: SenderFrameInfo | null | undefined;
  },
): T {
  const own = windows.find((one) => one.webContents === event.sender);
  if (
    !own ||
    own.webContents.isDestroyed() ||
    own.webContents.isCrashed() ||
    !event.senderFrame ||
    event.senderFrame.routingId !== own.webContents.mainFrame.routingId ||
    event.senderFrame.processId !== own.webContents.mainFrame.processId ||
    !trustedAppUrl(event.senderFrame.url)
  )
    throw Error('untrusted IPC sender');
  return own;
}
