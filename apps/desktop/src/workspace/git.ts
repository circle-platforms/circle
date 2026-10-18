import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  readFile,
  writeFile,
  realpath,
  lstat,
  readlink,
  open,
  stat,
  mkdtemp,
  mkdir,
  rm,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitPushAuthentication } from './git-push-auth.ts';
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
export type GitHistory = {
  head: string;
  commits: {
    id: string;
    parents: string[];
    author: string;
    date: string;
    subject: string;
  }[];
  offset: number;
  hasMore: boolean;
};
export type GitCommitDiff = {
  commit: string;
  parent: string | null;
  text: string;
  entries: {
    path: string;
    status: string;
    added?: number | null;
    removed?: number | null;
  }[];
};
function changedFiles(raw: string, stats?: string): GitCommitDiff['entries'] {
  const counts = new Map(
    (stats ?? '')
      .split('\0')
      .filter(Boolean)
      .map((row) => {
        const first = row.indexOf('\t'),
          second = row.indexOf('\t', first + 1);
        const added = row.slice(0, first),
          removed = row.slice(first + 1, second);
        return [
          row.slice(second + 1),
          {
            added: added === '-' ? null : Number(added),
            removed: removed === '-' ? null : Number(removed),
          },
        ] as const;
      }),
  );
  const fields = raw.split('\0');
  const entries: GitCommitDiff['entries'] = [];
  for (let i = 0; i + 1 < fields.length; i += 2)
    if (fields[i] && fields[i + 1])
      entries.push({
        status: fields[i]!,
        path: fields[i + 1]!,
        ...counts.get(fields[i + 1]!),
      });
  return entries;
}
export interface GitInvocation {
  pushAuthentication?: GitPushAuthentication;
  signal?: AbortSignal;
  assertActive?: () => void;
}
export interface GitWorkspaceOptions {
  identity?: { name: string; email: string };
  signoff?: boolean;
  setUpstream?: boolean;
}
/** The files a git patch writes: its `+++ b/…` targets, without /dev/null. */
export function patchTargets(patch: string): string[] {
  return [
    ...new Set(
      [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]!),
    ),
  ];
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
  async git(args: string[], input?: string, invocation?: GitInvocation) {
    const readonly =
      input === undefined &&
      (['rev-parse', 'status'].includes(args[0] ?? '') ||
        (['diff', 'log', 'diff-tree'].includes(args[0] ?? '') &&
          !args.some((arg) => arg.startsWith('--output'))) ||
        (args.length === 4 &&
          args[0] === 'symbolic-ref' &&
          args[1] === '--short' &&
          args[2] === '-q' &&
          args[3] === 'HEAD') ||
        (args[0] === 'remote' && args[1] === 'get-url'));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.executeGit(args, input, invocation);
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
  private async executeGit(
    args: string[],
    input?: string,
    invocation?: GitInvocation,
  ) {
    if (args[0] === 'push') {
      invocation?.signal?.throwIfAborted();
      invocation?.assertActive?.();
    }
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      ...(['status', 'diff', 'log', 'diff-tree'].includes(args[0] ?? '')
        ? { GIT_OPTIONAL_LOCKS: '0' }
        : {}),
    };
    // Diff's porcelain auto-refresh runs update-index separately; disable it too.
    const prefix =
      args[0] === 'diff' ? ['-c', 'diff.autoRefreshIndex=false'] : [];
    if (input !== undefined)
      return new Promise<string>((resolve, reject) => {
        let inputError: Error | undefined;
        const child = execFile(
          'git',
          ['--literal-pathspecs', '-C', this.root, ...prefix, ...args],
          {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            env,
          },
          (error, stdout, stderr) =>
            error || inputError
              ? reject(Error(stderr || error?.message || inputError!.message))
              : resolve(stdout),
        );
        // Git may exit before reading its input; EPIPE must reject, not crash.
        child.stdin?.on('error', (error: Error) => {
          inputError = error;
        });
        child.stdin?.end(input);
      });
    const execute = async (
      extraEnv: NodeJS.ProcessEnv = {},
      config: string[] = [],
    ) => {
      invocation?.signal?.throwIfAborted();
      invocation?.assertActive?.();
      return (
        await exec(
          'git',
          [
            '--literal-pathspecs',
            '-C',
            this.root,
            ...prefix,
            ...config,
            ...args,
          ],
          {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            env: { ...env, ...extraEnv },
            signal: args[0] === 'push' ? invocation?.signal : undefined,
          },
        )
      ).stdout;
    };
    if (args[0] === 'push' && invocation?.pushAuthentication) {
      const authentication = invocation.pushAuthentication;
      const destinations = (
        await this.git(['remote', 'get-url', '--push', '--all', 'origin'])
      )
        .trim()
        .split('\n');
      const expected = `https://github.com/${authentication.repository}`;
      if (
        destinations.length !== 1 ||
        ![expected, expected + '.git'].includes(destinations[0]!)
      )
        throw Error(
          'GitHub push destination does not match the authorized repository',
        );
      await this.assertPushHttpConfiguration();
      invocation.signal?.throwIfAborted();
      invocation.assertActive?.();
      // Use the reviewed canonical URL directly, not a mutable remote alias.
      const originIndex = args.indexOf('origin');
      if (originIndex < 0)
        throw Error('authenticated push requires an explicit origin');
      args = [...args];
      args[originIndex] = destinations[0]!;
      return authentication.withCredentials(async (env, config) => {
        await this.assertPushHttpConfiguration();
        return execute(env, config);
      });
    }
    return execute();
  }
  private async assertPushHttpConfiguration() {
    let worktreeConfig = false;
    try {
      worktreeConfig =
        (
          await this.git([
            'config',
            '--local',
            '--includes',
            '--bool',
            '--get',
            'extensions.worktreeConfig',
          ])
        ).trim() === 'true';
    } catch (error) {
      if ((error as { code?: number }).code !== 1) throw error;
    }
    // Git rejects --worktree for linked worktrees until this repository
    // extension is enabled; absence is a valid common-config-only repository.
    for (const scope of worktreeConfig
      ? ['--local', '--worktree']
      : ['--local']) {
      let unsafeHttp = '';
      try {
        unsafeHttp = await this.git([
          'config',
          scope,
          '--includes',
          '--name-only',
          '--get-regexp',
          '^http\\.(.*\\.)?(extraheader|cookiefile|savecookies|sslcert|sslkey|sslcertpasswordprotected)$',
        ]);
      } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
      }
      if (unsafeHttp.trim())
        throw Object.assign(
          Error(
            'remove repository HTTP credential overrides before using the Circle GitHub connection',
          ),
          { code: 'CIRCLE_GIT_HTTP_AUTH_OVERRIDE' },
        );
    }
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
    const original = path.resolve(root, relative);
    const parent = await realpath(path.dirname(original)),
      parentLocal = path.relative(root, parent);
    if (
      path.isAbsolute(parentLocal) ||
      parentLocal === '..' ||
      parentLocal.startsWith('..' + path.sep)
    )
      return { kind: 'outside', target: original } as const;
    const target = path.join(parent, path.basename(original));
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
      if (opened.kind === 'symlink') {
        const link = await readlink(opened.target);
        const parent = await realpath(path.dirname(opened.target)),
          local = path.relative(root, parent);
        if (
          path.isAbsolute(local) ||
          local === '..' ||
          local.startsWith('..' + path.sep)
        )
          throw Error('file identity changed while reading Git link');
        return Buffer.from('symlink:' + link);
      }
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
  private async canonicalNewFileDiff(
    root: string,
    relative: string,
    expected: Buffer,
    identity: { dev: number; ino: number; mode: number; mtimeMs: number },
  ) {
    const attributes = (
      await this.git([
        '-c',
        'core.fsmonitor=false',
        'check-attr',
        '-z',
        'text',
        'crlf',
        'eol',
        'ident',
        'filter',
        'working-tree-encoding',
        '--',
        relative,
      ])
    ).split('\0');
    const values = new Map<string, string>();
    for (let i = 0; i + 2 < attributes.length; i += 3)
      values.set(attributes[i + 1]!, attributes[i + 2]!);
    const filter = values.get('filter') ?? 'unspecified';
    const encoding = values.get('working-tree-encoding') ?? 'unspecified';
    if (
      !['unspecified', 'unset'].includes(filter) ||
      !['unspecified', 'unset'].includes(encoding)
    )
      return {
        status: 'unsupported-conversion',
        text: 'Preview unavailable: custom filter or encoding requires explicit review\n',
      };
    const conversion: string[] = [];
    for (const name of ['text', 'crlf', 'eol', 'ident']) {
      const value = values.get(name) ?? 'unspecified';
      if (value === 'unspecified') continue;
      if (value === 'set') conversion.push(name);
      else if (value === 'unset') conversion.push('-' + name);
      else if (/^[a-zA-Z0-9_-]+$/.test(value))
        conversion.push(name + '=' + value);
      else
        return {
          status: 'unsupported-conversion',
          text: 'Preview unavailable: unsupported Git conversion attributes\n',
        };
    }
    const configuration: string[] = [];
    for (const key of ['core.autocrlf', 'core.eol', 'core.safecrlf']) {
      try {
        const value = (await this.git(['config', '--get', key])).trim();
        configuration.push('-c', key + '=' + value);
      } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
      }
    }
    const format = (
      await this.git(['rev-parse', '--show-object-format'])
    ).trim();
    if (!['sha1', 'sha256'].includes(format))
      throw Error('unsupported Git object format');
    const directory = await mkdtemp(path.join(tmpdir(), 'circle-git-preview-'));
    try {
      const objects = path.join(directory, 'objects'),
        hooks = path.join(directory, 'hooks'),
        repository = path.join(directory, 'repository'),
        worktree = path.join(directory, 'worktree'),
        emptyConfig = path.join(directory, 'empty-config');
      await mkdir(objects);
      await mkdir(hooks);
      await mkdir(worktree);
      await mkdir(path.join(repository, 'objects'), { recursive: true });
      await mkdir(path.join(repository, 'refs'));
      await writeFile(
        path.join(repository, 'HEAD'),
        'ref: refs/heads/preview\n',
      );
      await writeFile(
        path.join(repository, 'config'),
        '[core]\nrepositoryformatversion=' +
          (format === 'sha256' ? '1' : '0') +
          '\nbare=false\n' +
          (format === 'sha256' ? '[extensions]\nobjectformat=sha256\n' : ''),
      );
      await writeFile(emptyConfig, '');
      await writeFile(
        path.join(worktree, '.gitattributes'),
        '* ' + conversion.join(' ') + '\n',
      );
      const canonical = await realpath(directory),
        inside = path.relative(root, canonical);
      if (
        !path.isAbsolute(inside) &&
        inside !== '..' &&
        !inside.startsWith('..' + path.sep)
      )
        throw Error(
          'Git preview temporary files must be outside the repository',
        );
      // Never let a concurrent repository/global configuration or attribute
      // change introduce executable conversion drivers into a read-only preview.
      const inherited = { ...process.env };
      for (const key of Object.keys(inherited))
        if (key.startsWith('GIT_')) delete inherited[key];
      const env = {
        ...inherited,
        GIT_DIR: repository,
        GIT_WORK_TREE: worktree,
        GIT_INDEX_FILE: path.join(directory, 'index'),
        GIT_OBJECT_DIRECTORY: objects,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: emptyConfig,
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_ATTR_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      };
      const run = (args: string[], input?: string | Buffer) =>
        new Promise<string>((resolve, reject) => {
          let inputError: Error | undefined;
          const child = execFile(
            'git',
            [
              '--literal-pathspecs',
              '-C',
              worktree,
              '-c',
              'core.fsmonitor=false',
              '-c',
              'core.hooksPath=' + hooks,
              '-c',
              'core.attributesFile=' + emptyConfig,
              ...configuration,
              ...args,
            ],
            { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
            (error, stdout, stderr) =>
              error || inputError
                ? reject(Error(stderr || error?.message || inputError!.message))
                : resolve(stdout),
          );
          // Reap the child before cleanup even when it rejects input (for
          // example core.safecrlf); a pipe error must not escape the main process.
          child.stdin?.on('error', (error: Error) => {
            inputError = error;
          });
          child.stdin?.end(input);
        });
      const empty = (
        await run(['hash-object', '-w', '-t', 'tree', '--stdin'], '')
      ).trim();
      // Convert only the bytes from the already-validated descriptor, using the
      // immutable conversion attributes above; never reopen the workspace path.
      const blob = (
        await run(['hash-object', '-w', '--path=preview', '--stdin'], expected)
      ).trim();
      let filemode = true;
      try {
        filemode =
          (await this.git(['config', '--bool', 'core.filemode'])).trim() ===
          'true';
      } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
      }
      const mode = filemode && identity.mode & 0o100 ? '100755' : '100644';
      await run(['update-index', '--add', '--cacheinfo', mode, blob, relative]);
      const text = await run([
        'diff',
        '--cached',
        empty,
        '--no-ext-diff',
        '--no-color',
        '--no-textconv',
        '--',
        relative,
      ]);
      const current = await this.regularFile(root, relative);
      if (current.kind !== 'file')
        throw Error('file identity changed during Git preview');
      try {
        if (
          current.info.size !== expected.length ||
          current.info.dev !== identity.dev ||
          current.info.ino !== identity.ino ||
          current.info.mode !== identity.mode ||
          current.info.mtimeMs !== identity.mtimeMs
        )
          throw Error('file content changed during Git preview');
        const bytes = Buffer.alloc(expected.length + 1);
        let size = 0;
        while (size < bytes.length) {
          const read = await current.handle.read(
            bytes,
            size,
            bytes.length - size,
            size,
          );
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (
          size !== expected.length ||
          !expected.equals(bytes.subarray(0, size))
        )
          throw Error('file content changed during Git preview');
      } finally {
        await current.handle.close();
      }
      return { status: 'text', text };
    } finally {
      await rm(directory, { recursive: true, force: true });
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
    const label = quote('b/' + relative);
    const opened = await this.regularFile(root, relative);
    const prefix = `diff --git ${quote('a/' + relative)} ${label}\n`;
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
      try {
        if (content.includes(0)) throw Error('binary');
        new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        return {
          path: relative,
          status: 'binary',
          text: prefix + `Binary files /dev/null and ${label} differ\n`,
        };
      }
      const result = await this.canonicalNewFileDiff(
        root,
        relative,
        content,
        opened.info,
      );
      return { path: relative, ...result };
    } finally {
      await opened.handle.close();
    }
  }
  /** Working-tree files of a patch that use LF line endings now. */
  private async lfFiles(targets: string[]): Promise<string[]> {
    const files: string[] = [];
    for (const target of targets) {
      if (
        !target ||
        path.isAbsolute(target) ||
        target.split(/[\\/]/).includes('..')
      )
        continue;
      const file = path.join(this.root, target);
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text !== undefined && !text.includes('\r\n')) files.push(file);
    }
    return files;
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
  private async commitId(value: unknown): Promise<string> {
    if (
      typeof value !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
    )
      throw Error('a full commit id is required');
    return (
      await this.git(['rev-parse', '--verify', `${value}^{commit}`])
    ).trim();
  }
  async call(
    method: string,
    params: Record<string, unknown> = {},
    invocation?: GitInvocation,
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
    if (method === 'history') {
      const limit = params.limit ?? 30,
        offset = params.offset ?? 0;
      if (
        !Number.isInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 100 ||
        !Number.isInteger(offset) ||
        Number(offset) < 0 ||
        Number(offset) > 100000
      )
        throw Error('invalid history page');
      let head: string;
      if (params.head !== undefined) head = await this.commitId(params.head);
      else
        head = (
          await this.optionalGit(
            ['rev-parse', '--verify', '--quiet', 'HEAD'],
            1,
            '',
          )
        ).trim();
      if (!head)
        return {
          head: '',
          commits: [],
          offset: Number(offset),
          hasMore: false,
        } satisfies GitHistory;
      const fields = (
        await this.git([
          'log',
          '-z',
          '--no-show-signature',
          '--format=%H%x00%P%x00%an%x00%aI%x00%s',
          `--max-count=${Number(limit) + 1}`,
          `--skip=${offset}`,
          head,
          '--',
        ])
      ).split('\0');
      const commits: GitHistory['commits'] = [];
      for (let i = 0; i + 4 < fields.length; i += 5)
        if (fields[i])
          commits.push({
            id: fields[i]!,
            parents: fields[i + 1]!.split(' ').filter(Boolean),
            author: fields[i + 2]!,
            date: fields[i + 3]!,
            subject: fields[i + 4]!,
          });
      return {
        head,
        commits: commits.slice(0, Number(limit)),
        offset: Number(offset),
        hasMore: commits.length > Number(limit),
      } satisfies GitHistory;
    }
    if (method === 'commitDiff') {
      const commit = await this.commitId(params.commit);
      const parents = (await this.git(['rev-parse', `${commit}^@`]))
        .trim()
        .split('\n')
        .filter(Boolean);
      const parent = parents[0] ?? null;
      const paths = params.paths === undefined ? [] : this.paths(params.paths);
      // A merge is inspected against its first parent. Root commits compare to
      // the empty tree through diff-tree --root, without writing a tree object.
      const args = parent
        ? [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--no-renames',
            parent,
            commit,
          ]
        : [
            'diff-tree',
            '--root',
            '--no-commit-id',
            '-r',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--no-renames',
            commit,
          ];
      const [text, raw, stats] = await Promise.all([
        this.git([...args, '-p', '--', ...paths]),
        this.git([...args, '--name-status', '-z', '--', ...paths]),
        this.git([...args, '--numstat', '-z', '--', ...paths]),
      ]);
      return {
        commit,
        parent,
        text,
        entries: changedFiles(raw, stats),
      } satisfies GitCommitDiff;
    }
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
      if (
        params.revision !== undefined &&
        params.revision !== (await this.snapshot()).revision
      )
        throw Error('repository changed; refresh before inspecting changes');
      const scope = params.scope ?? 'working';
      if (!['working', 'index', 'branch'].includes(String(scope)))
        throw Error('invalid diff scope');
      const args = [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
      ];
      if (scope === 'index') args.push('--cached');
      if (scope === 'branch') {
        if (typeof params.base !== 'string' || params.base.startsWith('-'))
          throw Error('base revision is required');
        args.push(`${params.base}...HEAD`);
      }
      args.push('--');
      if (params.paths) args.push(...this.paths(params.paths));
      let text = await this.git(args);
      const options = args.slice(0, args.indexOf('--')),
        paths = args.slice(args.indexOf('--'));
      const entries = changedFiles(
        await this.git([...options, '--name-status', '-z', ...paths]),
        await this.git([...options, '--numstat', '-z', ...paths]),
      );
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
          entries.push({
            path: file,
            status: 'A',
            added:
              preview.status === 'binary'
                ? null
                : preview.text
                    .split('\n')
                    .filter(
                      (line) => line.startsWith('+') && !line.startsWith('+++'),
                    ).length,
            removed: preview.status === 'binary' ? null : 0,
          });
        }
      }
      const revision = (await this.snapshot()).revision;
      if (params.revision !== undefined && params.revision !== revision)
        throw Error(
          'repository changed while inspecting changes; refresh and try again',
        );
      return { text, previews, entries, revision };
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
        // Applying to the working tree writes the whole file through Git's
        // line-ending conversion (core.autocrlf on Windows): an LF file would
        // come back CRLF. Discarding one hunk keeps the file's own line endings.
        const lfFiles =
          params.action === 'discard'
            ? await this.lfFiles(patchTargets(params.patch))
            : [];
        await this.git(['apply', ...flags, '-'], params.patch);
        for (const file of lfFiles) {
          const written = await readFile(file, 'utf8').catch(() => undefined);
          if (written?.includes('\r\n'))
            await writeFile(file, written.replace(/\r\n/g, '\n'));
        }
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
        await this.git(
          [
            'push',
            ...(this.options.setUpstream === false ? [] : ['--set-upstream']),
            'origin',
            invocation?.pushAuthentication
              ? `${state.head}:refs/heads/${state.branch}`
              : state.branch,
          ],
          undefined,
          invocation?.pushAuthentication
            ? {
                ...invocation,
                pushAuthentication: {
                  repository: invocation.pushAuthentication.repository,
                  withCredentials: (run) =>
                    invocation.pushAuthentication!.withCredentials(
                      async (env, config) => {
                        const current = await this.snapshot();
                        invocation.signal?.throwIfAborted();
                        invocation.assertActive?.();
                        if (
                          current.revision !== state.revision ||
                          current.head !== state.head ||
                          current.branch !== state.branch
                        )
                          throw Object.assign(
                            Error(
                              'repository changed while authorizing the push; refresh before retrying',
                            ),
                            { code: 'CIRCLE_GIT_PUSH_CANDIDATE_CHANGED' },
                          );
                        return run(env, config);
                      },
                    ),
                },
              }
            : invocation,
        );
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
