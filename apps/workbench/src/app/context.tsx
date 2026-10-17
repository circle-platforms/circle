import {
  createContext,
  useContext,
  useEffect,
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
interface ContextValue {
  runtime: RuntimePort;
  snapshot: WorkbenchSnapshot;
  notice: string;
  notify: (message: string) => void;
  perform: (action: () => void | Promise<unknown>) => void;
  act: (action: () => CommandResult | Promise<CommandResult>) => void;
  setRouter: (handler: (result: CommandResult) => void) => void;
}
const Context = createContext<ContextValue | null>(null);
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
  const shownNotice = useRef<
    { text: string; source: 'action' | 'runtime' | 'session-error' } | undefined
  >(undefined);
  const [router] = useState(() => ({
    handler: (_result: CommandResult) => {},
  }));
  const showNotice = (
    message: string,
    source: 'action' | 'runtime' | 'session-error' = 'action',
  ) => {
    const shown = { text: message, source };
    shownNotice.current = shown;
    setNotice(message);
    setTimeout(() => {
      if (shownNotice.current !== shown) return;
      shownNotice.current = undefined;
      setNotice('');
    }, 4200);
  };
  const notify = (message: string) => showNotice(message);
  useEffect(() => {
    if (snapshot.runtime?.error) showNotice(snapshot.runtime.error, 'runtime');
    else if (shownNotice.current?.source === 'runtime') {
      shownNotice.current = undefined;
      setNotice('');
    }
  }, [snapshot.runtime?.error]);
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
      if (result.notice && selected) notify(result.notice);
      if (selected || result.openSession) router.handler(result);
    });
  };
  return (
    <Context.Provider
      value={{
        runtime,
        snapshot,
        notice,
        notify,
        perform,
        act,
        setRouter: (handler) => {
          router.handler = handler;
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useRuntime() {
  const value = useContext(Context);
  if (!value) throw Error('RuntimeProvider is required');
  return value;
}
