import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, realpathSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { AgentRuntime } from '../../../../src/runtime.ts';
import { shellEnvironment } from '../../../../src/sandbox.ts';
import { commandTokens } from '../../../../src/approvals.ts';
import type { Message } from '../../../../src/types.ts';
import type { TaskRecord } from './collaboration.ts';
import type { TaskReviewerUpdate } from './task-store.ts';
import { WorkspaceDocuments } from './documents.ts';
import type {
  TaskVerificationCheck,
  TaskVerificationContext,
} from './task-executor.ts';

const exec = promisify(execFile);
const READ_TOOLS = new Set(['read_file', 'ls', 'glob', 'grep']);
const scripts = ['typecheck', 'lint', 'test', 'build'];

export interface TrustedTaskCheck {
  /** Exact acceptance criterion, fixed by the host or committed baseline. */
  criterion: string;
  script: string;
  /** Workspace-relative package directory; never a shell fragment. */
  cwd?: string;
  /** Additional immutable oracle inputs, relative to the authorized workspace. */
  oraclePaths?: string[];
}
export interface TaskVerifierOptions {
  workspace: string;
  baseline?: string;
  dataDir: string;
  /** Packaged Node 24 executable; never resolved from PATH. */
  runtimeExecutable?: string;
  npmCliPath?: string;
  /** Explicitly trusted host configuration, never copied from the task result. */
  checks?: TrustedTaskCheck[];
  withBuildResource?: <T>(
    run: () => Promise<T>,
    signal: AbortSignal,
    context: TaskVerificationContext,
  ) => Promise<T>;
  createReviewer?: (
    task: TaskRecord,
    context: TaskVerificationContext,
  ) => AgentRuntime | Promise<AgentRuntime>;
}
interface Manifest {
  path: string;
  content: Record<string, unknown>;
  scripts: Record<string, string>;
}
interface Policy {
  baseline: string;
  manifests: Manifest[];
  checks: TrustedTaskCheck[];
  oracleFiles: { path: string; content: string }[];
}

function inside(root: string, path: string): boolean {
  const local = relative(root, path);
  return (
    local === '' ||
    (!isAbsolute(local) &&
      local !== '..' &&
      !local.startsWith('../') &&
      !local.startsWith('..\\'))
  );
}
function packageDirectory(raw = ''): string {
  if (
    isAbsolute(raw) ||
    raw.includes('\\') ||
    raw.includes('\0') ||
    raw.split('/').includes('..')
  )
    throw Error('verification package must be workspace-relative');
  return raw === '.' ? '' : raw.replace(/\/$/, '');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('expected an object');
  return value as Record<string, unknown>;
}
function stringScripts(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value && typeof value === 'object' ? value : {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
async function git(
  workspace: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await exec('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout;
}
async function baselineFile(
  workspace: string,
  baseline: string,
  path: string,
): Promise<string | undefined> {
  const listed = await git(workspace, ['ls-tree', '-z', baseline, '--', path]);
  if (!listed) return undefined;
  if (!listed.startsWith('100644 ') && !listed.startsWith('100755 '))
    throw Error(`verification policy must be a regular tracked file: ${path}`);
  return git(workspace, ['show', `${baseline}:${path}`]);
}
function checks(value: unknown): TrustedTaskCheck[] {
  if (!Array.isArray(value))
    throw Error('verification checks must be an array');
  return value.map((entry) => {
    const check = object(entry);
    if (
      typeof check.criterion !== 'string' ||
      !check.criterion.trim() ||
      typeof check.script !== 'string' ||
      !/^[a-zA-Z0-9:_-]+$/.test(check.script)
    )
      throw Error('invalid trusted verification check');
    if (check.oraclePaths !== undefined && !Array.isArray(check.oraclePaths))
      throw Error('oracle paths must be an array');
    return {
      criterion: check.criterion,
      script: check.script,
      cwd: packageDirectory(check.cwd === undefined ? '' : String(check.cwd)),
      ...(Array.isArray(check.oraclePaths)
        ? {
            oraclePaths: check.oraclePaths.map((path) =>
              packageDirectory(String(path)),
            ),
          }
        : {}),
    };
  });
}
async function loadPolicy(
  options: TaskVerifierOptions,
  workspace: string,
): Promise<Policy> {
  // Resolve immediately when the factory is created, before any agent changes HEAD.
  const baseline = (
    await git(workspace, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${options.baseline ?? 'HEAD'}^{commit}`,
    ])
  ).trim();
  const tracked = (
    await git(workspace, ['ls-tree', '-r', '--name-only', '-z', baseline])
  )
    .split('\0')
    .filter(Boolean);
  const paths = tracked.filter(
    (path) => path === 'package.json' || path.endsWith('/package.json'),
  );
  const manifests: Manifest[] = [];
  for (const path of paths) {
    const content = object(
      JSON.parse((await baselineFile(workspace, baseline, path))!),
    );
    manifests.push({ path, content, scripts: stringScripts(content.scripts) });
  }
  let selected =
    options.checks === undefined ? undefined : checks(options.checks);
  if (!selected) {
    const raw = await baselineFile(
      workspace,
      baseline,
      '.circle/verification.json',
    );
    if (raw !== undefined) {
      const config = object(JSON.parse(raw));
      if (config.version !== 1)
        throw Error('unsupported verification policy version');
      selected = checks(config.checks);
    }
  }
  if (!selected) {
    const root = manifests.find((manifest) => manifest.path === 'package.json');
    const available = root?.scripts ?? {};
    selected = (
      available.check ? ['check'] : scripts.filter((name) => available[name])
    ).map((script) => ({
      criterion: `project script: ${script}`,
      script,
      cwd: '',
    }));
  }
  for (const check of selected) {
    const manifest = manifests.find(
      (entry) =>
        entry.path ===
        join(check.cwd ?? '', 'package.json')
          .split('\\')
          .join('/'),
    );
    if (!manifest?.scripts[check.script])
      throw Error(
        `trusted baseline has no script ${check.script} in ${check.cwd || '.'}`,
      );
  }
  const oraclePaths = new Set(
    (selected.length ? tracked : []).filter(
      (path) =>
        (/(?:^|\/)(?:tests?|__tests__)\//.test(path) &&
          /\.[cm]?[jt]sx?$/.test(path)) ||
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
        /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig[^/]*\.json|(?:vite|vitest|eslint)\.config\.[^/]+|\.eslintrc[^/]*)$/.test(
          path,
        ),
    ),
  );
  const visited = new Set<string>();
  const inspectScript = (manifest: Manifest, script: string) => {
    const key = `${manifest.path}:${script}`;
    if (visited.has(key)) return;
    visited.add(key);
    const tokens = commandTokens(manifest.scripts[script] ?? '') ?? [];
    for (const token of tokens) {
      if (manifest.scripts[token]) inspectScript(manifest, token);
      if (!/\.[cm]?[jt]sx?$/.test(token) || token.startsWith('-')) continue;
      const path = relative(
        workspace,
        resolve(workspace, dirname(manifest.path), token),
      )
        .split('\\')
        .join('/');
      if (tracked.includes(path)) oraclePaths.add(path);
    }
  };
  for (const check of selected) {
    const manifest = manifests.find(
      (entry) =>
        entry.path ===
        join(check.cwd ?? '', 'package.json')
          .split('\\')
          .join('/'),
    )!;
    inspectScript(manifest, check.script);
    for (const path of check.oraclePaths ?? []) {
      if (!tracked.includes(path))
        throw Error(
          `trusted oracle input is not in the fixed baseline: ${path}`,
        );
      oraclePaths.add(path);
    }
  }
  const oracleFiles: Policy['oracleFiles'] = [];
  // Large repositories must not start two Git children for every test at once.
  for (const path of oraclePaths)
    if (!paths.includes(path))
      oracleFiles.push({
        path,
        content: (await baselineFile(workspace, baseline, path))!,
      });
  return { baseline, manifests, checks: selected, oracleFiles };
}
async function npmCli(node: string, configured?: string): Promise<string> {
  const candidates = configured
    ? [configured]
    : [
        join(
          dirname(node),
          '..',
          'lib',
          'node_modules',
          'npm',
          'bin',
          'npm-cli.js',
        ),
        join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ];
  for (const path of candidates)
    if (isAbsolute(path) && existsSync(path)) return realpath(path);
  throw Error(
    'the bundled Node toolchain has no npm CLI; configure its exact path',
  );
}

async function stopOwned(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await exec('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(
      (error) => {
        if (child.exitCode === null && child.signalCode === null) throw error;
      },
    );
    return;
  }
  const running = async () => {
    const rows = (
      await exec('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' })
    ).stdout;
    return rows.split('\n').some((row) => {
      const [group, state] = row.trim().split(/\s+/);
      return Number(group) === child.pid && state && !state.startsWith('Z');
    });
  };
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  if (!(await running())) return;
  kill('SIGTERM');
  await delay(100);
  if (await running()) kill('SIGKILL');
  const deadline = Date.now() + 3000;
  while (await running()) {
    if (Date.now() > deadline)
      throw Error('owned verification processes did not stop');
    await delay(20);
  }
}
async function runCommand(
  node: string,
  cli: string,
  cwd: string,
  script: string,
  logPath: string,
  signal: AbortSignal,
): Promise<{ code: number | null; failure?: string; cleanupFailed?: boolean }> {
  signal.throwIfAborted();
  const shell =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
      : join(dirname(logPath), 'verification-shell.sh');
  if (process.platform !== 'win32')
    await writeFile(
      shell,
      '#!/bin/sh\nPATH="$CIRCLE_VERIFIER_NODE_BIN:$PATH"\nexport PATH\nexec /bin/sh "$@"\n',
      { mode: 0o700 },
    );
  const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
  const args = [cli, 'run', script];
  const env = {
    ...Object.fromEntries(
      Object.entries(shellEnvironment()).filter(
        ([name]) => !/^npm_config_/i.test(name),
      ),
    ),
    PATH: [
      dirname(node),
      join(cwd, 'node_modules', '.bin'),
      process.env.PATH ?? '',
    ].join(delimiter),
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '',
    npm_node_execpath: node,
    npm_execpath: cli,
    npm_config_userconfig: join(dirname(logPath), 'npm-user.rc'),
    npm_config_globalconfig: join(dirname(logPath), 'npm-global.rc'),
    npm_config_cache: join(dirname(logPath), 'npm-cache'),
    npm_config_script_shell: shell,
    CIRCLE_VERIFIER_NODE_BIN: dirname(node),
    CI: '1',
  };
  log.write(JSON.stringify({ executable: node, args, cwd }) + '\n');
  const child = spawn(node, args, {
    cwd,
    env,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failure: string | undefined;
  let cleanupFailed = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= stopOwned(child);
    void stopping.catch(() => {});
  };
  const abort = () => stop();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) stop();
  child.stdout.on('data', (chunk: Buffer) => {
    if (!log.write(chunk)) child.stdout.pause();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (!log.write(chunk)) child.stderr.pause();
  });
  log.on('drain', () => {
    child.stdout.resume();
    child.stderr.resume();
  });
  log.on('error', (error) => {
    failure = String(error);
    stop();
  });
  // A descendant can inherit pipes after npm exits. Clean its group before
  // waiting for `close`, which otherwise waits forever for those same pipes.
  child.once('exit', stop);
  const code = await new Promise<number | null>((done) => {
    child.once('error', (error) => {
      failure = String(error);
      done(null);
    });
    child.once('close', done);
  });
  try {
    try {
      await (stopping ?? stopOwned(child));
    } catch (error) {
      cleanupFailed = true;
      failure = `Verification process cleanup failed: ${String(error)}`;
    }
    log.end(
      `\n${JSON.stringify({ exitCode: code, cancelled: signal.aborted, failure })}\n`,
    );
    await finished(log);
  } finally {
    signal.removeEventListener('abort', abort);
  }
  if (!cleanupFailed) signal.throwIfAborted();
  return { code, failure, cleanupFailed };
}

async function verificationTree(
  options: TaskVerifierOptions,
  policy: Policy,
  context: TaskVerificationContext,
  node: string,
  cli: string,
): Promise<TaskVerificationCheck[]> {
  const patch = await readFile(context.changes.patchPath);
  if (
    createHash('sha256').update(patch).digest('hex') !== context.changes.sha256
  )
    throw Error('candidate patch changed before verification');
  const directory = await realpath(
    await mkdtemp(join(options.dataDir, 'verification-')),
  );
  const worktree = join(directory, 'workspace');
  const pinnedPatch = join(directory, 'candidate.patch');
  let added = false;
  let keepWorktree = false;
  try {
    // Apply the bytes whose hash was checked, never a second read of a mutable artifact.
    await writeFile(pinnedPatch, patch, { mode: 0o600 });
    await git(
      options.workspace,
      ['worktree', 'add', '--detach', worktree, context.changes.baseline],
      context.signal,
    );
    added = true;
    if (patch.length)
      await git(worktree, ['apply', '--binary', pinnedPatch], context.signal);
    const replaced: string[] = [];
    const documents = new WorkspaceDocuments(worktree);
    for (const manifest of policy.manifests) {
      const path = join(worktree, manifest.path);
      const current = await documents.snapshot(manifest.path, {
        signal: context.signal,
      });
      const candidate = current
        ? object(JSON.parse(current.content))
        : manifest.content;
      if (
        JSON.stringify(stringScripts(candidate.scripts)) !==
        JSON.stringify(manifest.scripts)
      )
        replaced.push(manifest.path);
      await documents.save(
        manifest.path,
        JSON.stringify(
          {
            ...candidate,
            scripts: manifest.scripts,
            workspaces: manifest.content.workspaces,
            config: manifest.content.config,
          },
          null,
          2,
        ) + '\n',
        current?.revision ?? null,
        { signal: context.signal },
      );
      const localModules = join(dirname(path), 'node_modules');
      const sourceModules = join(
        context.worktree,
        dirname(manifest.path),
        'node_modules',
      );
      if (existsSync(sourceModules) && !existsSync(localModules))
        await symlink(
          await realpath(sourceModules),
          localModules,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
    }
    const replacedOracles: string[] = [];
    for (const oracle of policy.oracleFiles) {
      const current = await documents.snapshot(oracle.path, {
        signal: context.signal,
      });
      if (current?.content !== oracle.content)
        replacedOracles.push(oracle.path);
      if (current?.content !== oracle.content)
        await documents.save(
          oracle.path,
          oracle.content,
          current?.revision ?? null,
          { signal: context.signal },
        );
    }
    documents.close();
    const evidencePath = join(
      context.artifactDirectory,
      `verification-${randomUUID()}.json`,
    );
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          baseline: policy.baseline,
          candidateBaseline: context.changes.baseline,
          candidateHead: context.changes.head,
          patchSha256: context.changes.sha256,
          protectedManifests: policy.manifests.map(({ path }) => path),
          replacedScripts: replaced,
          protectedOracleFiles: policy.oracleFiles.map(({ path }) => path),
          replacedOracleFiles: replacedOracles,
          node,
          npmCli: cli,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await Promise.all(
      ['npm-user.rc', 'npm-global.rc'].map((name) =>
        writeFile(join(context.artifactDirectory, name), '', { mode: 0o600 }),
      ),
    );
    const result: TaskVerificationCheck[] = [];
    for (const [index, check] of policy.checks.entries()) {
      context.signal.throwIfAborted();
      const cwd = join(worktree, packageDirectory(check.cwd));
      if (!inside(worktree, await realpath(cwd)))
        throw Error('verification package escaped its workspace');
      const log = join(
        context.artifactDirectory,
        `check-${index}-${randomUUID()}.log`,
      );
      const run = await runCommand(
        node,
        cli,
        cwd,
        check.script,
        log,
        context.signal,
      );
      keepWorktree ||= run.cleanupFailed === true;
      result.push({
        criterion: check.criterion,
        status: run.failure
          ? 'needs_review'
          : run.code === 0
            ? 'passed'
            : 'failed',
        source: 'command',
        evidence: `Trusted baseline ${policy.baseline}; candidate HEAD ${context.changes.head}; patch ${context.changes.sha256}. ${replaced.length ? `Candidate scripts in ${replaced.join(', ')} were replaced by trusted baseline scripts for this check. ` : ''}${run.failure ?? `Process exited ${run.code}.`} ${keepWorktree ? `Process cleanup needs inspection; retained workspace: ${worktree}. ` : ''}Full output: ${log}`,
        command: JSON.stringify([node, cli, 'run', check.script]),
        ...(run.code === null ? {} : { exitCode: run.code }),
        artifactPaths: [log, evidencePath],
      });
      if (keepWorktree) {
        context.signal.throwIfAborted();
        break;
      }
    }
    return result;
  } finally {
    if (added && !keepWorktree)
      await git(options.workspace, ['worktree', 'remove', '--force', worktree]);
    if (!keepWorktree) await rm(directory, { recursive: true, force: true });
  }
}

function sourcePath(workspace: string, path: string): string {
  const full = resolve(workspace, path);
  try {
    return realpathSync(full);
  } catch {
    return full;
  }
}
function readEvidence(messages: Message[], workspace: string): Set<string> {
  const calls = new Map(
    messages
      .flatMap((message) => message.tool_calls ?? [])
      .filter((call) => call.name === 'read_file')
      .map((call) => [call.id, call]),
  );
  const paths = new Set<string>();
  for (const result of messages) {
    const call = calls.get(result.tool_call_id ?? '');
    if (
      !call ||
      result.role !== 'tool' ||
      result.status === 'error' ||
      result.content.startsWith('System reminder: no lines were read')
    )
      continue;
    const raw = call.args.file_path ?? call.args.path;
    if (typeof raw === 'string') paths.add(sourcePath(workspace, raw));
  }
  return paths;
}
async function review(
  options: TaskVerifierOptions,
  task: TaskRecord,
  context: TaskVerificationContext,
  criteria: string[],
): Promise<TaskVerificationCheck[]> {
  if (!criteria.length) return [];
  if (!options.createReviewer)
    return criteria.map((criterion) => ({
      criterion,
      status: 'needs_review',
      source: 'inspection',
      evidence:
        'No trusted command oracle or independent reviewer covers this acceptance criterion. The worker completion claim is not verification.',
    }));
  const reviewRoot = await realpath(context.worktree);
  const runtime = await options.createReviewer(task, context);
  const originalIds = new Set([
    task.spec.sessionId,
    context.workerSessionId,
    ...context.events.map((event) => event.run_id),
  ]);
  const provenance = {
    sessionId: runtime.session.id,
    workspace: reviewRoot,
    baseline: context.changes.baseline,
    head: context.changes.head,
    patchSha256: context.changes.sha256,
  };
  let bound = false,
    closed = false;
  let outcome: TaskReviewerUpdate['state'] = 'failed';
  let reason: string | undefined;
  let artifactBinding: TaskReviewerUpdate['artifact'];
  const report = (state: TaskReviewerUpdate['state']) =>
    context.reviewer?.({
      ...provenance,
      state,
      reason,
      ...(artifactBinding ? { artifact: artifactBinding } : {}),
    });
  const close = async () => {
    if (closed) return;
    try {
      await runtime.close();
    } catch (error) {
      reason = `reviewer cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      if (bound) report('cancelling');
      throw error;
    }
    closed = true;
    if (bound) report(context.signal.aborted ? 'cancelled' : outcome);
  };
  context.onCleanup?.(close);
  const abort = () => {
    void runtime.cancel().catch(() => {});
  };
  try {
    if (
      originalIds.has(runtime.session.id) ||
      runtime.busy ||
      runtime.harness.messages.some((message) => message.role !== 'system') ||
      runtime.jobs.list().some((job) => job.status === 'running')
    )
      throw Error('verification requires a fresh independent reviewer session');
    if ((await realpath(runtime.options.workspace)) !== reviewRoot) {
      throw Error('reviewer must inspect this task workspace');
    }
    runtime.options.headless = true;
    runtime.options.integrations = false;
    runtime.harness.options.planFileMutation = () => false;
    const originalStep = runtime.harness.options.beforeStep;
    const restrict = () => {
      runtime.harness.planMode = true;
      runtime.harness.tools = runtime.harness.tools.filter(
        (tool) => READ_TOOLS.has(tool.name) && tool.effect === 'read',
      );
    };
    runtime.harness.options.beforeStep = () => {
      originalStep?.();
      restrict();
    };
    restrict();
    context.signal.addEventListener('abort', abort, { once: true });
    context.signal.throwIfAborted();
    report('running');
    bound = true;
    const result = await runtime.harness.run(
      [
        'Independently review this candidate. You may inspect files but must not change files, execute commands or spawn agents.',
        'The worker answer is an unverified claim. Read the actual source for every judgment. Do not mark a criterion passed from the answer alone.',
        'Return only JSON: {"checks":[{"criterion":"exact criterion","status":"passed|failed|needs_review","evidence":"specific explanation","sources":[{"path":"workspace-relative file actually read","line":1}]}]}. A passed or failed judgment needs sources from actual successful read_file calls. Use needs_review when no reliable oracle exists.',
        JSON.stringify({
          criteria,
          baseline: context.changes.baseline,
          head: context.changes.head,
          changedPaths: context.changes.paths,
          workerClaim: context.answer,
        }),
      ].join('\n\n'),
    );
    context.signal.throwIfAborted();
    const messages = runtime.harness.messages;
    const sources = readEvidence(messages, reviewRoot);
    const artifact = join(
      context.artifactDirectory,
      `independent-review-${randomUUID()}.json`,
    );
    await writeFile(
      artifact,
      runtime.redact(
        JSON.stringify(
          {
            sessionId: runtime.session.id,
            provenance: {
              role: 'reviewer',
              taskId: task.spec.id,
              attempt: task.attempt,
              ownerSessionId: task.spec.sessionId,
              workerSessionId: context.workerSessionId,
              ...provenance,
            },
            messages,
            answer: result.answer,
          },
          null,
          2,
        ),
      ),
      { mode: 0o600 },
    );
    if (context.artifact) {
      const registered = await context.artifact(artifact, 'verification');
      artifactBinding = {
        id: registered.id,
        path: registered.path,
        sha256: registered.sha256,
      };
    }
    let parsed: Record<string, unknown>[] = [];
    try {
      const data = object(
        JSON.parse(
          result.answer.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''),
        ),
      );
      if (Array.isArray(data.checks)) parsed = data.checks.map(object);
    } catch {
      /* A free-form model answer is not an acceptance oracle. */
    }
    const checks = criteria.map((criterion): TaskVerificationCheck => {
      const check = parsed.find((entry) => entry.criterion === criterion);
      const references = Array.isArray(check?.sources)
        ? check.sources.flatMap((source) => {
            try {
              const entry = object(source);
              return typeof entry.path === 'string'
                ? [sourcePath(reviewRoot, entry.path)]
                : [];
            } catch {
              return [];
            }
          })
        : [];
      const grounded =
        references.length > 0 &&
        references.every(
          (path) => inside(reviewRoot, path) && sources.has(path),
        );
      const valid =
        check &&
        typeof check.evidence === 'string' &&
        check.evidence.trim() &&
        ['passed', 'failed', 'needs_review'].includes(String(check.status));
      return {
        criterion,
        status:
          valid && (check.status === 'needs_review' || grounded)
            ? (check.status as TaskVerificationCheck['status'])
            : 'needs_review',
        source: 'independent-review',
        evidence:
          valid && grounded
            ? `Independent session ${runtime.session.id}: ${String(check.evidence)} Sources: ${references.join(', ')}`
            : 'Independent reviewer did not provide a structured judgment grounded in actual source reads.',
        artifactPaths: [artifact],
      };
    });
    outcome = checks.some((check) => check.status === 'failed')
      ? 'failed'
      : checks.some((check) => check.status === 'needs_review')
        ? 'needs_review'
        : 'succeeded';
    return checks;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    outcome = context.signal.aborted ? 'cancelled' : 'failed';
    throw error;
  } finally {
    context.signal.removeEventListener('abort', abort);
    await close();
  }
}

/** Construct once when the authorized project is opened, before dispatching write tasks. */
export function createTaskVerifier(
  options: TaskVerifierOptions,
): (
  task: TaskRecord,
  context: TaskVerificationContext,
) => Promise<TaskVerificationCheck[]> {
  const workspace = realpathSync.native(options.workspace);
  if (!isAbsolute(options.dataDir))
    throw Error('verification data directory must be absolute');
  if (options.runtimeExecutable && !isAbsolute(options.runtimeExecutable))
    throw Error('verification Node executable must be absolute');
  if (options.npmCliPath && !isAbsolute(options.npmCliPath))
    throw Error('verification npm CLI must be absolute');
  if (inside(workspace, resolve(options.dataDir)))
    throw Error('verification data must be outside the candidate workspace');
  const baseline = execFileSync(
    'git',
    [
      '-C',
      workspace,
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${options.baseline ?? 'HEAD'}^{commit}`,
    ],
    { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  ).trim();
  const pinned = {
    ...options,
    workspace,
    baseline,
    checks: options.checks ? structuredClone(options.checks) : undefined,
  };
  const policy = loadPolicy(pinned, workspace);
  policy.catch(() => {});
  const node = realpathSync(options.runtimeExecutable ?? process.execPath);
  return async (task, context) => {
    context.signal.throwIfAborted();
    if ((await realpath(task.spec.workspace)) !== workspace)
      throw Error('task belongs to another authorized workspace');
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    if (inside(workspace, await realpath(options.dataDir)))
      throw Error('verification data must be outside the candidate workspace');
    await mkdir(context.artifactDirectory, { recursive: true, mode: 0o700 });
    const common = async (path: string) =>
      realpath(
        resolve(
          path,
          (
            await git(path, ['rev-parse', '--git-common-dir'], context.signal)
          ).trim(),
        ),
      );
    if ((await common(workspace)) !== (await common(context.worktree)))
      throw Error('task worktree belongs to another repository');
    let commandChecks: TaskVerificationCheck[] = [];
    try {
      const trusted = await policy;
      context.signal.throwIfAborted();
      if (trusted.checks.length) {
        const cli = await npmCli(node, options.npmCliPath);
        const run = () => verificationTree(pinned, trusted, context, node, cli);
        commandChecks = options.withBuildResource
          ? await options.withBuildResource(run, context.signal, context)
          : await run();
      }
    } catch (error) {
      context.signal.throwIfAborted();
      commandChecks.push({
        criterion: 'trusted verification infrastructure',
        status: 'needs_review',
        source: 'inspection',
        evidence: error instanceof Error ? error.message : String(error),
      });
    }
    const uncovered = task.spec.acceptanceCriteria.filter(
      (criterion) =>
        !commandChecks.some(
          (check) => check.criterion === criterion && check.status === 'passed',
        ),
    );
    let reviewed: TaskVerificationCheck[];
    try {
      reviewed = await review(pinned, task, context, uncovered);
    } catch (error) {
      context.signal.throwIfAborted();
      reviewed = uncovered.map((criterion) => ({
        criterion,
        status: 'needs_review',
        source: 'independent-review',
        evidence: `Independent verification could not complete: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }
    return [...commandChecks, ...reviewed];
  };
}
