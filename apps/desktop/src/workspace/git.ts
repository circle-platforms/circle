import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
const locks = new Map<string, Promise<unknown>>();
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
    if (input !== undefined)
      return new Promise<string>((resolve, reject) => {
        const child = execFile(
          'git',
          ['--literal-pathspecs', '-C', this.root, ...args],
          {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            env: {
              ...process.env,
              GIT_TERMINAL_PROMPT: '0',
              GIT_EDITOR: 'true',
            },
          },
          (error, stdout, stderr) =>
            error ? reject(Error(stderr || error.message)) : resolve(stdout),
        );
        child.stdin?.end(input);
      });
    return (
      await exec('git', ['--literal-pathspecs', '-C', this.root, ...args], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
      })
    ).stdout;
  }
  async snapshot(): Promise<GitSnapshot> {
    const root = (await this.git(['rev-parse', '--show-toplevel'])).trim();
    const head = await this.git(['rev-parse', '--verify', 'HEAD']).then(
      (s) => s.trim(),
      () => 'unborn',
    );
    const branch = (
      await this.git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(
        () => 'detached',
      )
    ).trim();
    const raw = await this.git([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
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
    const originPushUrls = await this.git([
      'remote',
      'get-url',
      '--push',
      '--all',
      'origin',
    ]).catch(() => '');
    const hash = createHash('sha256')
      .update(JSON.stringify({ head, branch, originPushUrls }))
      .update(raw);
    const indexPath = (
      await this.git(['rev-parse', '--git-path', 'index'])
    ).trim();
    hash.update(
      await readFile(path.resolve(this.root, indexPath)).catch(() =>
        Buffer.alloc(0),
      ),
    );
    for (const entry of entries)
      hash
        .update(entry.path)
        .update(
          await readFile(path.resolve(root, entry.path)).catch(() =>
            Buffer.from('missing'),
          ),
        );
    const merging = await this.git([
      'rev-parse',
      '-q',
      '--verify',
      'MERGE_HEAD',
    ]).then(
      () => true,
      () => false,
    );
    return {
      root,
      head,
      branch,
      revision: hash.digest('hex'),
      entries,
      merging,
    };
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
      return {
        text: await this.git(args),
        revision: (await this.snapshot()).revision,
      };
    }
    const key = await realpath((await this.snapshot()).root);
    const previous = locks.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
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
          await this.git(['push', '--set-upstream', 'origin', state.branch]);
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
    locks.set(key, operation);
    try {
      return await operation;
    } finally {
      if (locks.get(key) === operation) locks.delete(key);
    }
  }
}
