// The shape of one memory line, with no Node.js import: the desktop renderer
// shows the line it would write, and a bundled page cannot read node:fs.
export const MEMORY_LINE_MAX = 240;

export const entryLine = (date: string, note: string): string =>
  `- ${date} · ${note}`;

/** Today, local, as YYYY-MM-DD: a note says which day it was true. */
export const today = (at = new Date()): string => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};
