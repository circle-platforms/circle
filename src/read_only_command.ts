import { execFileSync } from 'node:child_process';
import { commandTokens } from './approvals.js';

/**
 * A command proved to only read, as it will be run: every word quoted, so the shell expands
 * nothing, and with the programs git or ripgrep would start by themselves turned off.
 */
export interface ReadOnlyExecution {
  kind: 'verified';
  command: string;
  /** One of its commands is git, which reads the repository's own configuration. */
  git: boolean;
  /**
   * It names no file and reads no input: `pwd`, `whoami`, `true` and `ls` with options.
   * Only such a command is known to stay in place where the folder it runs in is not known.
   */
  pathFree: boolean;
}

const gitFlags: Record<string, RegExp> = {
  status:
    /^(?:--short|--branch|--porcelain(?:=[12])?|--untracked-files(?:=(?:no|normal|all))?|--ignored|-[sb]|--show-stash)$/,
  diff: /^(?:--(?:stat|numstat|shortstat|name-only|name-status|summary|check|cached|staged|raw|patch|no-color|color=never|no-renames|no-ext-diff|no-textconv)|-[pwbU]|-U\d+)$/,
  log: /^(?:--(?:oneline|stat|name-only|name-status|no-color|color=never|decorate(?:=(?:short|full|no))?|all|graph|no-merges|reverse|max-count=\d+)|-\d+|-[p])$/,
  show: /^(?:--(?:stat|numstat|name-only|name-status|summary|no-color|color=never|no-ext-diff|no-textconv)|-[p])$/,
  'rev-parse':
    /^(?:--(?:show-toplevel|show-prefix|git-common-dir|git-dir|is-inside-work-tree|abbrev-ref|verify|short(?:=\d+)?|symbolic-full-name))$/,
  branch:
    /^(?:--(?:list|all|remotes|show-current|no-color|color=never)|-[arv]|-vv)$/,
};
const localFlags: Record<string, RegExp> = {
  ls: /^(?:-[aAlhFdrt1]+|--(?:all|almost-all|directory|human-readable|classify|color=never))$/,
  cat: /^(?:-[nbEsTv]+|--(?:number|number-nonblank|show-ends|show-tabs|show-nonprinting))$/,
  head: /^(?:-\d+|-n\d+|--lines=\d+)$/,
  tail: /^(?:-\d+|-n\d+|--lines=\d+)$/,
  wc: /^(?:-[clmwL]+|--(?:bytes|chars|lines|words|max-line-length))$/,
  rg: /^(?:-[nilwFsv]+|--(?:files|hidden|line-number|ignore-case|fixed-strings|files-with-matches|files-without-match|count|no-heading|no-ignore|color=never))$/,
  grep: /^(?:-[nilwFsvEc]+|--(?:line-number|ignore-case|fixed-strings|count))$/,
};
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * The command as it may run without a card, or nothing when any part of it is not proved to
 * only read. `credentialFiles` are the file names no command may read: a search and a patch
 * leave them out, since neither names the files it goes through.
 */
export function readOnlyExecution(
  command: string,
  platform = process.platform,
  credentialFiles: readonly string[] = [],
): ReadOnlyExecution | undefined {
  if (platform === 'win32' || /[$`\\<>\n\r\0*?~{}()!#%]/.test(command)) return;
  const tokens = commandTokens(command, platform);
  if (!tokens?.length) return;
  const output: string[] = [];
  let words: string[] = [];
  let git = false;
  let pathFree = true;
  const finish = () => {
    if (!words.length) return false;
    const [head, ...args] = words;
    if (head === 'git') {
      let i = 0;
      if (args[i] === '--no-pager') i++;
      if (args[i] === '--no-optional-locks') i++;
      const sub = args[i++] ?? '';
      const flags = gitFlags[sub];
      if (!flags) return false;
      const rest = args.slice(i);
      if (sub === 'branch' && rest.some((arg) => !arg.startsWith('-')))
        return false;
      if (
        rest.some(
          (arg) => arg.startsWith('-') && arg !== '--' && !flags.test(arg),
        )
      )
        return false;
      if (rest.some((arg) => !arg || arg.includes(':') || arg.startsWith('/')))
        return false;
      const history = sub === 'log' || sub === 'show';
      // A patch shows what is in the files it covers without naming them.
      const patch =
        sub === 'diff' ||
        sub === 'show' ||
        (sub === 'log' && rest.includes('-p'));
      git = true;
      pathFree = false;
      output.push(
        [
          'git',
          '--no-pager',
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          sub,
          ...(history || sub === 'diff'
            ? ['--no-ext-diff', '--no-textconv']
            : []),
          // `log.showSignature` would start the configured gpg program.
          ...(history ? ['--no-show-signature'] : []),
          ...rest,
          ...(patch
            ? credentialFiles.map((name) => `:(exclude,glob,icase)**/${name}`)
            : []),
        ]
          .map(quote)
          .join(' '),
      );
    } else if (['pwd', 'whoami', 'true'].includes(head ?? '')) {
      if (args.length) return false;
      output.push(quote(head!));
    } else {
      const flags = localFlags[head ?? ''];
      if (
        !flags ||
        args.some(
          (arg) => arg.startsWith('-') && arg !== '--' && !flags.test(arg),
        )
      )
        return false;
      if (head !== 'ls' || args.some((arg) => !arg.startsWith('-')))
        pathFree = false;
      output.push(
        [
          head!,
          ...(head === 'rg'
            ? [
                '--no-config',
                // It searches every file under a folder: not the credential files.
                ...credentialFiles.flatMap((name) => ['--iglob', `!${name}`]),
              ]
            : []),
          ...args,
        ]
          .map(quote)
          .join(' '),
      );
    }
    words = [];
    return true;
  };
  for (const token of tokens) {
    if (['&&', '||', '|'].includes(token)) {
      if (!finish()) return;
      // What follows a pipe reads it, and reads the terminal when the pipe is not there.
      if (token === '|') pathFree = false;
      output.push(token);
    } else {
      if ([';', '&', '|&'].includes(token)) return;
      words.push(token);
    }
  }
  if (!finish()) return;
  return { kind: 'verified', command: output.join(' '), git, pathFree };
}

/**
 * Whether a git query in this folder starts no program but git. The verified command turns
 * off by an option what it can: the pager, the file-system monitor, external diffs and
 * text conversion, signature checks. A repository's own configuration can name more, which
 * no option turns off: a content filter git runs to compare a file, a promisor remote it
 * fetches a missing object from, a submodule with a configuration of its own, a work tree
 * somewhere else. With any of those, or when git cannot say, the query asks as before.
 * Reading the configuration starts nothing. What the person set for all their repositories
 * (git-lfs's filter) is theirs and does not count.
 */
export function gitQueryStartsOnlyGit(folder: string): boolean {
  let listed: string;
  try {
    // A name cannot hold a line break, so each line is one scope, a tab and one name.
    listed = execFileSync(
      'git',
      ['config', '--show-scope', '--name-only', '--list'],
      {
        cwd: folder,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch {
    return false;
  }
  return !listed.split('\n').some((line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return false;
    const scope = line.slice(0, tab);
    if (scope !== 'local' && scope !== 'worktree') return false;
    return /^(?:filter\.|submodule\.|remote\..*\.promisor$|remote\..*\.partialclonefilter$|extensions\.partialclone$|core\.worktree$)/i.test(
      line.slice(tab + 1),
    );
  });
}
