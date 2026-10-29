export interface FileHolder {
  pid: number;
  /** Restart Manager's kind of application: 0 unknown, 3 a service, 5 a console. */
  type: number;
  name: string;
  image: string | null;
}
export interface OutsideWriteRefusal {
  path: string;
  code?: string;
  errno?: number;
  syscall?: string;
  message: string;
  /** Present on Windows only. */
  holders?: FileHolder[] | { error: string };
}
export declare function writeOutside(
  path: string,
  content: string,
  options?: {
    write?: (path: string, content: string) => Promise<void>;
    platform?: NodeJS.Platform;
    holders?: (path: string) => Promise<FileHolder[] | { error: string }>;
  },
): Promise<void>;
export declare function fileHolders(
  path: string,
  options?: { timeoutMs?: number },
): Promise<FileHolder[] | { error: string }>;
