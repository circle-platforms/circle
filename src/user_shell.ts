import { randomUUID } from 'node:crypto';
import type { JobRegistry, Job, ExecuteResult } from './jobs.js';
import { outputTail } from './jobs.js';
import type { Message } from './types.js';
import type { CheckpointStore } from './checkpoint_store.js';
import { redact } from './redact.js';
import {
  commandExecutionReceipt,
  type CommandExecution,
} from './command_process.js';
const preflightMessages = {
  USER_SHELL_BUSY: 'Busy · run it when the turn has finished',
  USER_SHELL_PLAN_MODE:
    'Plan mode is active: shell execute is blocked. Use /plan off.',
  USER_SHELL_EMPTY: '!command shares output · !!command keeps it to you',
} as const;
/** Only guards before view creation or process allocation may raise this error. */
export class UserShellPreflightError extends Error {
  constructor(readonly code: keyof typeof preflightMessages) {
    super(preflightMessages[code]);
    this.name = 'UserShellPreflightError';
  }
  static fromCode(code: unknown): UserShellPreflightError | undefined {
    if (typeof code === 'string' && Object.hasOwn(preflightMessages, code))
      return new UserShellPreflightError(
        code as keyof typeof preflightMessages,
      );
    return undefined;
  }
}
export interface UserShellView {
  id: string;
  sessionId: string;
  anchor?: string;
  persistedMessageId?: string;
  command: string;
  quiet: boolean;
  output: string;
  status: 'running' | 'done' | 'error' | 'stopped' | 'background';
  exitCode?: number;
  jobId?: string;
  /** Actual Registry execution; a quiet command keeps this local to its owner. */
  execution?: CommandExecution;
  startedAt?: number;
}
export class UserShells {
  readonly views: UserShellView[] = [];
  private active?: Promise<ExecuteResult>;
  private controller?: AbortController;
  private jobs = new Map<string, UserShellView>();
  private pending: { sessionId: string; message: Message }[] = [];
  constructor(
    private registry: JobRegistry,
    private store: CheckpointStore,
    private hooks: {
      sessionId(): string;
      busy(): boolean;
      modelBusy(): boolean;
      planMode(): boolean;
      changed(): void;
    },
  ) {}
  get busy(): boolean {
    return Boolean(this.active);
  }
  executionChanged(execution: CommandExecution): void {
    const view = this.views.find(
      (view) =>
        view.id === execution.userShellId &&
        view.sessionId === execution.executionSessionId,
    );
    if (
      !view ||
      (view.execution &&
        (view.execution.executionId !== execution.executionId ||
          view.execution.epoch !== execution.epoch))
    )
      return;
    view.execution = structuredClone(execution);
    this.hooks.changed();
  }
  private share(view: UserShellView): void {
    if (
      view.quiet ||
      view.status === 'stopped' ||
      !this.store.get(view.sessionId)
    )
      return;
    const receipt = commandExecutionReceipt(view.execution);
    const message: Message = {
      id: 'user-shell-' + view.id,
      role: 'user',
      content: `I ran this command myself:\n$ ${view.command}\n${view.output}`,
      display: '!' + view.command,
      shell: {
        id: view.id,
        command: view.command,
        output: view.output,
        exit_code: view.exitCode ?? 130,
      },
      ...(receipt ? { commandExecutions: [receipt] } : {}),
    };
    view.persistedMessageId = message.id;
    this.pending.push({ sessionId: view.sessionId, message });
    if (!this.hooks.modelBusy()) this.flush();
  }
  flush(): void {
    for (const item of this.pending.splice(0))
      if (this.store.get(item.sessionId)) {
        this.store.append(item.sessionId, [item.message]);
        if (!this.store.get(item.sessionId)!.title)
          this.store.rename(item.sessionId, item.message.display!.slice(0, 60));
      }
  }
  async run(command: string, quiet = false): Promise<ExecuteResult> {
    if (this.hooks.busy() || this.busy)
      throw new UserShellPreflightError('USER_SHELL_BUSY');
    if (this.hooks.planMode())
      throw new UserShellPreflightError('USER_SHELL_PLAN_MODE');
    if (!command.trim()) throw new UserShellPreflightError('USER_SHELL_EMPTY');
    const sessionId = this.hooks.sessionId();
    const view: UserShellView = {
      id: randomUUID(),
      sessionId,
      anchor: this.store
        .messages(sessionId)
        .filter(
          (message) => !message.internal || message.internal === 'job_notice',
        )
        .at(-1)?.id,
      command: command.trim(),
      quiet,
      output: '',
      status: 'running',
      startedAt: Date.now(),
    };
    this.views.push(view);
    const controller = (this.controller = new AbortController());
    // Defer launch until active ownership is visible to cancellation and model guards.
    const active = (this.active = Promise.resolve().then(() =>
      this.registry.execute(
        view.command,
        {
          sessionId,
          startedBy: 'user',
          origin: {
            executionSessionId: sessionId,
            userShellId: view.id,
            displayCommand: this.registry.redact(view.command, sessionId),
          },
        },
        controller.signal,
      ),
    ));
    this.hooks.changed();
    try {
      const result = await active;
      if (result.execution) view.execution = result.execution;
      view.output = redact(result.output);
      view.exitCode = result.exit_code;
      if (result.job && result.exit_code === undefined) {
        view.status = 'background';
        view.jobId = result.job.id;
        this.jobs.set(result.job.id, view);
        const latest = this.registry.get(result.job.id);
        if (latest && latest.status !== 'running') this.ended(latest);
      } else {
        view.status =
          result.execution?.status === 'stopped'
            ? 'stopped'
            : result.exit_code === 0
              ? 'done'
              : 'error';
        if (!controller.signal.aborted) this.share(view);
      }
      return result;
    } catch (error) {
      view.status = controller.signal.aborted ? 'stopped' : 'error';
      view.output = redact(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      this.active = undefined;
      this.controller = undefined;
      this.hooks.changed();
    }
  }
  ended(job: Job): void {
    const view = this.jobs.get(job.id);
    if (!view) return;
    this.jobs.delete(job.id);
    if (job.execution) view.execution = structuredClone(job.execution);
    // User jobs do not wake a model turn. Quiet output must not become a later notice.
    this.registry.takeNotices(job.sessionId, [job.id]);
    view.status =
      job.status === 'done'
        ? 'done'
        : job.status === 'stopped'
          ? 'stopped'
          : 'error';
    view.exitCode = job.exitCode;
    try {
      view.output = redact(outputTail(job.outputPath, 80000, 2000));
      view.output += '\nFull output: ' + job.virtualPath;
    } catch {
      view.output = 'Output is unavailable.';
    }
    this.share(view);
    this.hooks.changed();
  }
  async cancel(): Promise<void> {
    this.controller?.abort(new Error('Interrupted'));
    await this.active?.catch(() => {});
  }
}
