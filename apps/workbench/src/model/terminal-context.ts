import type { TerminalReplay } from '../../../desktop/src/workspace/terminal';
import type { Attachment, RuntimePort } from './types';
import { t } from '../i18n';

// The desktop text-file limit. Kept renderer-local to avoid importing Node path
// utilities from policy.ts; a contract test pins these two values together.
export const MAX_TERMINAL_SELECTION_BYTES = 4_000_000;

/** A user capture, never a file grant or a verified command receipt. */
export interface TerminalSelectionCapture {
  operationId: string;
  sourceSessionId: string;
  terminalId: string;
  terminalEpoch: string;
  outputSequence: number;
  capturedAt: string;
  cols: number;
  rows: number;
  /** xterm 6 returns zero-based buffer cells; the end is exclusive. */
  range: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
  text: string;
}

/**
 * Replay authenticates the resource identity through the existing session route.
 * The selected text remains user-provided content, just like a manual attachment.
 * No source path in this attachment grants access to any file or process.
 */
export async function appendTerminalSelection(
  runtime: RuntimePort,
  capture: TerminalSelectionCapture,
  replay: () => Promise<TerminalReplay>,
): Promise<void> {
  const expired = () => Error(t('terminal selection expired; select it again'));
  const current = () => {
    const state = runtime.getSnapshot();
    const session = state.sessions.find(
      (s) => s.id === capture.sourceSessionId,
    );
    if (
      state.activeSessionId !== capture.sourceSessionId ||
      !session ||
      session.lifecycle === 'deleting'
    )
      throw expired();
    return session;
  };
  const persist = (sessionId: string, attachments: Attachment[]) => {
    if (!runtime.updateSessionView(sessionId, { attachments }))
      throw Error(t('terminal selection could not be saved'));
  };
  const id = `terminal-selection:${capture.operationId}`;
  const initial = current();
  if (initial.attachments.some((item) => item.id === id)) {
    // A previous call may have changed memory before storage failed. Retrying
    // the operation must retry persistence without appending another capture.
    persist(initial.id, initial.attachments);
    return;
  }
  if (!capture.text) throw Error(t('select terminal output first'));
  if (
    new TextEncoder().encode(capture.text).byteLength >
    MAX_TERMINAL_SELECTION_BYTES
  )
    throw Error(t('terminal selection is over 4 MB'));
  let departed = false;
  const unsubscribe = runtime.subscribe(() => {
    if (runtime.getSnapshot().activeSessionId !== capture.sourceSessionId)
      departed = true;
  });
  try {
    const { snapshot } = await replay();
    if (departed) throw expired();
    const target = current();
    if (
      snapshot.id !== capture.terminalId ||
      snapshot.sessionId !== capture.sourceSessionId ||
      snapshot.epoch !== capture.terminalEpoch ||
      !Number.isSafeInteger(capture.outputSequence) ||
      capture.outputSequence < 0 ||
      capture.outputSequence > snapshot.lastSequence
    )
      throw Error(t('terminal selection source changed'));
    // Take the latest attachments after the asynchronous source check. Another
    // capture or a file picker may have appended context while replay was in flight.
    if (target.attachments.some((item) => item.id === id)) {
      persist(target.id, target.attachments);
      return;
    }
    const metadata = {
      kind: 'circle.terminal-selection',
      version: 1,
      captureId: capture.operationId,
      workspaceId: target.workspaceId,
      origin: 'user-selected capture',
      identityVerifiedBy: 'session-scoped terminal replay',
      textVerification: 'user-provided selection; not verified against the log',
      sessionId: snapshot.sessionId,
      terminalId: snapshot.id,
      terminalEpoch: snapshot.epoch,
      owner: snapshot.owner,
      label: snapshot.label,
      cwd: snapshot.cwd,
      ...(snapshot.pid === undefined ? {} : { processId: snapshot.pid }),
      outputSequence: capture.outputSequence,
      capturedAt: capture.capturedAt,
      capturedGeometry: { cols: capture.cols, rows: capture.rows },
      capturedBufferRange: {
        ...capture.range,
        coordinates: 'zero-based, end exclusive',
      },
      capturedBufferLines: {
        first: capture.range.start.y + 1,
        last: Math.max(
          capture.range.start.y + 1,
          capture.range.end.y + (capture.range.end.x ? 1 : 0),
        ),
      },
      rangeMeaning: 'captured buffer cells, not stable source-file lines',
      originalLog: { service: 'terminal', method: 'replay', id: snapshot.id },
    };
    const content = `${capture.text}\n\n--- terminal capture source ---\n${JSON.stringify(metadata, null, 2)}`;
    const size = new TextEncoder().encode(content).byteLength;
    if (size > MAX_TERMINAL_SELECTION_BYTES)
      throw Error(t('terminal selection is over 4 MB'));
    const attachment: Attachment = {
      id,
      kind: 'file',
      name: `${snapshot.label} · ${t('selection')}`,
      mime: 'text/plain',
      size,
      content,
    };
    persist(target.id, [...target.attachments, attachment]);
  } finally {
    unsubscribe();
  }
}
