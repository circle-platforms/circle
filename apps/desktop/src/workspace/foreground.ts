import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Whether a shell has its terminal to itself: the terminal's foreground process group is
 * the shell's own, so no command the shell started runs in front of it. An interactive
 * shell gives the terminal to each command it runs and takes it back when the command
 * ends, so this is the shell back at its prompt, whatever the prompt looks like.
 *
 * Undefined where the system cannot say: Windows has no foreground process group, and a
 * process that has gone has none.
 */
export async function shellInForeground(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
  ps: (pid: number) => Promise<string> = async (pid) =>
    (
      await exec('/bin/ps', ['-o', 'pgid=,tpgid=', '-p', String(pid)], {
        timeout: 2000,
      })
    ).stdout,
): Promise<boolean | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || platform === 'win32') return;
  try {
    if (platform === 'linux') {
      // pid (name) state ppid pgrp session tty_nr tpgid …; the name may hold spaces
      // and parentheses, so the fields are counted from the last `)`.
      const stat = await read(`/proc/${pid}/stat`);
      const fields = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/);
      return sameGroup(Number(fields[2]), Number(fields[5]));
    }
    // macOS and the BSDs: ps reads the same two numbers.
    const [group, front] = (await ps(pid)).trim().split(/\s+/).map(Number);
    return sameGroup(group, front);
  } catch {
    return;
  }
}

function sameGroup(
  group: number | undefined,
  front: number | undefined,
): boolean | undefined {
  if (!Number.isSafeInteger(group) || !Number.isSafeInteger(front)) return;
  // A process without a controlling terminal reports 0 or -1 for it.
  if (group! <= 0 || front! <= 0) return;
  return group === front;
}
