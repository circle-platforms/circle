import { createContext, useContext, type ReactNode } from 'react';
import { useStableCallback } from '../app/stable-callback';
const CommandTerminal = createContext<
  | ((
      sourceSessionId: string,
      toolCallId: string,
      trigger?: HTMLElement,
    ) => Promise<void>)
  | undefined
>(undefined);
const UserShellTerminal = createContext<
  | ((
      sourceSessionId: string,
      userShellId: string,
      trigger?: HTMLElement,
    ) => Promise<void>)
  | undefined
>(undefined);
/** Command identity comes from the rendered owner and host tool ID, never output text. */
export function CommandTerminalNavigation({
  onOpen,
  onOpenUserShell,
  children,
}: {
  onOpen?: (
    sourceSessionId: string,
    toolCallId: string,
    trigger?: HTMLElement,
  ) => Promise<void>;
  onOpenUserShell?: (
    sourceSessionId: string,
    userShellId: string,
    trigger?: HTMLElement,
  ) => Promise<void>;
  children: ReactNode;
}) {
  // Rows read these: the application's own render must not make them render again.
  const open = useStableCallback(
    (sourceSessionId: string, toolCallId: string, trigger?: HTMLElement) =>
      onOpen!(sourceSessionId, toolCallId, trigger),
  );
  const openUserShell = useStableCallback(
    (sourceSessionId: string, userShellId: string, trigger?: HTMLElement) =>
      onOpenUserShell!(sourceSessionId, userShellId, trigger),
  );
  return (
    <CommandTerminal.Provider value={onOpen && open}>
      <UserShellTerminal.Provider value={onOpenUserShell && openUserShell}>
        {children}
      </UserShellTerminal.Provider>
    </CommandTerminal.Provider>
  );
}
export function useCommandTerminal() {
  return useContext(CommandTerminal);
}
export function useUserShellTerminal() {
  return useContext(UserShellTerminal);
}
