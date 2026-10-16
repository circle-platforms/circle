import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  readFile,
  realpath,
  lstat,
  readlink,
  open,
  stat,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
const exec = promisify(execFile);
const locks = new Map<string, Promise<unknown>>();
/** Shared by native Git mutations and task integration; callers pass a real common Git directory. */
export async function serializeGitMutation<T>(
  commonDirectory: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = await realpath(commonDirectory),
    previous = locks.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(run);
  locks.set(key, operation);
  try {
    return await operation;
  } finally {
    if (locks.get(key) === operation) locks.delete(key);
  }
}

export type GitSnapshot = {
  root: string;
  head: string;
  branch: string;
  revision: string;
  entries: {
    path: string;
    originalPath?: string;
    index: string;
    working: string;
  }[];
  merging: boolean;
};
export interface GitWorkspaceOptions {
  identity?: { name: string; email: string };
  signoff?: boolean;
  setUpstream?: boolean;
}
export class GitWorkspaceService {
  readonly root: string;
  private options: GitWorkspaceOptions;
  constructor(root: string, options: GitWorkspaceOptions = {}) {
    this.root = root;
    if (
      options.identity &&
      [options.identity.name, options.identity.email].some(
        (value) =>
          typeof value !== 'string' ||
          !value.trim() ||
          /[\r\n\0<>]/.test(value),
      )
    )
      throw Error(
        'trusted Git identity must contain a single-line name and email',
      );
    this.options = structuredClone(options);
  }
  async git(args: string[], input?: string) {
    const readonly =
      input === undefined &&
      (['rev-parse', 'status'].includes(args[0] ?? '') ||
        (args[0] === 'diff' &&
          !args.some((arg) => arg.startsWith('--output'))) ||
        (args.length === 4 &&
          args[0] === 'symbolic-ref' &&
          args[1] === '--short' &&
          args[2] === '-q' &&
          args[3] === 'HEAD') ||
        (args[0] === 'remote' && args[1] === 'get-url'));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.executeGit(args, input);
      } catch (error) {
        const detail = `${error instanceof Error ? error.message : String(error)}\n${(error as { stderr?: string }).stderr ?? ''}`;
        if (
          !readonly ||
          attempt === 2 ||
          !/Permission denied/i.test(detail) ||
          !/config(?:uration files)?/i.test(detail)
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  private async executeGit(args: string[], input?: string) {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      ...(['status', 'diff'].includes(args[0] ?? '')
        ? { GIT_OPTIONAL_LOCKS: '0' }
        : {}),
    };
    // Diff's porcelain auto-refresh runs update-index separately; disable it too.
    const prefix =
      args[0] === 'diff' ? ['-c', 'diff.autoRefreshIndex=false'] : [];
    if (input !== undefined)
      return new Promise<string>((resolve, reject) => {
        const child = execFile(
          'git',
          ['--literal-pathspecs', '-C', this.root, ...prefix, ...args],
          {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            env,
          },
          (error, stdout, stderr) =>
            error ? reject(Error(stderr || error.message)) : resolve(stdout),
        );
        child.stdin?.end(input);
      });
    return (
      await exec(
        'git',
        ['--literal-pathspecs', '-C', this.root, ...prefix, ...args],
        {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          env,
        },
      )
    ).stdout;
  }
  async snapshot(): Promise<GitSnapshot> {
    let previous = await this.readSnapshot();
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.readSnapshot();
      if (
        previous.root === current.root &&
        previous.revision === current.revision
      )
        return current;
      previous = current;
    }
    throw Error(
      'repository changed while reading its state; refresh and try again',
    );
  }
  private async optionalGit(
    args: string[],
    missingCode: number,
    fallback: string,
  ) {
    return this.git(args).catch((error: unknown) => {
      if ((error as { code?: number }).code === missingCode) return fallback;
      throw error;
    });
  }
  private async readSnapshot(): Promise<GitSnapshot> {
    // Read-only subprocesses can run together. Two matching complete reads in
    // snapshot() reject mixed baselines without caching or weakening write CAS.
    const [
      rootValue,
      head,
      branchValue,
      raw,
      originPushUrls,
      indexValue,
      merging,
    ] = await Promise.all([
      this.git(['rev-parse', '--show-toplevel']),
      this.optionalGit(
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        1,
        'unborn',
      ).then((s) => s.trim()),
      this.optionalGit(
        ['symbolic-ref', '--short', '-q', 'HEAD'],
        1,
        'detached',
      ),
      this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.optionalGit(
        ['remote', 'get-url', '--push', '--all', 'origin'],
        2,
        '',
      ),
      this.git(['rev-parse', '--git-path', 'index']),
      this.optionalGit(
        ['rev-parse', '-q', '--verify', 'MERGE_HEAD'],
        1,
        '',
      ).then((value) => Boolean(value.trim())),
    ]);
    const root = rootValue.trim(),
      branch = branchValue.trim(),
      indexPath = indexValue.trim();
    const fields = raw.split('\0');
    const entries: GitSnapshot['entries'] = [];
    for (let i = 0; i < fields.length; i++) {
      const row = fields[i];
      if (!row) continue;
      const entry = {
        index: row[0],
        working: row[1],
        path: row.slice(3),
        originalPath: undefined as string | undefined,
      };
      if (/[RC]/.test(row.slice(0, 2))) entry.originalPath = fields[++i];
      entries.push(entry);
    }
    const hash = createHash('sha256')
      .update(JSON.stringify({ head, branch, originPushUrls, merging }))
      .update(raw);
    hash.update(
      await readFile(path.resolve(this.root, indexPath)).catch(() =>
        Buffer.alloc(0),
      ),
    );
    for (const entry of entries)
      hash
        .update(entry.path)
        .update(await this.fileFingerprint(root, entry.path));
    return {
      root,
      head,
      branch,
      revision: hash.digest('hex'),
      entries,
      merging,
    };
  }
  private async regularFile(root: string, relative: string) {
    const target = path.resolve(root, relative);
    const info = await lstat(target);
    if (!info.isFile())
      return {
        kind: info.isSymbolicLink() ? 'symlink' : 'special',
        target,
      } as const;
    const canonical = await realpath(target),
      local = path.relative(root, canonical);
    if (
      path.isAbsolute(local) ||
      local === '..' ||
      local.startsWith('..' + path.sep)
    )
      return { kind: 'outside', target } as const;
    const handle = await open(
      canonical,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat(),
        current = await stat(canonical);
      const resolved = await realpath(canonical),
        after = path.relative(root, resolved);
      if (
        !opened.isFile() ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino ||
        path.isAbsolute(after) ||
        after === '..' ||
        after.startsWith('..' + path.sep)
      )
        throw Error('file identity changed while opening Git preview');
      return { kind: 'file', handle, info: opened, target: canonical } as const;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  private async fileFingerprint(
    root: string,
    relative: string,
  ): Promise<Buffer> {
    try {
      const opened = await this.regularFile(root, relative);
      if (opened.kind === 'symlink')
        return Buffer.from('symlink:' + (await readlink(opened.target)));
      if (opened.kind !== 'file')
        return Buffer.from('unreadable:' + opened.kind);
      try {
        return await opened.handle.readFile();
      } finally {
        await opened.handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return Buffer.from('missing');
      throw error;
    }
  }
  private async untrackedPreview(root: string, relative: string) {
    const quote = (value: string) =>
      '"' +
      Array.from(Buffer.from(value), (byte) =>
        byte === 34
          ? '\\"'
          : byte === 92
            ? '\\\\'
            : byte < 32 || byte >= 127
              ? '\\' + byte.toString(8).padStart(3, '0')
              : String.fromCharCode(byte),
      ).join('') +
      '"';
    const label = quote('b/' + relative),
      prefix = `diff --git ${quote('a/' + relative)} ${label}\nnew file mode 100644\n`;
    const opened = await this.regularFile(root, relative);
    if (opened.kind !== 'file')
      return {
        path: relative,
        status: opened.kind,
        text: prefix + `Preview unavailable: ${opened.kind}\n`,
      };
    try {
      if (opened.info.size > 1024 * 1024)
        return {
          path: relative,
          status: 'too-large',
          text: prefix + 'Preview unavailable: file exceeds 1 MiB\n',
        };
      // Read at most the preview budget, even if a producer grows this file after stat.
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const chunk = await opened.handle.read(
          bytes,
          bytesRead,
          bytes.length - bytesRead,
          bytesRead,
        );
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > 1024 * 1024)
        return {
          path: relative,
          status: 'too-large',
          text: prefix + 'Preview unavailable: file exceeds 1 MiB\n',
        };
      const content = bytes.subarray(0, bytesRead);
      let text: string;
      try {
        if (content.includes(0)) throw Error('binary');
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        return {
          path: relative,
          status: 'binary',
          text: prefix + `Binary files /dev/null and ${label} differ\n`,
        };
      }
      const lines = text ? text.split('\n') : [];
      if (text.endsWith('\n')) lines.pop();
      const header = `--- /dev/null\n+++ ${label}\n`;
      const body = lines.length
        ? `@@ -0,0 +1,${lines.length} @@\n` +
          lines.map((line) => '+' + line).join('\n') +
          '\n' +
          (text.endsWith('\n') ? '' : '\\ No newline at end of file\n')
        : '';
      return { path: relative, status: 'text', text: prefix + header + body };
    } finally {
      await opened.handle.close();
    }
  }
  private paths(value: unknown): string[] {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.some(
        (p) =>
          typeof p !== 'string' ||
          !p ||
          p.includes('\0') ||
          path.isAbsolute(p) ||
          p.split(/[\\/]/).includes('..'),
      )
    )
      throw Error('explicit repository-relative paths are required');
    return value as string[];
  }
  async call(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    method =
      (
        {
          status: 'snapshot',
          applyHunk: 'applyPatch',
          continueMerge: 'conflictContinue',
          abortMerge: 'conflictAbort',
        } as Record<string, string>
      )[method] ?? method;
    if (method === 'discard') {
      method = 'applyPatch';
      params = { ...params, action: 'discard' };
    }
    if (method === 'snapshot') return this.snapshot();
    if (method === 'branches')
      return {
        branches: (
          await this.git([
            'for-each-ref',
            '--format=%(refname:short)',
            'refs/heads',
            'refs/remotes',
          ])
        )
          .split('\n')
          .filter(Boolean),
      };
    if (method === 'diff') {
      const scope = params.scope ?? 'working';
      if (!['working', 'index', 'branch'].includes(String(scope)))
        throw Error('invalid diff scope');
      const args = ['diff', '--no-ext-diff', '--no-color'];
      if (scope === 'index') args.push('--cached');
      if (scope === 'branch') {
        if (typeof params.base !== 'string' || params.base.startsWith('-'))
          throw Error('base revision is required');
        args.push(`${params.base}...HEAD`);
      }
      args.push('--');
      if (params.paths) args.push(...this.paths(params.paths));
      let text = await this.git(args);
      const previews = [];
      if (scope === 'working' && params.paths) {
        const explicit = this.paths(params.paths);
        const root = await realpath(this.root);
        const untracked = (
          await this.git([
            'ls-files',
            '--others',
            '--exclude-standard',
            '-z',
            '--',
            ...explicit,
          ])
        )
          .split('\0')
          .filter(Boolean);
        // A selected directory must never implicitly disclose its descendants.
        for (const file of untracked.filter((file) =>
          explicit.includes(file),
        )) {
          const preview = await this.untrackedPreview(root, file);
          text += preview.text;
          previews.push({ path: file, status: preview.status });
        }
      }
      return { text, previews, revision: (await this.snapshot()).revision };
    }
    const common = (await this.git(['rev-parse', '--git-common-dir'])).trim();
    return serializeGitMutation(path.resolve(this.root, common), async () => {
      const state = await this.snapshot();
      if (params.revision !== state.revision)
        throw Error(
          'repository, branch or push destination changed; refresh before retrying',
        );
      if (method === 'stage')
        await this.git(['add', '--', ...this.paths(params.paths)]);
      else if (method === 'unstage')
        await this.git(
          state.head === 'unborn'
            ? ['rm', '--cached', '--', ...this.paths(params.paths)]
            : ['restore', '--staged', '--', ...this.paths(params.paths)],
        );
      else if (method === 'applyPatch') {
        if (
          typeof params.patch !== 'string' ||
          !params.patch.startsWith('diff --git ') ||
          !['stage', 'unstage', 'discard'].includes(String(params.action))
        )
          throw Error('invalid patch');
        const flags =
          params.action === 'stage'
            ? ['--cached']
            : params.action === 'unstage'
              ? ['--cached', '--reverse']
              : ['--reverse'];
        await this.git(['apply', '--check', ...flags, '-'], params.patch);
        await this.git(['apply', ...flags, '-'], params.patch);
      } else if (method === 'commit') {
        if (typeof params.message !== 'string' || !params.message.trim())
          throw Error('commit message is required');
        const expected = this.paths(params.paths).sort();
        const staged = (
          await this.git(['diff', '--cached', '--name-only', '-z'])
        )
          .split('\0')
          .filter(Boolean)
          .sort();
        if (JSON.stringify(expected) !== JSON.stringify(staged))
          throw Error(
            'staged files do not match the explicit commit selection',
          );
        const identity = this.options.identity;
        await this.git([
          ...(identity
            ? [
                '-c',
                `user.name=${identity.name}`,
                '-c',
                `user.email=${identity.email}`,
              ]
            : []),
          'commit',
          ...(this.options.signoff ? ['--signoff'] : []),
          '-m',
          params.message,
        ]);
      } else if (method === 'push') {
        if (state.branch === 'detached')
          throw Error('select a branch before pushing');
        await this.git([
          'push',
          ...(this.options.setUpstream === false ? [] : ['--set-upstream']),
          'origin',
          state.branch,
        ]);
      } else if (method === 'conflictContinue') {
        if (!state.merging) throw Error('no merge is active');
        if ((await this.git(['ls-files', '-u'])).trim())
          throw Error('resolve and stage all conflicts first');
        await this.git(['merge', '--continue']);
      } else if (method === 'conflictAbort') {
        if (!state.merging) throw Error('no merge is active');
        await this.git(['merge', '--abort']);
      } else throw Error('unknown git method');
      return this.snapshot();
    });
  }
}
