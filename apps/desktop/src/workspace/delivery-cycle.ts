import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

export type CycleState =
  | 'queued'
  | 'working'
  | 'verifying'
  | 'publishing'
  | 'waiting_ci'
  | 'repairing'
  | 'needs_review'
  | 'pending_human_merge';
export interface CycleSpec {
  id: string;
  workspace: string;
  title: string;
  body: string;
  acceptanceCriteria: string[];
}
export interface CycleCheck {
  name: string;
  bucket: 'pass' | 'fail' | 'pending' | 'cancel' | 'skipping';
  runId?: number;
}
export interface CycleEvidence {
  criterion: string;
  status: 'passed' | 'failed' | 'needs_review';
  source: 'command' | 'independent-review' | 'inspection';
  detail: string;
}
export interface CycleVerification {
  passed: boolean;
  head: string;
  evidence: CycleEvidence[];
  paths: string[];
}
export interface CycleGitSnapshot {
  head: string;
  revision: string;
  branch: string;
  dirty: boolean;
}
export interface CycleRecord extends CycleSpec {
  state: CycleState;
  attempt: number;
  taskIds: string[];
  publishedHead?: string;
  recoveryPhase?: 'diagnosis';
  ciQueryRetry?: { failures: number; notBefore: number };
  pr?: { url: string; number?: number; head: string };
  lastFailure?: {
    fingerprint: string;
    logs: string;
    checks: CycleCheck[];
    head: string;
  };
  failureCounts: Record<string, number>;
  reason?: string;
  updatedAt: string;
}
export interface CyclePorts {
  bind?(record: CycleRecord, mode: 'created' | 'restored'): void;
  tasks: {
    create(
      cycle: CycleRecord,
      request: {
        kind: 'implementation' | 'repair' | 'diagnosis';
        prompt: string;
        dependencies?: string[];
      },
      operation: { operationId: string },
    ): Promise<string[]>;
    status(
      cycle: CycleRecord,
      ids: string[],
    ): Promise<'pending' | 'passed' | 'failed' | 'needs_review'>;
    merge(
      cycle: CycleRecord,
      ids: string[],
      operation: { operationId: string },
    ): Promise<{
      status: 'merged' | 'needs_review' | 'conflict';
      workspace?: string;
    }>;
  };
  verify(cycle: CycleRecord): Promise<CycleVerification>;
  git: {
    snapshot(cycle: CycleRecord): Promise<CycleGitSnapshot>;
    commit(
      cycle: CycleRecord,
      input: { revision: string; paths: string[]; message: string },
      operation: { operationId: string },
    ): Promise<{ head: string }>;
    push(
      cycle: CycleRecord,
      input: { revision: string; head: string },
      operation: { operationId: string },
    ): Promise<void>;
  };
  delivery: {
    publish(
      cycle: CycleRecord,
      input: { revision: string; head: string },
      operation: { operationId: string },
    ): Promise<{ url: string; number?: number; head: string }>;
    checks(cycle: CycleRecord): Promise<{ head: string; checks: CycleCheck[] }>;
    logs(cycle: CycleRecord, runId: number): Promise<string>;
    retry(
      cycle: CycleRecord,
      runId: number,
      operation: { operationId: string },
    ): Promise<void>;
    ready(
      cycle: CycleRecord,
      input: { revision: string; head: string },
      operation: { operationId: string },
    ): Promise<void>;
  };
}
class CiQueryUnavailable extends Error {}
interface Operation {
  id: string;
  cycleId: string;
  kind: string;
  inputHash: string;
  state: 'running' | 'done' | 'unknown';
  result?: unknown;
}
interface Ledger {
  version: 1;
  cycles: CycleRecord[];
  operations: Operation[];
}
const hash = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
// Ignore transport decoration and ISO timestamps, preserving actual error text.
const normalizeFailureLog = (logs: string) =>
  logs
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>')
    .trim();
const countConsecutiveFailure = (cycle: CycleRecord, fingerprint: string) => {
  const count =
    cycle.lastFailure?.fingerprint === fingerprint
      ? (cycle.failureCounts[fingerprint] ?? 0) + 1
      : 1;
  cycle.failureCounts[fingerprint] = count;
  return count;
};
const now = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);
/** One owner per ledger. All mutations are durable before effects; unknown effects are never replayed. */
export class DeliveryCycleService {
  private ledger: Ledger = { version: 1, cycles: [], operations: [] };
  private queues = new Map<string, Promise<unknown>>();
  private persistence = Promise.resolve();
  private lockToken = randomUUID();
  private closed = false;
  private constructor(
    private readonly options: {
      dataDir: string;
      ports: CyclePorts;
      onEvent?: (cycle: CycleRecord) => void;
      clock?: () => number;
    },
  ) {}
  static async open(options: {
    dataDir: string;
    ports: CyclePorts;
    onEvent?: (cycle: CycleRecord) => void;
    clock?: () => number;
  }): Promise<DeliveryCycleService> {
    const service = new DeliveryCycleService(options);
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    const lock = join(options.dataDir, 'delivery-cycles.lock');
    try {
      const handle = await open(lock, 'wx', 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, token: service.lockToken }),
      );
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = JSON.parse(await readFile(lock, 'utf8')) as { pid: number };
      try {
        process.kill(owner.pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
        await unlink(lock);
        return DeliveryCycleService.open(options);
      }
      throw Error('delivery cycle ledger already has an owner');
    }
    try {
      service.ledger = JSON.parse(
        await readFile(join(options.dataDir, 'delivery-cycles.json'), 'utf8'),
      ) as Ledger;
      if (
        service.ledger.version !== 1 ||
        !Array.isArray(service.ledger.cycles) ||
        !Array.isArray(service.ledger.operations)
      )
        throw Error('invalid delivery cycle ledger');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await unlink(lock);
        throw error;
      }
    }
    for (const operation of service.ledger.operations)
      if (operation.state === 'running') {
        operation.state = 'unknown';
        const cycle = service.ledger.cycles.find(
          (item) => item.id === operation.cycleId,
        );
        if (cycle) {
          cycle.state = 'needs_review';
          cycle.reason = `${operation.kind} result is unknown after restart; inspect effects before continuing`;
        }
      }
    for (const cycle of service.ledger.cycles) {
      try {
        options.ports.bind?.(copy(cycle), 'restored');
      } catch {
        cycle.state = 'needs_review';
        cycle.reason = 'cycle authorization scope could not be restored';
      }
    }
    await service.save();
    return service;
  }
  private async save(): Promise<void> {
    const value = JSON.stringify(this.ledger, null, 2) + '\n';
    const write = this.persistence
      .catch(() => {})
      .then(async () => {
        const target = join(this.options.dataDir, 'delivery-cycles.json');
        const temp = `${target}.${randomUUID()}.tmp`;
        await writeFile(temp, value, { mode: 0o600 });
        await rename(temp, target);
      });
    this.persistence = write;
    await write;
  }
  private record(id: string): CycleRecord {
    if (this.closed) throw Error('delivery cycle service is closed');
    const cycle = this.ledger.cycles.find((item) => item.id === id);
    if (!cycle) throw Error('delivery cycle does not exist');
    return cycle;
  }
  list(): CycleRecord[] {
    return copy(this.ledger.cycles);
  }
  snapshot(id: string): CycleRecord {
    return copy(this.record(id));
  }
  private async update(
    cycle: CycleRecord,
    state: CycleState,
    reason?: string,
  ): Promise<void> {
    cycle.state = state;
    cycle.reason = reason;
    cycle.updatedAt = now();
    await this.save();
    try {
      this.options.onEvent?.(copy(cycle));
    } catch {
      /* An observer cannot invalidate a durable transition. */
    }
  }
  private async operation<T>(
    cycle: CycleRecord,
    kind: string,
    operationId: string,
    input: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!operationId || operationId.length > 200)
      throw Error('valid operation id is required');
    const inputHash = hash(input);
    const previous = this.ledger.operations.find(
      (item) => item.id === operationId,
    );
    if (previous) {
      if (
        previous.cycleId !== cycle.id ||
        previous.kind !== kind ||
        previous.inputHash !== inputHash
      )
        throw Error('operation id was reused for different input');
      if (previous.state === 'done') return copy(previous.result) as T;
      throw Error(
        `${kind} has unknown or in-progress effects; review before retrying`,
      );
    }
    const operation: Operation = {
      id: operationId,
      cycleId: cycle.id,
      kind,
      inputHash,
      state: 'running',
    };
    this.ledger.operations.push(operation);
    await this.save();
    try {
      const result = await run();
      operation.result = result ?? null;
      operation.state = 'done';
      await this.save();
      return result;
    } catch (error) {
      operation.state = 'unknown';
      await this.update(
        cycle,
        'needs_review',
        `${kind} failed or returned an unknown result: ${String(error)}`,
      );
      throw error;
    }
  }
  async create(
    spec: CycleSpec,
    operation: { operationId: string },
  ): Promise<CycleRecord> {
    if (this.closed) throw Error('delivery cycle service is closed');
    if (!operation.operationId || operation.operationId.length > 200)
      throw Error('valid operation id is required');
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(spec.id) ||
      !spec.workspace ||
      !spec.title.trim() ||
      !spec.acceptanceCriteria.length ||
      spec.acceptanceCriteria.some((value) => !value.trim())
    )
      throw Error(
        'valid cycle, workspace, title and acceptance criteria are required',
      );
    const existing = this.ledger.cycles.find((item) => item.id === spec.id);
    if (existing) {
      const stored = this.ledger.operations.find(
        (item) =>
          item.id === operation.operationId &&
          item.cycleId === spec.id &&
          item.kind === 'create',
      );
      if (!stored || stored.inputHash !== hash(spec))
        throw Error('cycle id already exists');
      return copy(existing);
    }
    if (
      this.ledger.operations.some((item) => item.id === operation.operationId)
    )
      throw Error('operation id already exists');
    const cycle: CycleRecord = {
      ...copy(spec),
      state: 'queued',
      attempt: 0,
      taskIds: [],
      failureCounts: {},
      updatedAt: now(),
    };
    try {
      this.options.ports.bind?.(copy(cycle), 'created');
    } catch {
      cycle.state = 'needs_review';
      cycle.reason = 'cycle authorization scope could not be created';
    }
    this.ledger.cycles.push(cycle);
    this.ledger.operations.push({
      id: operation.operationId,
      cycleId: spec.id,
      kind: 'create',
      inputHash: hash(spec),
      state: 'done',
      result: spec.id,
    });
    await this.save();
    try {
      this.options.onEvent?.(copy(cycle));
    } catch {
      /* An observer cannot invalidate a durable transition. */
    }
    return copy(cycle);
  }
  async advance(id: string): Promise<CycleRecord> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(() => this.advanceOwned(this.record(id)));
    this.queues.set(id, result);
    try {
      return await result;
    } finally {
      if (this.queues.get(id) === result) this.queues.delete(id);
    }
  }
  private async recover(
    cycle: CycleRecord,
    logs: string,
    head: string,
    checks: CycleCheck[],
  ) {
    const fingerprint = hash({
      checks,
      logs: normalizeFailureLog(logs),
    });
    const count = countConsecutiveFailure(cycle, fingerprint);
    cycle.lastFailure = { fingerprint, logs, checks, head };
    const kind = count >= 3 ? 'diagnosis' : 'repair';
    const operationId = `${cycle.id}:${kind}:${cycle.attempt + 1}`;
    const ids = await this.operation(
      cycle,
      `create ${kind} tasks`,
      operationId,
      cycle.lastFailure,
      () =>
        this.options.ports.tasks.create(
          copy(cycle),
          {
            kind,
            prompt: `${kind === 'diagnosis' ? 'Independently diagnose this repeated failure and propose a revised task breakdown. Do not repeat the same repair.' : 'Repair the failed verification and verify the original acceptance criteria.'}\n${logs}`,
          },
          { operationId },
        ),
    );
    cycle.taskIds = ids;
    cycle.attempt++;
    if (kind === 'diagnosis') cycle.recoveryPhase = 'diagnosis';
    else delete cycle.recoveryPhase;
    await this.update(
      cycle,
      ids.length ? 'repairing' : 'needs_review',
      ids.length ? undefined : 'recovery created no tasks',
    );
  }
  private async advanceOwned(cycle: CycleRecord): Promise<CycleRecord> {
    const ports = this.options.ports;
    if (['needs_review', 'pending_human_merge'].includes(cycle.state))
      return copy(cycle);
    try {
      if (cycle.state === 'queued') {
        const operationId = `${cycle.id}:tasks:0`;
        cycle.taskIds = await this.operation(
          cycle,
          'create tasks',
          operationId,
          cycle.acceptanceCriteria,
          () =>
            ports.tasks.create(
              copy(cycle),
              { kind: 'implementation', prompt: cycle.body },
              { operationId },
            ),
        );
        if (!cycle.taskIds.length) {
          await this.update(
            cycle,
            'needs_review',
            'task creation returned no tasks',
          );
          return copy(cycle);
        }
        await this.update(cycle, 'working');
      }
      if (cycle.state === 'working' || cycle.state === 'repairing') {
        const status = await ports.tasks.status(copy(cycle), [
          ...cycle.taskIds,
        ]);
        if (status === 'pending') return copy(cycle);
        if (status !== 'passed') {
          await this.update(
            cycle,
            'needs_review',
            `tasks require attention: ${status}`,
          );
          return copy(cycle);
        }
        if (cycle.recoveryPhase === 'diagnosis') {
          const operationId = `${cycle.id}:replan:${cycle.attempt}`;
          const dependencies = [...cycle.taskIds];
          cycle.taskIds = await this.operation(
            cycle,
            'create revised repair tasks',
            operationId,
            dependencies,
            () =>
              ports.tasks.create(
                copy(cycle),
                {
                  kind: 'repair',
                  dependencies,
                  prompt: `Use the independently accepted diagnosis in the completed dependency results/artifacts to revise the task breakdown and implement a different repair. Preserve all original acceptance criteria; propose further follow-up tasks to the coordinator when needed.\n${cycle.lastFailure?.logs ?? ''}`,
                },
                { operationId },
              ),
          );
          delete cycle.recoveryPhase;
          cycle.attempt++;
          await this.update(
            cycle,
            cycle.taskIds.length ? 'repairing' : 'needs_review',
          );
          return copy(cycle);
        }
        const operationId = `${cycle.id}:merge:${cycle.attempt}`;
        const merged = await this.operation(
          cycle,
          'merge tasks',
          operationId,
          cycle.taskIds,
          () =>
            ports.tasks.merge(copy(cycle), [...cycle.taskIds], { operationId }),
        );
        if (merged.status !== 'merged') {
          await this.update(
            cycle,
            'needs_review',
            `integration requires attention: ${merged.status}`,
          );
          return copy(cycle);
        }
        if (merged.workspace) cycle.workspace = merged.workspace;
        await this.update(cycle, 'verifying');
      }
      if (cycle.state === 'verifying') {
        const before = await ports.git.snapshot(copy(cycle));
        const verification = await ports.verify(copy(cycle));
        const after = await ports.git.snapshot(copy(cycle));
        const verified =
          verification.passed &&
          verification.head === after.head &&
          before.revision === after.revision &&
          cycle.acceptanceCriteria.every((criterion) =>
            verification.evidence.some(
              (item) =>
                item.criterion === criterion &&
                item.status === 'passed' &&
                item.detail.trim(),
            ),
          );
        if (!verified) {
          if (
            !verification.passed &&
            !after.dirty &&
            before.revision === after.revision &&
            verification.head === after.head &&
            verification.evidence.some(
              (item) => item.status === 'failed' && item.detail.trim(),
            )
          ) {
            await this.recover(
              cycle,
              verification.evidence
                .filter((item) => item.status === 'failed')
                .map((item) => `${item.criterion}: ${item.detail}`)
                .join('\n'),
              after.head,
              [{ name: 'local verification', bucket: 'fail' }],
            );
            return copy(cycle);
          }
          await this.update(
            cycle,
            'needs_review',
            'candidate lacks independent acceptance evidence for the current revision',
          );
          return copy(cycle);
        }
        if (
          after.branch === 'detached' ||
          /^(main|master)$/.test(after.branch)
        ) {
          await this.update(
            cycle,
            'needs_review',
            'delivery requires a feature branch',
          );
          return copy(cycle);
        }
        let head = after.head;
        if (after.dirty) {
          if (!verification.paths.length) {
            await this.update(
              cycle,
              'needs_review',
              'dirty candidate has no explicit verified paths',
            );
            return copy(cycle);
          }
          const operationId = `${cycle.id}:commit:${cycle.attempt}`;
          const committed = await this.operation(
            cycle,
            'commit',
            operationId,
            { revision: after.revision, paths: verification.paths },
            () =>
              ports.git.commit(
                copy(cycle),
                {
                  revision: after.revision,
                  paths: verification.paths,
                  message: cycle.title,
                },
                { operationId },
              ),
          );
          head = committed.head;
        }
        const committed = await ports.git.snapshot(copy(cycle));
        if (committed.dirty || committed.head !== head) {
          await this.update(
            cycle,
            'needs_review',
            'repository changed after verification or commit',
          );
          return copy(cycle);
        }
        await this.update(cycle, 'publishing');
        // Persist the accepted revision so a restart cannot publish an unverified edit.
        cycle.publishedHead = head;
        await this.save();
      }
      if (cycle.state === 'publishing') {
        const state = await ports.git.snapshot(copy(cycle));
        if (state.dirty || state.head !== cycle.publishedHead) {
          await this.update(
            cycle,
            'needs_review',
            'repository changed before publication',
          );
          return copy(cycle);
        }
        const pushId = `${cycle.id}:push:${cycle.attempt}`;
        await this.operation(
          cycle,
          'push',
          pushId,
          { head: state.head, revision: state.revision },
          () =>
            ports.git.push(
              copy(cycle),
              { revision: state.revision, head: state.head },
              { operationId: pushId },
            ),
        );
        const publishId = `${cycle.id}:publish:${cycle.attempt}`;
        cycle.pr = await this.operation(
          cycle,
          'publish draft PR',
          publishId,
          { head: state.head, revision: state.revision },
          () =>
            ports.delivery.publish(
              copy(cycle),
              { revision: state.revision, head: state.head },
              { operationId: publishId },
            ),
        );
        if (cycle.pr.head !== state.head) {
          await this.update(
            cycle,
            'needs_review',
            'published PR does not reference the accepted head',
          );
          return copy(cycle);
        }
        await this.update(cycle, 'waiting_ci');
      }
      if (cycle.state === 'waiting_ci') {
        const timestamp = this.options.clock?.() ?? Date.now();
        if (cycle.ciQueryRetry && timestamp < cycle.ciQueryRetry.notBefore)
          return copy(cycle);
        // Read failures may be retried. Mutations below still use the durable
        // operation journal and must never be classified as safe to replay.
        const query = async <T>(read: () => Promise<T>): Promise<T> => {
          try {
            return await read();
          } catch {
            const failures = (cycle.ciQueryRetry?.failures ?? 0) + 1;
            cycle.ciQueryRetry = {
              failures,
              notBefore:
                timestamp +
                Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)),
            };
            await this.update(
              cycle,
              'waiting_ci',
              'CI status or logs are temporarily unavailable; retrying after connection or authentication recovers',
            );
            throw new CiQueryUnavailable();
          }
        };
        const results = await query(() => ports.delivery.checks(copy(cycle)));
        const state = await query(() => ports.git.snapshot(copy(cycle)));
        if (
          results.head !== cycle.publishedHead ||
          state.head !== cycle.publishedHead ||
          state.dirty
        ) {
          await this.update(
            cycle,
            'needs_review',
            'CI or local head differs from the published candidate',
          );
          return copy(cycle);
        }
        const failures = results.checks
          .filter((item) => item.bucket === 'fail' || item.bucket === 'cancel')
          .sort((left, right) => left.name.localeCompare(right.name));
        if (failures.length) {
          const logs = (
            await query(() =>
              Promise.all(
                failures.map((item) =>
                  item.runId
                    ? ports.delivery.logs(copy(cycle), item.runId)
                    : Promise.resolve(`${item.name}: no log run available`),
                ),
              ),
            )
          ).join('\n');
          delete cycle.ciQueryRetry;
          const fingerprint = hash({
            checks: failures.map(({ name, bucket }) => ({ name, bucket })),
            logs: normalizeFailureLog(logs),
          });
          const count = countConsecutiveFailure(cycle, fingerprint);
          cycle.lastFailure = {
            fingerprint,
            logs,
            checks: failures,
            head: state.head,
          };
          const kind = count >= 3 ? 'diagnosis' : 'repair';
          const operationId = `${cycle.id}:${kind}:${cycle.attempt + 1}`;
          const prompt = `${kind === 'diagnosis' ? 'Independently diagnose the repeated failure and propose a revised plan. Do not repeat the same repair.' : 'Repair the failed CI checks and verify the original acceptance criteria.'}\n${logs}`;
          const ids = await this.operation(
            cycle,
            `create ${kind} tasks`,
            operationId,
            cycle.lastFailure,
            () =>
              ports.tasks.create(
                copy(cycle),
                { kind, prompt },
                { operationId },
              ),
          );
          cycle.taskIds = ids;
          cycle.attempt++;
          if (kind === 'diagnosis') cycle.recoveryPhase = 'diagnosis';
          await this.update(cycle, !ids.length ? 'needs_review' : 'repairing');
          return copy(cycle);
        }
        if (
          !results.checks.some((item) => item.bucket === 'pass') ||
          results.checks.some(
            (item) => item.bucket !== 'pass' && item.bucket !== 'skipping',
          )
        ) {
          if (cycle.ciQueryRetry) {
            delete cycle.ciQueryRetry;
            await this.update(cycle, 'waiting_ci');
          }
          return copy(cycle);
        }
        delete cycle.ciQueryRetry;
        const operationId = `${cycle.id}:ready:${cycle.attempt}`;
        await this.operation(
          cycle,
          'request review',
          operationId,
          { head: state.head, revision: state.revision },
          () =>
            ports.delivery.ready(
              copy(cycle),
              { revision: state.revision, head: state.head },
              { operationId },
            ),
        );
        await this.update(
          cycle,
          'pending_human_merge',
          'all acceptance and CI checks passed; merge remains a human decision',
        );
      }
    } catch (error) {
      if (error instanceof CiQueryUnavailable) return copy(cycle);
      if (cycle.state !== 'needs_review')
        await this.update(cycle, 'needs_review', String(error));
    }
    return copy(cycle);
  }
  private async retryOwned(
    id: string,
    runId: number,
    operation: { operationId: string },
  ): Promise<CycleRecord> {
    if (!Number.isSafeInteger(runId) || runId <= 0)
      throw Error('valid run id is required');
    const cycle = this.record(id);
    if (cycle.state !== 'waiting_ci')
      throw Error('CI retry requires a published candidate awaiting checks');
    await this.operation(
      cycle,
      'retry CI',
      operation.operationId,
      { runId, head: cycle.publishedHead },
      () => this.options.ports.delivery.retry(copy(cycle), runId, operation),
    );
    return copy(cycle);
  }
  async retryCI(
    id: string,
    runId: number,
    operation: { operationId: string },
  ): Promise<CycleRecord> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(() => this.retryOwned(id, runId, operation));
    this.queues.set(id, result);
    try {
      return await result;
    } finally {
      if (this.queues.get(id) === result) this.queues.delete(id);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await Promise.allSettled([...this.queues.values()]);
    await this.persistence;
    const lock = join(this.options.dataDir, 'delivery-cycles.lock');
    const owner = JSON.parse(await readFile(lock, 'utf8')) as { token: string };
    if (owner.token === this.lockToken) await unlink(lock);
    this.closed = true;
  }
}
