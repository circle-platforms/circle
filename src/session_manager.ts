import type { AgentRuntime } from './runtime.js';
import { normalizeWorkspace } from './paths.js';

export type SessionLifecycle = 'open' | 'deleting' | 'deleted';

/** UI selection belongs to the caller; execution and cleanup belong to the session. */
export class SessionRuntimeManager {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly states = new Map<string, SessionLifecycle>();
  private readonly deletions = new Map<string, Promise<void>>();
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(
    private readonly factory: (
      workspace: string,
      sessionId?: string,
    ) => AgentRuntime,
  ) {}
  register(runtime: AgentRuntime): AgentRuntime {
    const id = runtime.session.id;
    if (this.closing) throw new Error('session manager is closing');
    const previous = this.runtimes.get(id);
    if (previous && previous !== runtime)
      throw new Error('session already has a runtime');
    if (this.states.get(id) === 'deleted')
      throw new Error('session was deleted');
    this.runtimes.set(id, runtime);
    this.states.set(id, 'open');
    return runtime;
  }
  get(id: string): AgentRuntime | undefined {
    return this.runtimes.get(id);
  }
  values(): IterableIterator<AgentRuntime> {
    return this.runtimes.values();
  }
  lifecycle(id: string): SessionLifecycle {
    return this.states.get(id) ?? 'open';
  }
  open(workspace: string, sessionId?: string): AgentRuntime {
    if (this.closing) throw new Error('session manager is closing');
    if (sessionId) {
      if (this.lifecycle(sessionId) !== 'open')
        throw new Error('session is deleting or deleted');
      const existing = this.get(sessionId);
      if (existing) {
        if (existing.options.workspace !== normalizeWorkspace(workspace))
          throw new Error('session belongs to a different workspace');
        return existing;
      }
    }
    return this.register(
      this.factory(normalizeWorkspace(workspace), sessionId),
    );
  }
  create(workspace: string): AgentRuntime {
    return this.open(workspace);
  }
  reindex(runtime: AgentRuntime, oldId: string): void {
    if (oldId === runtime.session.id) return;
    if (this.runtimes.get(oldId) !== runtime)
      throw new Error('unknown runtime owner');
    if (runtime.busy || runtime.isClosing)
      throw new Error('session is not idle');
    this.runtimes.delete(oldId);
    this.register(runtime);
  }
  delete(id: string, options: { confirmed?: boolean } = {}): Promise<void> {
    if (this.closing)
      return Promise.reject(new Error('session manager is closing'));
    const pending = this.deletions.get(id);
    if (pending) return pending;
    if (this.lifecycle(id) === 'deleted') return Promise.resolve();
    const runtime = this.get(id);
    if (!runtime)
      return Promise.reject(new Error('open the session before deleting it'));
    if (
      !options.confirmed &&
      (runtime.busy ||
        runtime.jobs.list().some((job) => job.status === 'running'))
    )
      return Promise.reject(
        new Error('confirm stopping the session before deleting it'),
      );
    this.states.set(id, 'deleting');
    const deletion = runtime
      .deleteSession()
      .then(() => {
        this.runtimes.delete(id);
        this.states.set(id, 'deleted');
      })
      .finally(() => this.deletions.delete(id));
    this.deletions.set(id, deletion);
    return deletion;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const results = await Promise.allSettled([
        ...this.deletions.values(),
        ...[...this.values()].map((runtime) => runtime.close()),
      ]);
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          'session cleanup failed',
        );
      this.runtimes.clear();
    })();
    return this.closePromise;
  }
}
