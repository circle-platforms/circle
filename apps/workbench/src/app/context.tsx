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
  const perform = (action: () => void | Promise<unknown>) => {
    try {
      const result = action();
      if (result instanceof Promise)
        void result.catch((error) =>
          notify(error instanceof Error ? error.message : 'action failed'),
        );
    } catch (error) {
      notify(error instanceof Error ? error.message : 'action failed');
    }
  };
  const act = (action: () => CommandResult | Promise<CommandResult>) =>
    perform(async () => {
      const result = await action();
      if (result.notice) notify(result.notice);
      router.handler(result);
    });
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
