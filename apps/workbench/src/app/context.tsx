import {
  createContext,
  useContext,
  useEffect,
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
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const [notice, setNotice] = useState('');
  const [router] = useState(() => ({
    handler: (_result: CommandResult) => {},
  }));
  const notify = (message: string) => {
    setNotice(message);
    setTimeout(
      () => setNotice((current) => (current === message ? '' : current)),
      4200,
    );
  };
  useEffect(() => {
    if (snapshot.runtime?.error) notify(snapshot.runtime.error);
  }, [snapshot.runtime?.error]);
  const actionError = snapshot.sessions.find(
    (session) => session.id === snapshot.activeSessionId,
  )?.actionError;
  useEffect(() => {
    setNotice(actionError ?? '');
    if (actionError) notify(actionError);
  }, [snapshot.activeSessionId, actionError]);
  const perform = (action: () => void | Promise<unknown>) => {
    const sessionId = runtime.getSnapshot().activeSessionId;
    const report = (error: unknown) => {
      const source =
        error instanceof SessionActionError ? error.sessionId : sessionId;
      if (runtime.getSnapshot().activeSessionId === source)
        notify(error instanceof Error ? error.message : t('action failed'));
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
