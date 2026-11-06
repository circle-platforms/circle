import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type {
  CommandResult,
  RuntimePort,
  WorkbenchSnapshot,
} from '../model/types';
import { t } from '../i18n';
import { SessionActionError } from '../model/action-error';
import { runtimeStoppedNotice } from '../model/runtime-notice';
/** The same object for the life of the runtime: reading it renders nothing again. */
interface RuntimeActions {
  runtime: RuntimePort;
  notify: (message: string, action?: NoticeAction) => void;
  perform: (action: () => void | Promise<unknown>) => void;
  act: (action: () => CommandResult | Promise<CommandResult>) => void;
}
interface ContextValue extends RuntimeActions {
  snapshot: WorkbenchSnapshot;
  notice: string;
  /** A link the current notice offers, such as "open" after a memory was written. */
  noticeAction?: NoticeAction;
  setRouter: (handler: (result: CommandResult) => void) => void;
}
export interface NoticeAction {
  label: string;
  run: () => void;
}
const Context = createContext<ContextValue | null>(null);
const Actions = createContext<RuntimeActions | null>(null);
export function RuntimeProvider({
  runtime,
  children,
}: {
  runtime: RuntimePort;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const [notice, setNotice] = useState('');
  const [noticeAction, setNoticeAction] = useState<NoticeAction>();
  const shownNotice = useRef<
    { text: string; source: 'action' | 'runtime' | 'session-error' } | undefined
  >(undefined);
  const [router] = useState(() => ({
    handler: (_result: CommandResult) => {},
  }));
  const showNotice = useCallback(
    (
      message: string,
      source: 'action' | 'runtime' | 'session-error' = 'action',
      action?: NoticeAction,
    ) => {
      const shown = { text: message, source };
      shownNotice.current = shown;
      setNotice(message);
      setNoticeAction(action);
      setTimeout(() => {
        if (shownNotice.current !== shown) return;
        shownNotice.current = undefined;
        setNotice('');
        setNoticeAction(undefined);
      }, 4200);
    },
    [],
  );
  // A stopped runtime is said in the interface language, with its exit code.
  const runtimeNotice =
    runtimeStoppedNotice(snapshot.runtime) ?? snapshot.runtime?.error;
  useEffect(() => {
    if (runtimeNotice) showNotice(runtimeNotice, 'runtime');
    else if (shownNotice.current?.source === 'runtime') {
      shownNotice.current = undefined;
      setNotice('');
    }
  }, [runtimeNotice]);
  const actionError = snapshot.sessions.find(
    (session) => session.id === snapshot.activeSessionId,
  )?.actionError;
  const noticeSession = useRef(snapshot.activeSessionId);
  useEffect(() => {
    if (noticeSession.current !== snapshot.activeSessionId) {
      noticeSession.current = snapshot.activeSessionId;
      shownNotice.current = undefined;
      setNotice('');
    }
    if (actionError) showNotice(actionError, 'session-error');
    else if (shownNotice.current?.source === 'session-error') {
      shownNotice.current = undefined;
      setNotice('');
    }
  }, [snapshot.activeSessionId, actionError]);
  const actions = useMemo<RuntimeActions>(() => {
    const notify = (message: string, action?: NoticeAction) =>
      showNotice(message, 'action', action);
    const perform = (action: () => void | Promise<unknown>) => {
      const sessionId = runtime.getSnapshot().activeSessionId;
      const report = (error: unknown) => {
        const source =
          error instanceof SessionActionError ? error.sessionId : sessionId;
        if (runtime.getSnapshot().activeSessionId === source)
          showNotice(
            error instanceof Error ? error.message : t('action failed'),
            error instanceof SessionActionError ? 'session-error' : 'action',
          );
      };
      try {
        const result = action();
        if (result instanceof Promise) void result.catch(report);
      } catch (error) {
        report(error);
      }
    };
    const act = (action: () => CommandResult | Promise<CommandResult>) => {
      const sessionId = runtime.getSnapshot().activeSessionId;
      perform(async () => {
        const result = await action();
        const selected = runtime.getSnapshot().activeSessionId === sessionId;
        // The answer belongs to the conversation that asked, whatever the window
        // moved on to while it was sought: record it there, and say it in passing
        // only while that conversation is still the one on screen (#302).
        if (result.notice) {
          runtime.appendNotice(sessionId, result.notice);
          if (selected) notify(result.notice);
        }
        if (selected || result.openSession) router.handler(result);
      });
    };
    return { runtime, notify, perform, act };
  }, [runtime, router, showNotice]);
  return (
    <Actions.Provider value={actions}>
      <Context.Provider
        value={{
          ...actions,
          snapshot,
          notice,
          noticeAction: notice ? noticeAction : undefined,
          setRouter: (handler) => {
            router.handler = handler;
          },
        }}
      >
        {children}
      </Context.Provider>
    </Actions.Provider>
  );
}
/**
 * Renders the caller with every publication. A transcript row must not call it: there can
 * be hundreds, so they read through useRuntimeActions and useRuntimeSelector.
 */
export function useRuntime() {
  const value = useContext(Context);
  if (!value) throw Error('RuntimeProvider is required');
  return value;
}
/** What a component does to the runtime, for one that shows nothing of the snapshot. */
export function useRuntimeActions() {
  const value = useContext(Actions);
  if (!value) throw Error('RuntimeProvider is required');
  return value;
}
/**
 * One value from the snapshot: the component renders again when that value changes and not
 * with every publication, as `useRuntime` makes it. `same` says when two values are equal.
 */
export function useRuntimeSelector<T>(
  select: (snapshot: WorkbenchSnapshot) => T,
  same: (one: T, other: T) => boolean = Object.is,
): T {
  const { runtime } = useRuntimeActions();
  const kept = useRef<{ value: T } | undefined>(undefined);
  const read = () => {
    const value = select(runtime.getSnapshot());
    if (kept.current && same(kept.current.value, value))
      return kept.current.value;
    kept.current = { value };
    return value;
  };
  return useSyncExternalStore(runtime.subscribe, read, read);
}
