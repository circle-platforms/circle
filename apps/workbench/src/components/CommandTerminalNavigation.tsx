import { createContext, useContext, type ReactNode } from 'react';
const CommandTerminal = createContext<
  | ((
      sourceSessionId: string,
      toolCallId: string,
      trigger?: HTMLElement,
    ) => Promise<void>)
  | undefined
>(undefined);
/** Command identity comes from the rendered owner and host tool ID, never output text. */
export function CommandTerminalNavigation({
  onOpen,
  children,
}: {
  onOpen?: (
    sourceSessionId: string,
    toolCallId: string,
    trigger?: HTMLElement,
  ) => Promise<void>;
  children: ReactNode;
}) {
  return (
    <CommandTerminal.Provider value={onOpen}>
      {children}
    </CommandTerminal.Provider>
  );
}
export function useCommandTerminal() {
  return useContext(CommandTerminal);
}
