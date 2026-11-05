import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const LOG_LIMIT = 1024 * 1024;

/** One entry in a log of two files: past a megabyte the older one moves aside. Best effort. */
export function appendDiagnosticLog(
  file: string,
  version: string | undefined,
  text: string,
) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    const where = `circle ${version ?? '?'} · electron ${process.versions.electron ?? '?'} · ${process.platform} ${process.arch}`;
    appendFileSync(file, `${new Date().toISOString()} ${where}\n${text}\n\n`);
  } catch {
    /* the log is best effort */
  }
}
