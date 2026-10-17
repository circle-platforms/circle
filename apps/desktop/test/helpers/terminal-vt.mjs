// Use the same mature VT parser as the product without opening a DOM or window.
// Removing escape sequences is insufficient: ConPTY can repaint a prior cell.
import { createRequire } from 'node:module';
const require = createRequire(
  new URL('../../../workbench/package.json', import.meta.url),
);
const { Terminal } = require('@xterm/xterm');
export async function renderTerminalOutput(
  raw,
  { cols = 80, rows = 24, scrollback = 10000 } = {},
) {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
  });
  try {
    await new Promise((resolve) => terminal.write(raw, resolve));
    const buffer = terminal.buffer.active;
    const lines = Array.from({ length: buffer.length }, (_, index) => {
      const line = buffer.getLine(index);
      return { text: line.translateToString(true), wrapped: line.isWrapped };
    });
    return { lines, text: lines.map((line) => line.text).join('\n') };
  } finally {
    terminal.dispose();
  }
}
