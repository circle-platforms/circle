import { createContext, useContext, type ReactNode } from 'react';
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
  return (
    <CommandTerminal.Provider value={onOpen}>
      <UserShellTerminal.Provider value={onOpenUserShell}>
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
