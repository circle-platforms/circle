import { useCallback, useEffect, useRef, useState } from 'react';
import { gitChangeRows, type ChangeRow } from './changes';
import { workspaceCall } from './workspace-client';

/** How often a visible list asks again. */
const REFRESH_MS = 30_000;
const AFTER_TURN_MS = 600;

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
 * screen: when it opens, when the window gains focus, as a turn ends, and now and then.
 */
export function useGitChanges({
  sessionId,
  live,
  active,
  busy,
}: {
  sessionId: string;
  live: boolean;
  /** The list is on screen. */
  active: boolean;
  /** A turn is running in this conversation. */
  busy: boolean;
}) {
  const [bySession, setBySession] = useState(
    () => new Map<string, ChangeRow[]>(),
  );
  const [error, setError] = useState('');
  const inFlight = useRef<string | null>(null);
  const session = useRef(sessionId);
  session.current = sessionId;

  const refresh = useCallback(async () => {
    if (!live || !active || inFlight.current === sessionId) return;
    inFlight.current = sessionId;
    try {
      const result = await workspaceCall<GitChanges>(
        sessionId,
        'git',
        'changes',
      );
      setBySession((known) =>
        new Map(known).set(sessionId, gitChangeRows(result.files)),
      );
      if (session.current === sessionId) setError('');
    } catch (reason) {
      // Not a repository, or Git is missing: the list says so; what it showed stays.
      if (session.current === sessionId)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (inFlight.current === sessionId) inFlight.current = null;
    }
  }, [live, active, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
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

  return { files: bySession.get(sessionId), error, refresh };
}

/** One file's patch against the last commit; a new file is shown as it would be added. */
export function gitFilePatch(sessionId: string, path: string) {
  return workspaceCall<{ text: string }>(sessionId, 'git', 'diff', {
    scope: 'head',
    paths: [path],
  });
}
