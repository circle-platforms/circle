export interface BreakpointRow {
  line?: number;
  requestedLine?: number;
}

/** Lines a file's breakpoint rows ask for, in stored order. */
export function breakpointLines(rows: readonly BreakpointRow[]): number[] {
  return rows
    .map((row) => Number(row.requestedLine ?? row.line))
    .filter((line) => Number.isInteger(line) && line > 0);
}

/** Add the line, or drop it when it is already requested. */
export function toggleBreakpointLine(
  lines: readonly number[],
  line: number,
): number[] {
  return lines.includes(line)
    ? lines.filter((item) => item !== line)
    : [...lines, line];
}

/** Breakpoint lines stored for this workspace-relative path. */
export function breakpointsForPath(
  breakpoints: Readonly<Record<string, readonly BreakpointRow[]>>,
  file: string,
): number[] {
  const normalized = file.replaceAll('\\', '/');
  const suffix = `/${normalized}`;
  for (const [stored, rows] of Object.entries(breakpoints)) {
    const key = stored.replaceAll('\\', '/');
    if (stored === file || key === normalized || key.endsWith(suffix))
      return breakpointLines(rows);
  }
  return [];
}
