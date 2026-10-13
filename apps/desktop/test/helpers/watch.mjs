// Started beside a check as a process of its own, so that a check which stops running its
// own timers (blocked in a call that never returns) still ends with its evidence: after
// the time given, this prints what the check wrote, lists what runs, and ends the check's
// process tree, which lets CI go on to the steps that keep the evidence.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [pid, folder, minutes] = process.argv.slice(2);
const say = (text) => process.stderr.write(text + '\n');
setTimeout(
  () => {
    say(
      `watch: the check in ${folder} ran past ${minutes} minutes; its evidence:`,
    );
    for (const file of [
      'progress.log',
      'application.log',
      'data/updates/install.log',
      'data/updates/install.json.out',
      'data/updates/install.json.err',
    ]) {
      const path = join(folder, file);
      if (!existsSync(path)) continue;
      say(`--- ${file}`);
      try {
        say(readFileSync(path, 'utf8').trim());
      } catch (error) {
        say(`(unreadable: ${error})`);
      }
    }
    try {
      say('--- processes');
      say(
        execFileSync(
          process.platform === 'win32' ? 'tasklist' : 'ps',
          process.platform === 'win32' ? ['/V'] : ['-axo', 'pid,stat,command'],
          { encoding: 'utf8', timeout: 20000 },
        )
          .split('\n')
          .filter((line) => /Circle|node|msiexec|powershell/i.test(line))
          .join('\n'),
      );
    } catch (error) {
      say(`(no process list: ${error})`);
    }
    say(`watch: ending the check, process ${pid}`);
    try {
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { timeout: 20000 });
      else process.kill(Number(pid), 'SIGKILL');
    } catch (error) {
      say(`(could not end it: ${error})`);
    }
    process.exit(0);
  },
  Number(minutes) * 60000,
);
