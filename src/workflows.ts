import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { EFFORT_LEVELS } from './effort.js';
import {
  ScriptWorker,
  WORKFLOW_NAME,
  type PreparedScript,
} from './workflow_script.js';

/** The most agents one run may start, a backstop against a loop that never ends. */
export const MAX_RUN_AGENTS = 1000;
/** How many times one agent may start: its first attempt and five more after it stalls. */
export const AGENT_ATTEMPTS = 6;
/** How long a stretch of script may run without waiting for an agent. */
export const SCRIPT_SLICE_MS = 5000;

/** A positive whole number from the environment, or undefined. */
function whole(value: string | undefined): number | undefined {
  const number = Number(value);
  return value?.trim() && Number.isInteger(number) && number > 0
    ? number
    : undefined;
}
/**
 * How many agents of one run work at once (`CIRCLE_WORKFLOW_MAX_CONCURRENT_AGENTS`, 1 to 256):
 * 16, or fewer on a machine with fewer processors.
 */
export function maxWorkflowAgents(
  env: NodeJS.ProcessEnv = process.env,
  processors = availableParallelism(),
): number {
  const set = whole(env.CIRCLE_WORKFLOW_MAX_CONCURRENT_AGENTS);
  if (set !== undefined && set <= 256) return set;
  return Math.min(16, Math.max(1, processors - 2));
}
/** How many tries an agent has to return output that fits its schema (`CIRCLE_MAX_STRUCTURED_OUTPUT_RETRIES`). */
export function structuredOutputAttempts(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return whole(env.CIRCLE_MAX_STRUCTURED_OUTPUT_RETRIES) ?? 5;
}
/** How long an agent's model may send nothing before the agent starts over (`CIRCLE_ASYNC_AGENT_STALL_TIMEOUT_MS`). */
export function agentStallMs(env: NodeJS.ProcessEnv = process.env): number {
  return whole(env.CIRCLE_ASYNC_AGENT_STALL_TIMEOUT_MS) ?? 600_000;
}

/** One `agent()` call as the runtime runs it. */
export interface AgentRequest {
  /** Its place in the order agents were started, from 0. */
  index: number;
  prompt: string;
  label: string;
  phase: string;
  schema?: Record<string, unknown>;
  model?: string;
  effort?: string;
  agentType?: string;
  /** Set for an `execute()` call: the command that runs in place of an agent, and the seconds it may take. */
  command?: string;
  timeout?: number;
}
/** What one attempt of an agent tells the run while it works. */
export interface AttemptHooks {
  signal: AbortSignal;
  attempt: number;
  /** Its model request started, sent output, or ended. Only the time in between counts toward a stall. */
  activity(kind: 'start' | 'output' | 'end'): void;
  /** The session its conversation is kept in. */
  session(id: string): void;
  /** The tokens of one model response. */
  tokens(input: number, output: number): void;
}
/** Runs one attempt of one agent. Its value is the agent's final text, or what it returned for its schema. */
export type AgentRunner = (
  request: AgentRequest,
  hooks: AttemptHooks,
) => Promise<unknown>;
/**
 * Runs one `execute()` call of a script to its end: the command's exit code (null when it was stopped at its
 * seconds) and what it printed. A command that was not allowed to run is an `AgentCallError`.
 */
export type CommandRunner = (
  request: AgentRequest,
  signal: AbortSignal,
) => Promise<{ code: number | null; output: string }>;
/** The seconds a script's command may take when it names none, and the most it may name. */
export const COMMAND_SECONDS = 120;
export const MAX_COMMAND_SECONDS = 600;
/** The most commands one run may start. */
export const MAX_RUN_COMMANDS = 10_000;
/** The call itself failed, and the script gets the error: its schema never fit, or it stalled every time. */
export class AgentCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCallError';
  }
}
/** Whether an attempt ended because the model's reply stream went silent and the model layer gave up on it. */
export function lostReply(error: unknown): boolean {
  for (
    let seen: unknown = error, depth = 0;
    seen && depth < 8;
    seen =
      (seen as { cause?: unknown; last?: unknown }).last ??
      (seen as { cause?: unknown }).cause,
      depth++
  )
    if ((seen as { name?: string }).name === 'StreamStalled') return true;
  return false;
}
/** Calls `fire` after `ms` unless cancelled; the returned function cancels. Tests give their own. */
export type StallTimer = (ms: number, fire: () => void) => () => void;
export const realStallTimer: StallTimer = (ms, fire) => {
  const timer = setTimeout(fire, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

const ajv = new Ajv({ strict: false, allErrors: true });
/**
 * Why a schema cannot be met, when that can be shown from the schema alone: it is not an object
 * schema, it does not compile, or a part of it contradicts itself (a required key that
 * `additionalProperties: false` rules out, a minimum above its maximum, an empty enum).
 */
export function schemaContradiction(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return 'schema must be a JSON Schema object';
  const root = schema as Record<string, unknown>;
  if (root.type !== 'object')
    return "schema needs type: 'object' at its root, with properties";
  try {
    // Compiled to be checked, then forgotten: a schema per call would otherwise stay in the cache
    ajv.compile(root);
    ajv.removeSchema(root);
  } catch (error) {
    ajv.removeSchema(root);
    return `schema is not valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`;
  }
  const check = (node: unknown, path: string): string | undefined => {
    if (!node || typeof node !== 'object' || Array.isArray(node))
      return undefined;
    const part = node as Record<string, unknown>;
    const properties =
      part.properties && typeof part.properties === 'object'
        ? (part.properties as Record<string, unknown>)
        : {};
    if (part.additionalProperties === false && Array.isArray(part.required))
      for (const key of part.required)
        if (typeof key === 'string' && !Object.hasOwn(properties, key))
          return `${path}: '${key}' is required, and additionalProperties: false rules it out`;
    for (const [low, high] of [
      ['minimum', 'maximum'],
      ['minLength', 'maxLength'],
      ['minItems', 'maxItems'],
      ['minProperties', 'maxProperties'],
    ] as const)
      if (
        typeof part[low] === 'number' &&
        typeof part[high] === 'number' &&
        (part[low] as number) > (part[high] as number)
      )
        return `${path}: ${low} ${part[low]} is above ${high} ${part[high]}`;
    if (Array.isArray(part.enum) && !part.enum.length)
      return `${path}: an empty enum allows no value`;
    for (const [key, value] of Object.entries(properties)) {
      const found = check(value, `${path}.${key}`);
      if (found) return found;
    }
    if (part.items) return check(part.items, `${path}[]`);
    return undefined;
  };
  return check(root, 'schema');
}

/** One agent of a run, as /workflows shows it. */
export interface WorkflowAgentView {
  index: number;
  label: string;
  phase: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cached' | 'stopped';
  /** The attempt running or last run, from 1. */
  attempt: number;
  /** How each earlier attempt ended: `stalled`, `lost its reply`. */
  endings: string[];
  /** The session of its conversation, the last attempt's. */
  session?: string;
  tokens: number;
  started?: number;
  ended?: number;
  error?: string;
  /** The start of what it returned. */
  result?: string;
  /** An `execute()` call: a command of the script's own, not an agent. */
  command?: true;
}
/** One run, as /workflows shows it. */
export interface WorkflowRunView {
  id: string;
  sessionId: string;
  name: string;
  description: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  phases: { title: string; detail?: string }[];
  agents: WorkflowAgentView[];
  logs: string[];
  started: number;
  ended?: number;
  /** Where its script is, as the model and the person name it. */
  script: string;
  job?: string;
  resumedFrom?: string;
  error?: string;
}
/** One line of a run's journal: an agent started, or its call ended. */
export type JournalEvent =
  | { t: 'start'; i: number; key: string; label: string }
  | {
      t: 'end';
      i: number;
      status: 'done' | 'failed';
      result?: unknown;
      error?: string;
    };
/** The journal a run kept, line by line; a line cut short at the end is left out. */
export function readJournal(path: string): JournalEvent[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const events: JournalEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as JournalEvent;
      if (
        (event.t === 'start' || event.t === 'end') &&
        Number.isInteger(event.i)
      )
        events.push(event);
    } catch {
      /* A line the run was writing when it stopped. */
    }
  }
  return events;
}
/** A run as its folder keeps it: written when it starts and when it ends. */
export interface RunRecord extends WorkflowRunView {
  args?: unknown;
  scriptFile: string;
}
export function readRunRecord(folder: string): RunRecord | undefined {
  try {
    const record = JSON.parse(
      readFileSync(join(folder, 'run.json'), 'utf8'),
    ) as RunRecord;
    return typeof record.id === 'string' && typeof record.sessionId === 'string'
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}
/** The runs one conversation kept in a project's runs folder, newest first. */
export function savedRuns(root: string, sessionId: string): RunRecord[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const record = readRunRecord(join(root, name));
      return record?.sessionId === sessionId ? [record] : [];
    })
    .sort((a, b) => b.started - a.started);
}

const firstLine = (text: string, width = 80): string => {
  const line = text.split('\n').find((part) => part.trim()) ?? '';
  const plain = line.replace(/\s+/g, ' ').trim();
  return plain.length > width ? plain.slice(0, width - 1) + '…' : plain;
};
const asText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
/** The start of what an agent returned, on one line. */
const preview = (value: unknown): string =>
  firstLine(
    typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null'),
  );

/** A fixed number of places: an agent waits for one, in the order it was started. */
class Slots {
  private queue: { go: () => void; signal: AbortSignal; drop: () => void }[] =
    [];
  constructor(private free: number) {}
  take(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        go: () => {
          signal.removeEventListener('abort', entry.drop);
          resolve();
        },
        drop: () => {
          this.queue = this.queue.filter((item) => item !== entry);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', entry.drop, { once: true });
      this.queue.push(entry);
    });
  }
  give(): void {
    const next = this.queue.shift();
    if (next) next.go();
    else this.free++;
  }
}

interface Call {
  index: number;
  key: string;
  request: AgentRequest;
  stallMs: number;
  resolve: (json?: string) => void;
  reject: (message: string) => void;
  view: WorkflowAgentView;
  /** Ends its wait for a place and every attempt: a stop of this agent, or of the run. */
  abort: AbortController;
  stopped?: boolean;
  settled?: boolean;
  /** Set by a relaunch: the result the earlier run saved, handed over at its place in the order. */
  cached?: { result?: unknown };
  live?: Promise<void>;
}
interface Pending {
  message: string;
  reject: (message: string) => void;
}
export interface WorkflowRunOptions {
  id: string;
  sessionId: string;
  prepared: PreparedScript;
  args?: unknown;
  /** The run's own folder: its journal, record, script and result. */
  folder: string;
  /** Its script as the model and the person name it. */
  script: string;
  scriptFile: string;
  runner: AgentRunner;
  /** Runs a script's `execute()` calls; without it a script has none. */
  commandRunner?: CommandRunner;
  /** Checks an agent type before the agent starts: why it cannot be used, or nothing. */
  checkAgentType?: (name: string) => string | undefined;
  /** The run this one relaunches: its journal is replayed. */
  previous?: {
    id: string;
    events: JournalEvent[];
    agents: WorkflowAgentView[];
  };
  maxConcurrent?: number;
  stallMs?: number;
  timer?: StallTimer;
  sliceMs?: number;
  /** The view changed. */
  changed?: (view: WorkflowRunView) => void;
  /** A line for the run's log: an agent's start or end, a log() message, a phase. */
  progress?: (line: string) => void;
}

/**
 * One run of a workflow script. The script runs in its own context; each `agent()` it calls
 * runs as a subagent through `runner`, at most `maxConcurrent` at once. An agent whose model
 * sends nothing for `stallMs` starts over, five times at most. Each start and end goes to the
 * run's journal, and a relaunch replays an earlier run's journal: in the order things happened
 * then, every agent called as before returns its saved result, until the first that differs,
 * failed, or was not called; that one and every one after it runs again. One still running
 * when the earlier run stopped starts over without changing the order.
 */
export class WorkflowRun {
  readonly view: WorkflowRunView;
  private readonly calls: Call[] = [];
  private issued: Call[] = [];
  private rejections: Pending[] = [];
  private outcome?: { json?: string } | { error: string };
  private script?: ScriptWorker;
  /** Results of agents run again during a replay, held until it ends so the order stays the earlier run's. */
  private held: (() => void)[] = [];
  private slots: Slots;
  private phase = '';
  private output = 0;
  /** How many of `calls` are commands. */
  private commands = 0;
  private closed = false;
  private ending?: Promise<void>;
  private finish?: (text: string | Error) => void;
  private replay?: {
    events: JournalEvent[];
    at: number;
    ends: Map<number, Extract<JournalEvent, { t: 'end' }>>;
    order: Map<number, number>;
    waiting: Map<number, Call>;
  };
  private journalBroken = false;
  constructor(private readonly options: WorkflowRunOptions) {
    const { meta } = options.prepared;
    this.view = {
      id: options.id,
      sessionId: options.sessionId,
      name: meta.name,
      description: meta.description,
      status: 'running',
      phases: meta.phases.map((phase) => ({
        title: phase.title,
        ...(phase.detail ? { detail: phase.detail } : {}),
      })),
      agents: [],
      logs: [],
      started: Date.now(),
      script: options.script,
      ...(options.previous ? { resumedFrom: options.previous.id } : {}),
    };
    this.slots = new Slots(options.maxConcurrent ?? maxWorkflowAgents());
    if (options.previous) {
      const ends = new Map<number, Extract<JournalEvent, { t: 'end' }>>();
      const order = new Map<number, number>();
      options.previous.events.forEach((event, at) => {
        if (event.t === 'end') {
          ends.set(event.i, event);
          order.set(event.i, at);
        }
      });
      this.replay = {
        events: options.previous.events,
        at: 0,
        ends,
        order,
        waiting: new Map(),
      };
    }
  }
  get journal(): string {
    return join(this.options.folder, 'journal.jsonl');
  }
  /** Runs the script to its end: the result as text, or the reason it failed. Aborting `signal` stops it. */
  run(signal: AbortSignal): Promise<string> {
    mkdirSync(this.options.folder, { recursive: true });
    writeFileSync(this.journal, '');
    this.save();
    return new Promise<string>((resolve, reject) => {
      this.finish = (value) =>
        typeof value === 'string' ? resolve(value) : reject(value);
      const stop = (): void => {
        void this.end({ error: 'stopped' }, 'stopped');
      };
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener('abort', stop, { once: true });
      const script = new ScriptWorker(
        this.options.prepared,
        {
          agent: (id, spec) =>
            this.called(
              spec,
              (json) =>
                script.settle(id, { json: json ?? 'null' }, this.output),
              (message) => script.settle(id, { error: message }, this.output),
            ),
          phase: (title) => this.enterPhase(title),
          log: (message) => this.log(message),
          done: (json) => {
            this.outcome ??= { json };
            this.schedule();
          },
          failed: (message) => {
            this.outcome ??= { error: message };
            this.schedule();
          },
          idle: () => this.schedule(),
        },
        {
          args: this.options.args,
          sliceMs: this.options.sliceMs ?? SCRIPT_SLICE_MS,
        },
      );
      this.script = script;
      script.start();
    });
  }
  /** Stops one agent: its call gives the script null, and a relaunch runs it again. */
  stopAgent(index: number): boolean {
    const call = this.calls[index];
    if (!call || call.settled || this.closed) return false;
    call.stopped = true;
    call.abort.abort(new Error('stopped'));
    return true;
  }
  private changed(): void {
    this.options.changed?.(this.view);
  }
  private progress(line: string): void {
    this.options.progress?.(line);
  }
  private enterPhase(title: string): void {
    this.phase = title.trim();
    this.notePhase(this.phase);
    if (this.phase) this.progress(`phase ${this.phase}`);
    this.changed();
  }
  private notePhase(title: string): void {
    if (title && !this.view.phases.some((phase) => phase.title === title))
      this.view.phases.push({ title });
  }
  private log(message: string): void {
    this.view.logs.push(message);
    if (this.view.logs.length > 200) this.view.logs.shift();
    this.progress(message);
    this.changed();
  }
  private record(event: JournalEvent): void {
    try {
      appendFileSync(this.journal, JSON.stringify(event) + '\n');
    } catch (error) {
      if (!this.journalBroken)
        this.log(
          `the journal could not be written, so this run cannot be relaunched from it: ${error instanceof Error ? error.message : String(error)}`,
        );
      this.journalBroken = true;
    }
  }
  /** What the run keeps in its folder, for /workflows after Circle restarts and for a relaunch. */
  private save(): void {
    const record: RunRecord = {
      ...this.view,
      scriptFile: this.options.scriptFile,
      ...(this.options.args !== undefined ? { args: this.options.args } : {}),
    };
    try {
      writeFileSync(
        join(this.options.folder, 'run.json'),
        JSON.stringify(record, null, 2) + '\n',
      );
    } catch {
      /* The run goes on; only its record is missing. */
    }
  }
  /** An `agent()` call, while the script runs: queued here, started once the script waits. */
  private called(
    spec: string,
    resolve: (json?: string) => void,
    reject: (message: string) => void,
  ): void {
    if (this.closed || this.outcome) return;
    let parsed: {
      prompt: string;
      command?: unknown;
      options: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(spec);
    } catch {
      this.rejections.push({ message: 'agent() could not be read', reject });
      return;
    }
    const options = parsed.options ?? {};
    const refuse = (message: string): void => {
      this.rejections.push({ message, reject });
    };
    const text = (key: string): string | undefined =>
      typeof options[key] === 'string' && (options[key] as string).trim()
        ? (options[key] as string).trim()
        : undefined;
    if (parsed.command !== undefined)
      return this.calledCommand(parsed.command, options, text, refuse, {
        resolve,
        reject,
      });
    for (const key of [
      'label',
      'phase',
      'model',
      'effort',
      'agentType',
      'isolation',
    ])
      if (options[key] !== undefined && typeof options[key] !== 'string')
        return refuse(`agent() option ${key} must be a string`);
    if (
      options.stallMs !== undefined &&
      !(
        typeof options.stallMs === 'number' &&
        Number.isFinite(options.stallMs) &&
        options.stallMs > 0
      )
    )
      return refuse('agent() option stallMs must be a number of milliseconds');
    const effort = text('effort');
    if (effort && !(EFFORT_LEVELS as readonly string[]).includes(effort))
      return refuse(
        `agent() option effort must be one of ${EFFORT_LEVELS.join(', ')}`,
      );
    if (text('isolation'))
      return refuse(
        `agent() option isolation: '${text('isolation')}' is not supported in Circle yet; agents work in the workspace`,
      );
    const schema = options.schema as Record<string, unknown> | undefined;
    if (schema !== undefined) {
      const why = schemaContradiction(schema);
      if (why) return refuse(why);
    }
    const agentType = text('agentType');
    if (agentType) {
      const why = this.options.checkAgentType?.(agentType);
      if (why) return refuse(why);
    }
    if (this.calls.length - this.commands >= MAX_RUN_AGENTS)
      return refuse(
        `this run has started ${MAX_RUN_AGENTS} agents, the most one run may start`,
      );
    const index = this.calls.length;
    const phase = text('phase') ?? this.phase;
    this.notePhase(phase);
    const label = text('label') ?? firstLine(parsed.prompt, 60);
    const request: AgentRequest = {
      index,
      prompt: parsed.prompt,
      label,
      phase,
      ...(schema ? { schema } : {}),
      ...(text('model') ? { model: text('model') } : {}),
      ...(text('effort') ? { effort: text('effort') } : {}),
      ...(agentType ? { agentType } : {}),
    };
    // What decides whether a relaunch may hand back the saved result: what the agent is asked and how
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          request.prompt,
          request.schema ?? null,
          request.model ?? null,
          request.effort ?? null,
          request.agentType ?? null,
        ]),
      )
      .digest('hex');
    const view: WorkflowAgentView = {
      index,
      label,
      phase,
      state: 'queued',
      attempt: 0,
      endings: [],
      tokens: 0,
    };
    this.view.agents.push(view);
    const call: Call = {
      index,
      key,
      request,
      stallMs: (options.stallMs as number | undefined) ?? this.stallMs(),
      resolve,
      reject,
      view,
      abort: new AbortController(),
    };
    this.calls.push(call);
    this.issued.push(call);
  }
  /** An `execute()` call, while the script runs: queued and journalled as an agent's call is. */
  private calledCommand(
    command: unknown,
    options: Record<string, unknown>,
    text: (key: string) => string | undefined,
    refuse: (message: string) => void,
    ends: {
      resolve: (json?: string) => void;
      reject: (message: string) => void;
    },
  ): void {
    if (typeof command !== 'string' || !command.trim())
      return refuse(
        'execute() takes the command as its first argument, a string',
      );
    for (const key of ['label', 'phase'])
      if (options[key] !== undefined && typeof options[key] !== 'string')
        return refuse(`execute() option ${key} must be a string`);
    const timeout = options.timeout;
    if (
      timeout !== undefined &&
      !(
        typeof timeout === 'number' &&
        Number.isInteger(timeout) &&
        timeout >= 1 &&
        timeout <= MAX_COMMAND_SECONDS
      )
    )
      return refuse(
        `execute() option timeout must be a whole number of seconds from 1 to ${MAX_COMMAND_SECONDS}`,
      );
    if (!this.options.commandRunner)
      return refuse('execute() is not available in this run');
    if (this.commands >= MAX_RUN_COMMANDS)
      return refuse(
        `this run has started ${MAX_RUN_COMMANDS} commands, the most one run may start`,
      );
    const index = this.calls.length;
    const phase = text('phase') ?? this.phase;
    this.notePhase(phase);
    const label = text('label') ?? `$ ${firstLine(command, 58)}`;
    const request: AgentRequest = {
      index,
      prompt: '',
      label,
      phase,
      command,
      timeout: (timeout as number | undefined) ?? COMMAND_SECONDS,
    };
    // What decides whether a relaunch may hand back the saved result: the command and its seconds
    const key = createHash('sha256')
      .update(JSON.stringify(['command', command, request.timeout]))
      .digest('hex');
    const view: WorkflowAgentView = {
      index,
      label,
      phase,
      state: 'queued',
      attempt: 0,
      endings: [],
      tokens: 0,
      command: true,
    };
    this.view.agents.push(view);
    const call: Call = {
      index,
      key,
      request,
      stallMs: this.stallMs(),
      resolve: ends.resolve,
      reject: ends.reject,
      view,
      abort: new AbortController(),
    };
    this.commands++;
    this.calls.push(call);
    this.issued.push(call);
  }
  private stallMs(): number {
    return this.options.stallMs ?? agentStallMs();
  }
  /** Hands something to the script, which runs until it waits again; `schedule` goes on once it does. */
  private deliver<T>(target: (value: T) => void, value: T): void {
    if (!this.closed) target(value);
  }
  /**
   * Whenever the script waits: refusals go back, a relaunch replays what it can, and every other call starts.
   * Anything handed to the script is followed by a wait for it to wait again, so each step of a replay sees
   * the calls the step before it led to, in the order the script made them.
   */
  private schedule(): void {
    for (;;) {
      if (this.closed) return;
      if (this.outcome) {
        void this.end(this.outcome);
        return;
      }
      if (this.script?.running) return;
      const refused = this.rejections.shift();
      if (refused) {
        this.deliver(refused.reject, refused.message);
        continue;
      }
      if (this.replay && this.replayStep()) continue;
      const held = this.held.shift();
      if (held) {
        held();
        continue;
      }
      const call = this.issued.shift();
      if (!call) return;
      this.record({
        t: 'start',
        i: call.index,
        key: call.key,
        label: call.request.label,
      });
      this.startLive(call);
    }
  }
  /** One step of a relaunch's replay; false once it has ended. */
  private replayStep(): boolean {
    const replay = this.replay!;
    const event = replay.events[replay.at];
    if (!event) return this.endReplay();
    if (event.t === 'start') {
      const call = this.issued[0];
      // The script is not where the earlier run was: from here on everything runs
      if (!call || call.index !== event.i || call.key !== event.key)
        return this.endReplay();
      this.issued.shift();
      replay.at++;
      this.record({
        t: 'start',
        i: call.index,
        key: call.key,
        label: call.request.label,
      });
      const before = replay.ends.get(event.i);
      if (before?.status === 'done') {
        call.cached = { result: before.result };
        const earlier = this.options.previous?.agents[call.index];
        if (earlier?.session) call.view.session = earlier.session;
        replay.waiting.set(call.index, call);
        return true;
      }
      this.startLive(call);
      // A failed agent runs again, and so does every agent started after it
      if (before?.status === 'failed') return this.endReplay();
      return true;
    }
    replay.at++;
    const call = replay.waiting.get(event.i);
    if (call) {
      replay.waiting.delete(event.i);
      this.handBack(call);
    }
    return true;
  }
  /** The replay ends: saved results not handed back yet go back now, in the order they came then. */
  private endReplay(): false {
    const replay = this.replay!;
    this.replay = undefined;
    const waiting = [...replay.waiting.values()].sort(
      (a, b) =>
        (replay.order.get(a.index) ?? 0) - (replay.order.get(b.index) ?? 0),
    );
    for (const call of waiting) {
      if (this.closed || this.outcome) break;
      this.handBack(call);
    }
    return false;
  }
  /** A saved result goes back to the script as the earlier run's agent returned it. */
  private handBack(call: Call): void {
    const result = call.cached?.result;
    call.settled = true;
    call.view.state = 'cached';
    call.view.result = preview(result ?? null);
    this.record({ t: 'end', i: call.index, status: 'done', result });
    this.progress(`${call.view.label}: saved result`);
    this.changed();
    this.deliver(call.resolve, JSON.stringify(result ?? null));
  }
  private startLive(call: Call): void {
    this.changed();
    call.live = this.runLive(call);
  }
  private async runLive(call: Call): Promise<void> {
    let placed = false;
    let outcome:
      { value: unknown } | { nothing: string } | { error: string } | undefined;
    try {
      // A command takes no agent's place: a script that runs one between its agents does not wait for them
      if (call.request.command === undefined) {
        await this.slots.take(call.abort.signal);
        placed = true;
      }
      call.view.state = 'running';
      call.view.started = Date.now();
      this.progress(`${call.view.label}: started`);
      this.changed();
      outcome = { value: await this.attempts(call) };
    } catch (error) {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      outcome = call.stopped
        ? { nothing: 'stopped' }
        : error instanceof AgentCallError
          ? { error: message }
          : // An error that ended the agent, such as its model failing after its retries: its result is null
            { nothing: message };
    } finally {
      if (placed) this.slots.give();
    }
    if (this.closed) return;
    const done = outcome;
    // While a relaunch replays, a result of an agent run again waits, so the earlier order holds
    if (this.replay) {
      this.held.push(() => this.settleLive(call, done));
      return;
    }
    this.settleLive(call, done);
    this.schedule();
  }
  /** A live agent's call ends: the journal, the view and the script hear of it. */
  private settleLive(
    call: Call,
    outcome: { value: unknown } | { nothing: string } | { error: string },
  ): void {
    call.settled = true;
    call.view.ended = Date.now();
    if ('value' in outcome) {
      call.view.state = 'done';
      call.view.result = preview(outcome.value);
      this.record({
        t: 'end',
        i: call.index,
        status: 'done',
        result: outcome.value,
      });
      this.progress(`${call.view.label}: done`);
      this.changed();
      this.deliver(call.resolve, JSON.stringify(outcome.value ?? null));
    } else if ('nothing' in outcome) {
      call.view.state = call.stopped ? 'stopped' : 'failed';
      call.view.error = outcome.nothing;
      this.record({
        t: 'end',
        i: call.index,
        status: 'failed',
        result: null,
        error: outcome.nothing,
      });
      this.progress(`${call.view.label}: ${outcome.nothing}`);
      this.changed();
      this.deliver(call.resolve, 'null');
    } else {
      call.view.state = 'failed';
      call.view.error = outcome.error;
      this.record({
        t: 'end',
        i: call.index,
        status: 'failed',
        error: outcome.error,
      });
      this.progress(`${call.view.label}: ${outcome.error}`);
      this.changed();
      this.deliver(call.reject, outcome.error);
    }
  }
  /** One agent's attempts: a stalled one starts over without its transcript, five times at most. */
  private async attempts(call: Call): Promise<unknown> {
    if (call.request.command !== undefined) {
      call.view.attempt = 1;
      this.changed();
      try {
        return await this.options.commandRunner!(
          call.request,
          call.abort.signal,
        );
      } catch (error) {
        // A command that did not run is the script's to hear of: it gets the error, never null for a result
        if (this.closed || call.stopped || error instanceof AgentCallError)
          throw error;
        throw new AgentCallError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const endings: string[] = [];
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const signal = AbortSignal.any([call.abort.signal, controller.signal]);
      let stalled = false;
      let modelRunning = false;
      let cancel: (() => void) | undefined;
      const timer = this.options.timer ?? realStallTimer;
      const disarm = (): void => {
        cancel?.();
        cancel = undefined;
      };
      const arm = (): void => {
        disarm();
        cancel = timer(call.stallMs, () => {
          stalled = true;
          controller.abort(new Error('stalled'));
        });
      };
      call.view.attempt = attempt;
      this.changed();
      try {
        return await this.options.runner(call.request, {
          signal,
          attempt,
          activity: (kind) => {
            if (signal.aborted) return;
            if (kind === 'start') {
              modelRunning = true;
              arm();
            } else if (kind === 'output') {
              if (modelRunning) arm();
            } else {
              modelRunning = false;
              disarm();
            }
          },
          session: (id) => {
            call.view.session = id;
            this.changed();
          },
          tokens: (input, output) => {
            call.view.tokens += input + output;
            this.output += output;
            this.changed();
          },
        });
      } catch (error) {
        if (this.closed || call.stopped) throw error;
        const ending = stalled
          ? 'stalled'
          : lostReply(error)
            ? 'lost its reply'
            : undefined;
        if (!ending) throw error;
        endings.push(ending);
        call.view.endings = [...endings];
        if (attempt >= AGENT_ATTEMPTS) {
          const kinds = new Set(endings);
          throw new AgentCallError(
            kinds.size > 1
              ? `agent abandoned after ${AGENT_ATTEMPTS} attempts: ${endings.join(', ')}`
              : ending === 'stalled'
                ? `agent stalled on all ${AGENT_ATTEMPTS} attempts`
                : `agent lost its reply on all ${AGENT_ATTEMPTS} attempts`,
          );
        }
        this.progress(
          `${call.view.label}: attempt ${attempt} ${ending}, starting it again`,
        );
      } finally {
        disarm();
      }
    }
  }
  /** The script ended, or the run was stopped: agents still going stop, and the run settles. */
  private end(
    outcome: { json?: string } | { error: string },
    status?: WorkflowRunView['status'],
  ): Promise<void> {
    if (this.ending) return this.ending;
    this.ending = (async () => {
      this.closed = true;
      this.script?.end();
      const going = this.calls.filter((call) => !call.settled);
      for (const call of going) call.abort.abort(new Error('run ended'));
      if (going.length && !status)
        this.progress(
          `${going.length} ${going.length === 1 ? 'agent' : 'agents'} the script did not wait for ${going.length === 1 ? 'was' : 'were'} stopped`,
        );
      await Promise.allSettled(going.map((call) => call.live));
      for (const call of going) {
        call.view.state = 'stopped';
        call.view.ended ??= Date.now();
      }
      this.view.ended = Date.now();
      let result: string | Error;
      if ('error' in outcome) {
        this.view.status = status ?? 'failed';
        // A stopped run says so in its state; a failed one says why
        if (!status) this.view.error = outcome.error;
        result = new Error(outcome.error);
      } else {
        this.view.status = 'done';
        const value =
          outcome.json === undefined ? undefined : JSON.parse(outcome.json);
        result =
          value === undefined
            ? '(the workflow returned nothing)'
            : asText(value) || '(the workflow returned an empty text)';
        try {
          writeFileSync(join(this.options.folder, 'result.txt'), result);
        } catch {
          /* The notice carries the result itself. */
        }
      }
      this.save();
      this.changed();
      this.finish?.(result);
    })();
    return this.ending;
  }
}

/** One line for the strip and the run list: the phase it is in and how its agents stand. */
export function workflowSummary(view: WorkflowRunView): string {
  const count = (...states: WorkflowAgentView['state'][]): number =>
    view.agents.filter(
      (agent) => !agent.command && states.includes(agent.state),
    ).length;
  const running = count('running');
  const waiting = count('queued');
  const done = count('done', 'cached');
  const failed = count('failed', 'stopped');
  const phase =
    view.agents.findLast(
      (agent) => agent.state === 'running' || agent.state === 'queued',
    )?.phase ??
    view.agents.at(-1)?.phase ??
    '';
  return (
    [
      phase,
      running ? `${running} running` : '',
      waiting ? `${waiting} waiting` : '',
      done ? `${done} done` : '',
      failed ? `${failed} failed` : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'starting'
  );
}
/** A run's id: `w` and eight hexadecimal digits, the folder its files are kept in. */
export const RUN_ID = /^w[0-9a-f]{8}$/;
/** Whether a name is one a workflow can have. */
export const workflowName = (name: string): boolean =>
  WORKFLOW_NAME.test(name) ||
  /^[A-Za-z0-9._-]+:[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);
/** Whether a run folder exists for an id. */
export const runExists = (root: string, id: string): boolean =>
  RUN_ID.test(id) && existsSync(join(root, id, 'run.json'));
