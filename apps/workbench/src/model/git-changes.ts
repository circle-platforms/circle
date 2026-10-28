import { useCallback, useEffect, useRef, useState } from 'react';
import { gitChangeRows, type ChangeRow } from './changes';
import type { Message } from './types';
import { subscribeWorkspace, workspaceCall } from './workspace-client';

/** How often a visible list asks again. */
const REFRESH_MS = 30_000;
const AFTER_TURN_MS = 600;
/** After a tool call ends: what it wrote may not announce itself, as a command's does not. */
const AFTER_TOOL_MS = 600;

/** How many of a conversation's tool calls have ended; each may have changed files. */
export function endedToolCalls(messages: readonly Message[]): number {
  let ended = 0;
  for (const message of messages)
    if (
      message.tool &&
      message.tool.status !== 'running' &&
      message.tool.status !== 'waiting'
    )
      ended++;
  return ended;
}

interface GitChanges {
  revision: string;
  files: {
    path: string;
    status: string;
    added?: number | null;
    removed?: number | null;
  }[];
}

/**
 * Every file that differs from the last commit, read from Git while the list is on
 * screen: when it opens, when the window gains focus, when a file is written through the
 * workspace, after each tool call of a turn, as a turn ends, and now and then. Never on
 * a short timer: a large project's status and diffs are not read every second.
 */
export function useGitChanges({
  sessionId,
  live,
  active,
  busy,
  settled = 0,
}: {
  sessionId: string;
  live: boolean;
  /** The list is on screen. */
  active: boolean;
  /** A turn is running in this conversation. */
  busy: boolean;
  /** Grows as the conversation's tool calls end: endedToolCalls. */
  settled?: number;
}) {
  const [bySession, setBySession] = useState(
    () => new Map<string, ChangeRow[]>(),
  );
  const [error, setError] = useState('');
  const inFlight = useRef<string | null>(null);
  const pending = useRef(new Set<string>());
  const session = useRef(sessionId);
  session.current = sessionId;
  const current = useRef({ sessionId, live, active });
  current.current = { sessionId, live, active };

  const refresh = useCallback(async () => {
    if (!live || !active) return;
    if (inFlight.current === sessionId) {
      // A save, focus or reopen during this read may have changed Git after
      // its snapshot. Follow it with one fresh read instead of dropping it.
      pending.current.add(sessionId);
      return;
    }
    inFlight.current = sessionId;
    try {
      const result = await workspaceCall<GitChanges | undefined>(
        sessionId,
        'git',
        'changes',
      );
      // An answer without its list is an error the list shows, not a page that breaks
      if (!Array.isArray(result?.files))
        throw Error('git changes answered without a list of files');
      const rows = gitChangeRows(result.files);
      setBySession((known) => new Map(known).set(sessionId, rows));
      if (session.current === sessionId) setError('');
    } catch (reason) {
      // Not a repository, or Git is missing: the list says so; what it showed stays.
      if (session.current === sessionId)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (inFlight.current === sessionId) inFlight.current = null;
      if (
        pending.current.delete(sessionId) &&
        current.current.sessionId === sessionId &&
        current.current.live &&
        current.current.active
      )
        void refresh();
    }
  }, [live, active, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // A file written in this conversation shows up without waiting for the quiet
  // refresh, and without the person opening that file first.
  useEffect(() => {
    if (!live || !active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribeWorkspace((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.service !== 'documents' && event.service !== 'git') return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 400);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [live, active, sessionId, refresh]);
  useEffect(() => {
    if (!active) return;
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  }, [active, refresh]);
  const wasBusy = useRef(busy);
  useEffect(() => {
    const ended = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!ended) return;
    const timer = setTimeout(() => void refresh(), AFTER_TURN_MS);
    return () => clearTimeout(timer);
  }, [busy, refresh]);
  // A tool call that ended may have changed files without a word to the workspace, as a
  // shell command does: the list asks again once, a moment later
  const lastSettled = useRef(settled);
  useEffect(() => {
    if (lastSettled.current === settled) return;
    lastSettled.current = settled;
    if (!live || !active) return;
    const timer = setTimeout(() => void refresh(), AFTER_TOOL_MS);
    return () => clearTimeout(timer);
  }, [settled, live, active, refresh]);

  return { files: bySession.get(sessionId), error, refresh };
}

/** One file's patch against the last commit; a new file is shown as it would be added. */
export function gitFilePatch(sessionId: string, path: string) {
  return workspaceCall<{ text: string }>(sessionId, 'git', 'diff', {
    scope: 'head',
    paths: [path],
  });
}
