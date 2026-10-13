import {
  copyFileSync,
  existsSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';

// The files a conversation's browser takes and gives: what may go to a page's file input,
// and where a download is kept and under what name.

/** The largest file the model may give a page. */
export const MAX_UPLOAD = 50 * 1024 * 1024;
export interface UploadFile {
  path: string;
  name: string;
  size: number;
}
/**
 * The files behind full paths, as the page would get them: each an existing ordinary file
 * of at most 50 MB, by its real path. A file with other names on disk (hard links) is
 * refused: its other name could be one the model may not read.
 */
export function uploadFiles(paths: string[]): UploadFile[] {
  return paths.map((path) => {
    if (!isAbsolute(path)) throw Error(`give the full path of ${path}`);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw Error(`no such file: ${path}`);
    }
    const stat = statSync(real);
    const name = basename(real);
    if (!stat.isFile()) throw Error(`not a file: ${path}`);
    if (stat.nlink > 1)
      throw Error(
        `${name} has other names on disk (hard links); copy it first`,
      );
    if (stat.size > MAX_UPLOAD) throw Error(`${name} is larger than 50 MB`);
    return { path: real, name, size: stat.size };
  });
}
/** The system's Downloads folder, where a browser keeps what it downloads. */
export const downloadsFolder = () => join(homedir(), 'Downloads');
/** A site's name for a download, made safe as a file name on every system. */
export function downloadName(suggested: string): string {
  const name = basename(suggested.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 200);
  return name && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)
    ? name
    : 'download';
}
/** A path in `folder` for `name` that no file has yet: `name (1).ext` and so on, as browsers do. */
export function freePath(folder: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) {
    const candidate = join(folder, n ? `${stem} (${n})${ext}` : name);
    if (!existsSync(candidate)) return candidate;
  }
}
/** Moves a file, by copying it when the target is on another disk. */
export function moveFile(source: string, target: string) {
  try {
    renameSync(source, target);
  } catch {
    copyFileSync(source, target);
    rmSync(source, { force: true });
  }
}
export const sizeText = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
