export function renderTerminalOutput(
  raw: string,
  options?: { cols?: number; rows?: number; scrollback?: number },
): Promise<{ lines: { text: string; wrapped: boolean }[]; text: string }>;
