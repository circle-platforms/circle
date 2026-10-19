import { useCallback, useEffect, useRef, useState } from 'react';
import type { PullRequestOverview } from '../../../desktop/src/workspace/pulls-types';
import { workspaceCall } from './workspace-client';

/** How often a visible overview asks again; faster while a pull request's checks run. */
export const REFRESH_QUIET_MS = 90_000;
export const REFRESH_RUNNING_MS = 20_000;
/** A turn that just ended has usually changed files, branches and pull requests. */
const AFTER_TURN_MS = 600;

/**
 * The repository and pull requests of a conversation's folder, read through the
 * `pulls` workspace service. Outside the live app there is nothing to read; the
 * caller's `sample` stands in so the preview can show the card.
 */
export function usePullRequests({
  sessionId,
  live,
  busy,
  sample,
}: {
  sessionId: string;
  live: boolean;
  /** A turn is running in this conversation. */
  busy: boolean;
  sample?: PullRequestOverview;
}) {
  const [bySession, setBySession] = useState(
    () => new Map<string, PullRequestOverview>(),
  );
  const [failed, setFailed] = useState(false);
  const inFlight = useRef<string | null>(null);
  const session = useRef(sessionId);
  session.current = sessionId;

  const refresh = useCallback(async () => {
    if (!live || inFlight.current === sessionId) return;
    inFlight.current = sessionId;
    try {
      const overview = await workspaceCall<PullRequestOverview>(
        sessionId,
        'pulls',
        'overview',
      );
      // The person may have moved to another conversation while this read ran.
      setBySession((known) => new Map(known).set(sessionId, overview));
      if (session.current === sessionId) setFailed(false);
    } catch {
      // Keep what was shown; it is stale, not wrong.
      if (session.current === sessionId) setFailed(true);
    } finally {
      if (inFlight.current === sessionId) inFlight.current = null;
    }
  }, [live, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  // The falling edge of a turn.
  const wasBusy = useRef(busy);
  useEffect(() => {
    const ended = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!ended) return;
    const timer = setTimeout(() => void refresh(), AFTER_TURN_MS);
    return () => clearTimeout(timer);
  }, [busy, refresh]);
  const overview = live ? bySession.get(sessionId) : sample;
  const running = overview?.current?.checks === 'running';
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(
      () => {
        if (!document.hidden) void refresh();
      },
      running ? REFRESH_RUNNING_MS : REFRESH_QUIET_MS,
    );
    return () => clearInterval(timer);
  }, [live, refresh, running]);

  return { overview, failed, refresh };
}

/** The tail of what failed in one GitHub Actions run, for the clipboard. */
export function failedRunLog(sessionId: string, runId: number) {
  return workspaceCall<{ text: string; truncated: boolean }>(
    sessionId,
    'pulls',
    'failedLog',
    { runId },
  );
}
