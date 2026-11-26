import { safeKnowledgeCall } from './knowledge/tools.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { orderModeToolResults } from './tool_history.js';
import type {
  ChatModel,
  Message,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolCall,
  Usage,
  MediaAttachment,
  CommandResult,
  ToolContext,
  ToolModelCall,
} from './types.js';
import { emptyUsage, addUsage, UNSIGNED_GEMINI_CALL } from './types.js';
import { EventBus } from './events.js';
import { ApprovalPolicy, wildcard, type ApprovalMode } from './approvals.js';
import { CheckpointStore, type Session } from './checkpoint_store.js';
import { attachPrompt } from './mentions.js';
import { prepareToolCall, RecoverableToolError } from './tool_call_compat.js';
import { CommandFailure } from './jobs.js';
import { redact } from './redact.js';
import type { CallIdentity } from './sandbox.js';
import { isRecord } from './settings.js';
import {
  expandVariables,
  redactSecrets,
  secretRedactor,
  written,
  type Redactor,
} from './secrets.js';
import { httpStatus } from './model_guard.js';
import { isNetworkFailure } from './net.js';
import {
  occupiedSessionMessage,
  SessionOccupiedError,
} from './session_lock.js';
import { validateAttachments } from './media.js';
import { readPrompt } from './system_prompt.js';
import {
  acceptGeneratedTitle,
  fallbackTitle,
  friendlyTitleFailure,
  TITLE_MAX_TOKENS,
  titleConversation,
  titleRetrySystem,
  titleSkipReason,
} from './session_title.js';
import { tokenLen } from './middleware/tool_result_prune.js';
import {
  commandExecutionReceipt,
  type CommandExecution,
} from './command_process.js';
import {
  completionFailure,
  isContextLimitError,
  ModelCompletionFailure,
} from './model_completion.js';
import { BudgetExceeded, requestBudget } from './request_budget.js';
import {
  activeHookSummary,
  canonicalJson,
  hookDeniedMessage,
  hookFileLabel,
  hookNoticeText,
  hookPermissionMode,
  hookToolPaths,
  redactHookValue,
  stopHookCap,
  HOOK_ASKED_LINE,
  HOOK_CHANGED_LINE,
  HOOK_OUTPUT_LINE,
  type HookBatch,
  type HookDefinition,
  type HookEvent,
  type HookNotice,
  type HookRunner,
} from './hooks.js';
import type {
  InputPayload,
  StoredInput,
  ResolveInputsRequest,
  ResolveInputsResult,
} from './input_outbox.js';
import type { SkillScopes } from './skill_tools.js';
type InputPresentation = Omit<InputPayload, 'text'>;
const inputPresentation = ({
  text: _text,
  ...presentation
}: InputPayload): InputPresentation => presentation;
class InputPresentations extends Map<string, InputPresentation> {
  constructor(
    private readonly save: (
      text: string,
      presentation: InputPresentation,
    ) => void,
  ) {
    super();
  }
  override set(text: string, presentation: InputPresentation): this {
    this.save(text, presentation);
    return super.set(text, presentation);
  }
}
/** Whether a title request failed because its own clock ran out. */
function titleTimedOut(error: unknown): boolean {
  for (let value = error; value instanceof Error;) {
    if (/(?:Timeout|Abort)Error/.test(value.name)) return true;
    if (/timed out|timeout/i.test(value.message)) return true;
    value = value.cause instanceof Error ? value.cause : undefined;
  }
  return false;
}

function titleTrace(message: string): void {
  if (!process.env.CIRCLE_DEBUG) return;
  console.error(`[circle] title: ${message}`);
}
export type ApprovalDecision =
  | 'approve'
  | 'reject'
  | 'always'
  | 'prefix'
  // a rejection with the user's reason, which the model reads in the tool result
  | { decision: 'reject'; message: string };
export interface HarnessOptions {
  /**
   * Set in a subagent (#550, #551): the conversation's session and this agent's type. Hooks, MCP servers and
   * child processes are told the conversation's session, with this harness's own as the agent's.
   */
  agent?: { sessionId: string; type: string };
  /**
   * A subagent's own thinking depth, sent with each of its requests in place of the model's. Unset, the model's
   * depth applies, as for the conversation.
   */
  effort?: string;
  /** A subagent's hooks from its definition: they run for its own calls and its stop, beside the configured ones. */
  agentHooks?: HookDefinition[];
  /** A subagent's approval mode, read for each call. Unset, the session's mode decides. */
  approvalMode?: () => ApprovalMode;
  /** True while a call that would ask is refused instead (a subagent's `dontAsk`). */
  dontAsk?: () => boolean;
  /**
   * A subagent's limit on model requests over its life. Once they are spent, a run ends with what it has, and
   * `stoppedAtTurnLimit` says so.
   */
  maxTurns?: number;
  /** Trusted host lookup, never model-supplied execution metadata or authority. */
  commandExecution?: {
    epoch: string;
    forCall: (
      sessionId: string,
      callId: string,
    ) => CommandExecution | undefined;
  };
  /** The variables, read for each call: %NAME% in arguments becomes the value. */
  variables?: () => Record<string, string>;
  /** The saved secrets, read for each call: variables whose values the model never sees. */
  secrets?: () => Record<string, string>;
  /**
   * Hides secrets' values in text the model reads, given the values a call used. One shared
   * with the runtime's background jobs knows every value a secret had.
   */
  redact?: Redactor;
  model: ChatModel;
  tools: Tool[];
  store: CheckpointStore;
  session: Session;
  policy: ApprovalPolicy;
  system: string;
  bus?: EventBus;
  approve?: (call: ToolCall, signal: AbortSignal) => Promise<ApprovalDecision>;
  maxSteps?: number;
  headless?: boolean;
  beforeRun?: (signal: AbortSignal) => Promise<void>;
  /** Called for each turn, including queued follow-ups, before consuming its message. */
  beforeTurn?: (prompt: string | undefined) => void;
  beforeStep?: () => void;
  priceUsage?: (
    model: string,
    usage: Usage,
  ) => import('./pricing.js').PriceReceipt;
  webSearch?: (
    model: ChatModel,
    query: string,
    numResults: number,
    context: ToolContext,
  ) => Promise<string>;
  /**
   * Describes image files with the run's configured side vision model, for tools whose
   * pictures the model in use cannot read; undefined when none is configured.
   */
  vision?: (
    paths: string[],
    question: string,
    context: ToolContext,
  ) => Promise<{ model: string; text: string }>;
  /** Writes a picture the model cannot read under the run's project data, returning its path. */
  saveImageAttachment?: (item: MediaAttachment) => string;
  toolBoundary?: (
    tool: Tool,
    args: Record<string, unknown>,
    context: import('./types.js').ToolContext,
  ) => Promise<string>;
  /** Optional trusted-host scheduling, after approval and before the prepared action runs. */
  executeTool?: (
    tool: Tool,
    args: Record<string, unknown>,
    context: ToolContext,
    run: () => Promise<string>,
  ) => Promise<string>;
  prepareMessages?: (signal: AbortSignal) => Promise<Message[]>;
  approvalSessionId?: string;
  parentPlanMode?: () => boolean;
  /** A call that writes only this conversation's plan file: plan mode lets it run, and
   * it never asks. */
  planFileMutation?: (call: ToolCall) => boolean;
  /** What plan mode tells the model, with the path of its plan file. Without it, a
   * read-only harness, such as a subagent's, may change nothing. */
  planPrompt?: () => string;
  /**
   * Leave a sentence untitled until its generated title arrives, instead of
   * saving the short title first. The desktop shows it as a new session.
   */
  holdTitle?: boolean;
  /** Read stored history without taking the lease or repairing it. */
  inspect?: boolean;
  /** The turn and its queued follow-ups have finished, whether or not they succeeded. */
  settled?: () => void;
  /**
   * Deterministic hooks for this session. Absent in tests that do not set
   * them. Subagents share the runner but do not start or stop the session.
   */
  hooks?: HookRunner;
  /**
   * A PNG of the page this session's browser shows, for an after_tool hook that asks for one; undefined when there is
   * no page. It must not start a browser.
   */
  hookScreenshot?: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<Buffer | undefined>;
  /** False for a subagent: tool hooks still run, session start and stop do not. */
  sessionHooks?: boolean;
  sessionSource?: 'startup' | 'resume' | 'clear';
  backgroundTasks?: () => Record<string, unknown>[];
  skills?: Pick<SkillScopes, 'message' | 'withheld' | 'allows'>;
}
/** A message that waits for the model, as the input box showed it. */
export interface QueuedMessage {
  message: string;
  display: string;
  pastes?: Record<string, string>;
  attachments?: MediaAttachment[];
}
/**
 * A step the harness rewrote no longer matches the thought signed with it, and that thought
 * can hold what the rewrite took out. Gemini signs a step on its first call and refuses the
 * step unsigned, so a signed call gets the value Google documents for a call its API did not write.
 */
function unsignedCall(call: ToolCall, original: ToolCall): ToolCall {
  const { extra_content: _thought, ...rest } = call;
  const google = original.extra_content?.google;
  return isRecord(google) && typeof google.thought_signature === 'string'
    ? {
        ...rest,
        extra_content: { google: { thought_signature: UNSIGNED_GEMINI_CALL } },
      }
    : rest;
}
/** A hook asked about this call: the card shows what it wrote for the person, the model reads its reason. */
function hookAsked(call: ToolCall, batch: HookBatch): ToolCall {
  return {
    ...call,
    ...(batch.reason ? { hook_reason: batch.reason } : {}),
    ...(batch.userMessage ? { hook_message: batch.userMessage } : {}),
  };
}
/**
 * The rewrite, with every part the hooks handed back as they were shown taken from the call as the model sent it.
 * The hooks see each secret's value as its name: a part they did not change keeps the value, also for a tool that
 * would take the name as written.
 */
function keepUnchanged(
  rewrite: unknown,
  shown: unknown,
  sent: unknown,
): unknown {
  if (canonicalJson(rewrite) === canonicalJson(shown)) return sent;
  if (Array.isArray(rewrite) && Array.isArray(shown) && Array.isArray(sent))
    return rewrite.map((item, index) =>
      index < shown.length && index < sent.length
        ? keepUnchanged(item, shown[index], sent[index])
        : item,
    );
  if (isRecord(rewrite) && isRecord(shown) && isRecord(sent))
    return Object.fromEntries(
      Object.entries(rewrite).map(([key, item]) => [
        key,
        Object.hasOwn(shown, key) && Object.hasOwn(sent, key)
          ? keepUnchanged(item, shown[key], sent[key])
          : item,
      ]),
    );
  return rewrite;
}
/** The arguments a before_tool rewrite changed, added or took out. Both sides have secrets as `%NAME%`. */
function changedArguments(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}
/** What a rewrite changed, for the model, so its next call can be written that way. */
function hookChangedLine(
  by: string,
  changed: string[],
  after: Record<string, unknown>,
): string {
  const lines = changed.map((key) => {
    if (!Object.hasOwn(after, key)) return `${key} removed`;
    const value = JSON.stringify(after[key]) ?? '';
    return `${key} = ${value.length > 1000 ? `${value.slice(0, 1000)}…` : value}`;
  });
  return `${HOOK_CHANGED_LINE} (${by}):\n${lines.join('\n')}`;
}
/** Facts a tool read from the values a call runs with, as the person and the hooks see them. */
function namedSecrets(
  facts: Record<string, unknown>,
  secrets: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(facts).map(([name, value]) => [
      name,
      typeof value === 'string' ? redactSecrets(value, secrets) : value,
    ]),
  );
}

/** A hook's words go to the model inside a reminder: a tag of that name in them is written so it cannot close one. */
function escapeReminder(text: string): string {
  return text.replace(/<(\/?system-reminder)/gi, '&lt;$1');
}

function turnsLeftToRemind(maxTurns: number): number {
  return maxTurns < 10 ? 0 : Math.min(20, Math.floor(maxTurns / 5));
}

export class Harness {
  private hooksAnnounced = false;
  /** Whether this conversation's hooks have started: its SessionStart ran, or would have. */
  get hooksStarted(): boolean {
    return this.hooksAnnounced;
  }
  /** How many times in a row Stop hooks sent this turn back to work; a tool call starts the count again. */
  private stopContinuations = 0;
  /** A Stop hook has sent this turn back to work: the next Stop hooks are told so. */
  private stopHookActive = false;
  /** A hook said `continue: false`: the turn ends once the calls under way are done. */
  private hookStop: string | undefined;
  private hookNotes: Message[] = [];
  private promptFileAllowed(path: string): boolean {
    const name = path.replaceAll('\\', '/').split('/').at(-1)!;
    return !this.options.policy.credentialFiles.some((pattern) =>
      wildcard(pattern, name),
    );
  }
  readonly bus: EventBus;
  readonly sessionId: string;
  tools: Tool[];
  model: ChatModel;
  system: string;
  planMode = false;
  private controller?: AbortController;
  // The step under way: `steerNow` stops it without ending the turn.
  private step?: AbortController;
  private steering: string[] = [];
  private followUps: string[] = [];
  private steeringIds: string[] = [];
  private followUpIds: string[] = [];
  private readonly inputEpoch = randomUUID();
  private queueVersion = 0;
  /** How the input box showed a prompt the model reads in full: long pastes stay folded on screen. */
  readonly shown = new InputPresentations((text, presentation) =>
    this.savePresentation(text, presentation),
  );
  private active?: Promise<{ answer: string; usage: Usage }>;
  /** Text of the model call in flight, kept when the user stops it before the reply is stored. */
  private streamed = '';
  private streamedThinking = '';
  /** When this step's thinking started, and how long it ran before the answer text. */
  private thinkingAt?: number;
  private thinkingSeconds?: number;
  /** Secrets' values hidden as %NAME% in text the model reads. */
  readonly redact: Redactor;
  constructor(readonly options: HarnessOptions) {
    this.redact =
      options.redact ??
      secretRedactor(
        () => options.secrets?.() ?? {},
        () => options.variables?.() ?? {},
      );
    this.sessionId = options.session.id;
    this.bus = options.bus ?? new EventBus(this.sessionId);
    this.tools = options.tools;
    this.model = options.model;
    this.system = options.system;
    if (!options.inspect) {
      options.store.repairInterrupted(this.sessionId);
      options.store.inputs.recover(this.sessionId, this.inputEpoch);
    }
  }
  get busy(): boolean {
    return Boolean(this.active);
  }
  private offered(): Tool[] {
    const withheld = this.options.skills?.withheld(this.sessionId);
    return withheld
      ? this.tools.filter((tool) => !withheld.has(tool.name))
      : this.tools;
  }
  get pendingMessageCount(): number {
    return this.steering.length + this.followUps.length;
  }
  /** Native queue editors freeze this with the row to reject same-text ABA races. */
  get queuedVersion(): number {
    return this.queueVersion;
  }
  get messages(): Message[] {
    return this.options.store.messages(this.sessionId);
  }
  /** Read-only now: its own plan mode, or the one it follows. */
  get readOnly(): boolean {
    return this.planMode || this.options.parentPlanMode?.() === true;
  }
  /**
   * Whether read-only mode refuses this call: anything but a read, except a write of this conversation's plan
   * file and a workflow, which asks first and whose agents work in read-only mode too.
   */
  private readOnlyRefuses(call: ToolCall, effect: Tool['effect']): boolean {
    return (
      this.readOnly &&
      effect !== 'read' &&
      call.name !== 'workflow' &&
      !this.options.planFileMutation?.(call)
    );
  }
  /** Model requests made so far, counted against `maxTurns`. */
  private turnsTaken = 0;
  private turnLimitHit = false;
  private turnLimitSaid = false;
  /** The last run ended because `maxTurns` was spent, not with an answer of the model's own. */
  get stoppedAtTurnLimit(): boolean {
    return this.turnLimitHit;
  }
  /** Ends the turn once this step's tool calls are done, as a hook's `continue: false` does: a tool that finished the work calls it. */
  endTurnAfterCalls(): void {
    this.hookStop ??= '';
  }
  /** The approval mode this harness's calls are decided in. */
  private approvalMode(): ApprovalMode {
    return (
      this.options.approvalMode?.() ??
      this.options.policy.mode(this.options.approvalSessionId ?? this.sessionId)
    );
  }
  private inputIds(mode: 'steer' | 'followUp'): string[] {
    return mode === 'steer' ? this.steeringIds : this.followUpIds;
  }
  private input(id: string): StoredInput {
    const input = this.options.store.inputs.get(this.sessionId, id);
    if (!input || input.state !== 'queued' || input.epoch !== this.inputEpoch)
      throw new Error('queued input changed');
    return input;
  }
  private savePresentation(
    text: string,
    presentation: InputPresentation,
  ): void {
    const changes = [...this.steeringIds, ...this.followUpIds]
      .map((id) => this.input(id))
      .filter((input) => input.payload.text === text)
      .map((input) => ({
        id: input.id,
        payload: { ...input.payload, ...presentation },
      }));
    if (changes.length)
      this.options.store.inputs.update(
        this.sessionId,
        this.inputEpoch,
        changes,
      );
    if (changes.length) this.queueVersion++;
  }
  get recoverableInputs() {
    return this.options.store.inputs.recoverable(this.sessionId);
  }
  resolveInputs(request: ResolveInputsRequest): ResolveInputsResult {
    const result = this.options.store.inputs.resolve(
      this.sessionId,
      this.inputEpoch,
      request,
    );
    if (result.applied && request.action === 'resume') {
      for (const input of result.items) {
        (input.kind === 'steer' ? this.steering : this.followUps).push(
          input.payload.text,
        );
        this.inputIds(input.kind).push(input.id);
        Map.prototype.set.call(
          this.shown,
          input.payload.text,
          inputPresentation(input.payload),
        );
      }
      this.queueVersion++;
    }
    return result;
  }
  queue(
    message: string,
    mode: 'steer' | 'followUp' = 'steer',
    attachments?: MediaAttachment[],
    options: {
      inputId?: string;
      display?: string;
      pastes?: Record<string, string>;
    } = {},
  ): void {
    if (attachments?.length) validateAttachments(attachments);
    const previous = this.shown.get(message);
    const duplicate = [...this.steering, ...this.followUps].includes(message);
    const input = this.options.store.inputs.enqueue(
      this.sessionId,
      this.inputEpoch,
      mode,
      {
        text: message,
        display: options.display ?? previous?.display ?? message,
        ...((options.pastes ?? previous?.pastes)
          ? { pastes: options.pastes ?? previous!.pastes }
          : {}),
        ...(attachments?.length || (!duplicate && previous?.attachments)
          ? {
              attachments: attachments?.length
                ? attachments
                : previous!.attachments,
            }
          : {}),
      },
      options.inputId,
    );
    if (
      input.state !== 'queued' ||
      input.epoch !== this.inputEpoch ||
      [...this.steeringIds, ...this.followUpIds].includes(input.id)
    )
      return;
    this.inputIds(mode).push(input.id);
    Map.prototype.set.call(
      this.shown,
      message,
      inputPresentation(input.payload),
    );
    (mode === 'steer' ? this.steering : this.followUps).push(message);
    this.queueVersion++;
  }
  get queuedMessages(): { steering: string[]; followUp: string[] } {
    return { steering: [...this.steering], followUp: [...this.followUps] };
  }
  removeQueued(
    mode: 'steer' | 'followUp',
    index: number,
    expected: string,
  ): string {
    const queue = mode === 'steer' ? this.steering : this.followUps;
    if (!Number.isSafeInteger(index) || index < 0 || queue[index] !== expected)
      throw Error('queued message changed');
    const ids = this.inputIds(mode);
    this.options.store.inputs.update(this.sessionId, this.inputEpoch, [
      { id: ids[index]!, state: 'discarded' },
    ]);
    ids.splice(index, 1);
    const [message] = queue.splice(index, 1);
    this.queueVersion++;
    if (![...this.steering, ...this.followUps].includes(message!))
      this.shown.delete(message!);
    return message!;
  }
  /** Save an unsent edit in place; a consumed or changed row must never edit its neighbour. */
  editQueued(
    mode: 'steer' | 'followUp',
    index: number,
    expectedText: string,
    updatedText: string,
    expectedVersion?: number,
  ): string {
    if (mode !== 'steer' && mode !== 'followUp')
      throw Error('invalid queue kind');
    if (
      expectedVersion !== undefined &&
      (!Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0 ||
        expectedVersion !== this.queueVersion)
    )
      throw Error('queued messages changed; reopen the message to edit');
    const queue = mode === 'steer' ? this.steering : this.followUps;
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      queue[index] !== expectedText
    )
      throw Error('queued message changed');
    if (typeof updatedText !== 'string' || !updatedText.trim())
      throw Error('queued message cannot be empty');
    const ids = this.inputIds(mode);
    const previous = this.input(ids[index]!).payload;
    const reference = /\[(?:Pasted text|Image|PDF) #(\d+)(?: \+\d+ lines)?\]/g;
    const message = updatedText.replace(
      reference,
      (match, id: string) => previous?.pastes?.[id] ?? match,
    );
    let display = updatedText;
    for (const match of (previous?.display ?? '').matchAll(reference)) {
      const content = previous?.pastes?.[match[1]!];
      if (content) display = display.replaceAll(content, match[0]);
    }
    const pastes = Object.fromEntries(
      [...display.matchAll(reference)].flatMap((match) => {
        const content = previous?.pastes?.[match[1]!];
        return content === undefined ? [] : [[match[1]!, content]];
      }),
    );
    const shown = {
      display,
      ...(Object.keys(pastes).length ? { pastes } : {}),
      ...(previous?.attachments
        ? { attachments: structuredClone(previous.attachments) }
        : {}),
    };
    const existing = this.shown.get(message);
    if (
      message !== expectedText &&
      existing &&
      [...this.steering, ...this.followUps].includes(message) &&
      JSON.stringify(existing) !== JSON.stringify(shown)
    )
      throw Error(
        'queued message already has different attachments or folded text',
      );
    this.options.store.inputs.update(this.sessionId, this.inputEpoch, [
      { id: ids[index]!, payload: { text: message, ...shown } },
    ]);
    queue[index] = message;
    this.queueVersion++;
    Map.prototype.set.call(this.shown, message, shown);
    if (![...this.steering, ...this.followUps].includes(expectedText))
      this.shown.delete(expectedText);
    return message;
  }
  /** The waiting messages as the input box showed them (long pastes and images folded). */
  get queuedShown(): { steering: string[]; followUp: string[] } {
    try {
      return {
        steering: this.steeringIds.map((id) => this.input(id).payload.display),
        followUp: this.followUpIds.map((id) => this.input(id).payload.display),
      };
    } catch {
      // Drawn on every repaint: a busy or failing store shows what memory holds.
      const shown = (text: string) => this.shown.get(text)?.display ?? text;
      return {
        steering: this.steering.map(shown),
        followUp: this.followUps.map(shown),
      };
    }
  }
  /**
   * Take back messages the model has not read, as the box showed them: the last one listed
   * (the last follow-up, else the last steering message), or `all` of them in list order.
   */
  takeBack(all = false): QueuedMessage[] {
    const ids = all
      ? [...this.steeringIds, ...this.followUpIds]
      : this.followUps.length
        ? this.followUpIds.slice(-1)
        : this.steeringIds.slice(-1);
    const inputs = ids.map((id) => this.input(id));
    this.options.store.inputs.update(
      this.sessionId,
      this.inputEpoch,
      // The input box has it now; a copy left here would come back as a stale draft.
      ids.map((id) => ({ id, state: 'discarded' as const })),
    );
    if (all) {
      this.steeringIds = [];
      this.followUpIds = [];
    } else if (this.followUps.length) this.followUpIds.splice(-1);
    else this.steeringIds.splice(-1);
    const taken = all
      ? [...this.steering.splice(0), ...this.followUps.splice(0)]
      : this.followUps.length
        ? this.followUps.splice(-1)
        : this.steering.splice(-1);
    this.queueVersion++;
    for (const message of taken)
      if (![...this.steering, ...this.followUps].includes(message))
        this.shown.delete(message);
    return taken.map((message, index) => {
      const shown = inputs[index]!.payload;
      return {
        message,
        display: shown?.display ?? message,
        ...(shown?.pastes ? { pastes: shown.pastes } : {}),
        ...(shown?.attachments ? { attachments: shown.attachments } : {}),
      };
    });
  }
  /**
   * Have the model read the waiting steering messages now: the step under way stops (the
   * model's reply in progress is dropped, running tools are stopped, finished tool results
   * stay) and the turn goes on with the messages. False when none waits or no turn runs.
   */
  steerNow(): boolean {
    if (!this.active || !this.steering.length) return false;
    // Said plainly: the message may still be taken back before it is read
    this.step?.abort(new Error('Interrupted by the user'));
    return true;
  }
  clearQueue(): { steering: string[]; followUp: string[] } {
    this.options.store.inputs.update(
      this.sessionId,
      this.inputEpoch,
      [...this.steeringIds, ...this.followUpIds].map((id) => ({
        id,
        state: 'discarded',
      })),
    );
    this.steeringIds = [];
    this.followUpIds = [];
    this.queueVersion++;
    const result = {
      steering: this.steering.splice(0),
      followUp: this.followUps.splice(0),
    };
    for (const message of [...result.steering, ...result.followUp])
      this.shown.delete(message);
    return result;
  }
  // Stop the turn. With `keepQueue`, as esc stops it: the messages it had not read yet stay,
  // each to be sent as a turn of its own (the steering ones first); nothing here starts them.
  async cancel(
    options: { keepQueue?: boolean; preserveInputs?: boolean } = {},
  ): Promise<void> {
    this.queueVersion++;
    let persistenceError: unknown;
    try {
      if (options.keepQueue) {
        this.options.store.inputs.update(
          this.sessionId,
          this.inputEpoch,
          this.steeringIds.map((id) => ({ id, kind: 'followUp' })),
        );
        this.followUps.unshift(...this.steering.splice(0));
        this.followUpIds.unshift(...this.steeringIds.splice(0));
      } else {
        if (!options.preserveInputs)
          this.options.store.inputs.update(
            this.sessionId,
            this.inputEpoch,
            [...this.steeringIds, ...this.followUpIds].map((id) => ({
              id,
              state: 'discarded',
            })),
          );
        this.followUps = [];
        this.steering = [];
        this.followUpIds = [];
        this.steeringIds = [];
        this.shown.clear();
      }
    } catch (error) {
      persistenceError = error;
    }
    this.controller?.abort(new Error('Interrupted'));
    try {
      await this.active;
    } catch {
      /* run_error and persisted results record the stop. */
    }
    if (persistenceError) throw persistenceError;
  }
  /** Let in-flight titles finish, up to a moment: closing must not wait on a gateway. */
  async finishTitle(waitMs = 3_000): Promise<void> {
    if (!this.titleTasks.size) return;
    await Promise.race([
      Promise.all([...this.titleTasks]).catch(() => undefined),
      delay(waitMs, undefined, { ref: false }),
    ]);
  }
  private storedSession(sessionId = this.sessionId): Session | undefined {
    try {
      return this.options.store.get(sessionId);
    } catch (error) {
      // The session can close while the title request is still in flight.
      if (error instanceof Error && /not open/.test(error.message))
        return undefined;
      throw error;
    }
  }
  // A prompt with the files it mentions and the ones given with it (the desktop's). A model
  // known not to read images gets their paths only, and the screen says so. A file that
  // cannot go is left out: the model and the screen are told which and why.
  private async attach(
    prompt: string,
    workspace: string,
    signal: AbortSignal,
    given?: MediaAttachment[],
  ): Promise<Pick<Message, 'content' | 'attachments'>> {
    const { message, leftOut, saved, problems } = await attachPrompt(
      prompt,
      workspace,
      signal,
      (path) => this.promptFileAllowed(path),
      this.model.imageInput !== false,
      given,
      this.options.saveImageAttachment,
    );
    if (leftOut)
      this.bus.emit('info', {
        payload: {
          model_notice: {
            event: 'images_left_out',
            model: this.model.model,
            count: leftOut,
            // Some were written as files, their paths given to the model
            ...(saved ? { saved: true } : {}),
          },
        },
      });
    if (!problems.length) return message;
    this.bus.emit('info', {
      payload: { model_notice: { event: 'files_left_out', problems } },
    });
    return {
      ...message,
      content: `${message.content}\n\n[Not attached: ${problems.join('; ')}]`,
    };
  }
  private save(message: Message): void {
    this.options.store.append(this.sessionId, [message]);
  }
  private shownAs(prompt: string): Pick<Message, 'display' | 'pastes'> {
    const shown = this.shown.get(prompt);
    if (![...this.steering, ...this.followUps].includes(prompt))
      this.shown.delete(prompt);
    if (!shown) return { display: prompt };
    return {
      display: shown.display,
      ...(shown.pastes ? { pastes: shown.pastes } : {}),
    };
  }
  private nextQueued(mode: 'steer' | 'followUp'): StoredInput | undefined {
    const id = this.inputIds(mode)[0];
    return id ? this.input(id) : undefined;
  }
  private consumeInput(
    input: StoredInput,
    message: Pick<Message, 'content' | 'attachments'>,
  ): void {
    this.options.store.appendInput(this.sessionId, input.id, this.inputEpoch, {
      id: input.id,
      role: 'user',
      ...message,
      display: input.payload.display,
      ...(input.payload.pastes ? { pastes: input.payload.pastes } : {}),
    });
    this.takeInput(input);
  }
  /** A queued message a hook kept from the model: it leaves the queue, and the conversation keeps only the note. */
  private dropInput(input: StoredInput, note: Message): void {
    this.options.store.appendInput(this.sessionId, input.id, this.inputEpoch, {
      ...note,
      id: input.id,
    });
    this.takeInput(input);
  }
  private takeInput(input: StoredInput): void {
    const ids = this.inputIds(input.kind),
      index = ids.indexOf(input.id);
    if (index < 0) throw new Error('queued input changed before consumption');
    ids.splice(index, 1);
    (input.kind === 'steer' ? this.steering : this.followUps).splice(index, 1);
    this.queueVersion++;
    if (![...this.steering, ...this.followUps].includes(input.payload.text))
      this.shown.delete(input.payload.text);
  }
  // `display` is what the conversation shows for the prompt when it differs from the text
  // the model gets (`circle "question" @file`).
  async run(
    prompt?: string,
    display?: string,
    attachments?: MediaAttachment[],
  ): Promise<{ answer: string; usage: Usage }> {
    if (this.options.inspect)
      throw new Error(occupiedSessionMessage(this.sessionId));
    if (this.active) throw new Error('a turn is already running');
    this.turnLimitHit = false;
    if (prompt !== undefined && display !== undefined && display !== prompt)
      this.shown.set(prompt, { display });
    if (attachments?.length) {
      validateAttachments(attachments);
      if (prompt === undefined) throw Error('attachments require a prompt');
      this.shown.set(prompt, {
        ...(this.shown.get(prompt) ?? { display: prompt }),
        attachments: structuredClone(attachments),
      });
    }
    this.controller = new AbortController();
    this.active = this.runQueued(prompt, this.controller.signal);
    try {
      return await this.active;
    } finally {
      this.active = undefined;
      this.controller = undefined;
      // A crash skips this. The open-turn row then still names the unanswered
      // prompt, which is the only case that earns an interrupted marker.
      this.options.store.clearTurn(this.sessionId);
      this.options.settled?.();
    }
  }
  private async runQueued(
    prompt: string | undefined,
    signal: AbortSignal,
  ): Promise<{ answer: string; usage: Usage }> {
    await this.options.beforeRun?.(signal);
    signal.throwIfAborted();
    const total = emptyUsage();
    let answer = '';
    let first = true;
    do {
      signal.throwIfAborted();
      // Peek, then check the connection, then take the message. Shifting first
      // drops a queued follow-up when logout throws before the next turn.
      const upcoming = first
        ? prompt !== undefined
          ? prompt
          : (this.steering[0] ?? this.followUps[0])
        : this.followUps[0];
      this.options.beforeTurn?.(upcoming);
      signal.throwIfAborted();
      const queued =
        first && prompt !== undefined
          ? undefined
          : first
            ? (this.nextQueued('steer') ?? this.nextQueued('followUp'))
            : this.nextQueued('followUp');
      const next =
        first && prompt !== undefined ? prompt : queued?.payload.text;
      const result = await this.runTurn(next, signal, queued);
      answer = result.answer;
      addUsage(total, result.usage);
      first = false;
    } while (this.followUps.length);
    return { answer, usage: total };
  }
  /**
   * Output cap for the title request. 128 was spent entirely on reasoning by
   * glm-5.3, so the answer never arrived. 512 leaves room for the title once
   * thinking is disabled.
   */
  static readonly titleOutputTokens = TITLE_MAX_TOKENS;
  /**
   * How long a title may keep the person waiting for a name. A side request is
   * never worth holding the channel: a gateway that hangs says nothing useful.
   */
  static readonly titleWaitMs = 10_000;
  /** Set when the turn starts. Sent after the turn so it does not share that request. */
  private pendingTitle?: { display: string; fallback: string };
  /** Title requests in flight, so close can let them land before the store goes. */
  private readonly titleTasks = new Set<Promise<void>>();
  private generateTitle(
    display: string,
    fallback: string,
    sessionId = this.sessionId,
  ): Promise<void> {
    const task = this.requestTitle(display, fallback, sessionId);
    this.titleTasks.add(task);
    void task.finally(() => this.titleTasks.delete(task));
    return task;
  }
  /**
   * Ask the model for a short title. The terminal has already saved the short
   * title; with `holdTitle` (the desktop) a sentence stays untitled until this
   * returns. A scripted model never sees this call. A rename that landed first
   * is left alone. The request disables thinking: glm-5.3 still reasons when
   * the field is omitted. Reasoning text is not a title. The prompt is wrapped
   * as data, and a reply that answers the user is discarded.
   */
  private requestTitle(
    display: string,
    fallback: string,
    sessionId: string,
  ): Promise<void> {
    // `this.model`, not the model passed at construction: /model and a reload replace it.
    const model = this.model;
    const prompt = display.trim();
    const report = (message: string): void => {
      titleTrace(`failed: ${message}`);
      this.bus.emit('info', {
        payload: { model_notice: { event: 'title_failed', message } },
      });
    };
    // A greeting keeps the fallback and stays quiet. A long line with no side
    // request used to return here with no footer: the extension wrapper had
    // dropped `sideRequests`. That one still says why.
    const skip = titleSkipReason(prompt, model.sideRequests);
    if (skip === 'prompt too short') {
      titleTrace(`skipped (${skip})`);
      return Promise.resolve();
    }
    if (skip) {
      titleTrace(`skipped (${skip})`);
      report(skip);
      return Promise.resolve();
    }
    titleTrace(
      `request model=${model.model} chars=${prompt.length} maxTokens=${Harness.titleOutputTokens} thinking=disabled`,
    );
    const system = readPrompt('agent', 'title.md');
    const ask = (text: string) =>
      model.complete({
        system: text,
        messages: [
          {
            id: 'title',
            role: 'user',
            content: titleConversation(prompt),
          },
        ],
        tools: [],
        signal: AbortSignal.timeout(Harness.titleWaitMs),
        // `''` asks the Anthropic body for `thinking: {type: 'disabled'}`.
        // `minimal` is sent as output_config.effort and glm rejects it.
        effort: '',
        maxTokens: Harness.titleOutputTokens,
        token: () => {},
      });
    // One retry for a dropped connection. A request the clock stopped is not
    // sent again: a hanging gateway would spend the wait twice for nothing.
    const call = async (text: string) => {
      try {
        return await ask(text);
      } catch (error) {
        if (!isNetworkFailure(error) || titleTimedOut(error)) throw error;
        return await ask(text);
      }
    };
    // An empty title is the desktop's placeholder while the summary is pending.
    const unchanged = (title: string) => title === fallback || title === '';
    const remember = (title: string): boolean => {
      try {
        this.options.store.rename(sessionId, title);
      } catch (error) {
        if (
          error instanceof SessionOccupiedError ||
          (error instanceof Error && /not open/.test(error.message))
        )
          return false;
        throw error;
      }
      this.bus.emit('info', { payload: { title, session_id: sessionId } });
      return true;
    };
    // The terminal already stored the short title. The desktop held the
    // sentence untitled: a failed summary must not quietly become that prompt.
    const keepFallback = (): void => {
      if (this.options.holdTitle) return;
      const current = this.storedSession(sessionId);
      if (current && !current.title && !current.title_locked)
        remember(fallback);
    };
    return call(system)
      .then(async (response) => {
        // Reasoning is never a title, even when the answer is empty.
        let decision = acceptGeneratedTitle(response.message.content, prompt);
        // One stricter retry. A second copy is not stored.
        if (decision.reason === 'echoes prompt') {
          const held = this.storedSession(sessionId);
          if (!held || held.title_locked) return;
          if (!unchanged(held.title)) {
            this.bus.emit('info', {
              payload: { title: held.title, session_id: sessionId },
            });
            return;
          }
          const again = await call(titleRetrySystem(system));
          decision = acceptGeneratedTitle(again.message.content, prompt);
          // A held session stays untitled after a second copy, and that is
          // not a failure. The terminal keeps its short title and says so.
          if (
            decision.reason === 'echoes prompt' &&
            this.options.holdTitle &&
            !this.storedSession(sessionId)?.title
          ) {
            titleTrace('left untitled (title echoed the prompt)');
            return;
          }
        }
        if (!decision.title) {
          titleTrace(`discarded (${decision.reason})`);
          keepFallback();
          report(decision.reason);
          return;
        }
        const title = decision.title;
        const current = this.storedSession(sessionId);
        if (!current || current.title_locked) return;
        if (!unchanged(current.title)) {
          // A repair that finished first already renamed it. The resume line
          // still has the old title until this event.
          this.bus.emit('info', {
            payload: { title: current.title, session_id: sessionId },
          });
          return;
        }
        if (!remember(title)) return;
        titleTrace(`renamed to ${JSON.stringify(title)}`);
      })
      .catch((error: unknown) => {
        // The short title stays. A side request must not fail the turn.
        try {
          keepFallback();
        } catch {
          /* The store is closing. */
        }
        report(
          friendlyTitleFailure(
            error instanceof Error ? error.message : String(error),
          ),
        );
      });
  }
  private thoughtClock(): { thinking_seconds?: number } {
    const seconds =
      this.thinkingSeconds ??
      (this.thinkingAt !== undefined
        ? (Date.now() - this.thinkingAt) / 1000
        : undefined);
    const thought = this.streamedThinking.replace(
      /[\s\u200b\u200c\u200d\ufeff\u2060\u00ad]/g,
      '',
    );
    this.thinkingAt = undefined;
    this.thinkingSeconds = undefined;
    // An empty thinking token is not a thought. A real one keeps its clock,
    // including a short one.
    if (seconds === undefined || !thought) return {};
    return { thinking_seconds: seconds };
  }
  /** What this step was about to send, when the endpoint never reported input tokens. */
  private estimateInputTokens(): number {
    const parts = [this.system];
    for (const message of this.messages) {
      parts.push(message.content);
      if (message.thinking) parts.push(message.thinking);
    }
    for (const tool of this.offered())
      parts.push(tool.name, tool.description, JSON.stringify(tool.parameters));
    return Math.max(1, tokenLen(parts.join('\n')));
  }
  /**
   * Ask again for a title that is still the trimmed first message. The caller
   * has already checked that a turn was answered. A short prompt stays quiet.
   * `sessionId` names another session when the recent list is repaired.
   */
  retitle(
    display: string,
    storedTitle: string,
    sessionId?: string,
  ): Promise<void> {
    return this.generateTitle(
      display,
      storedTitle,
      sessionId ?? this.sessionId,
    );
  }
  private flushTitle(): void {
    const pending = this.pendingTitle;
    if (!pending) return;
    this.pendingTitle = undefined;
    this.generateTitle(pending.display, pending.fallback);
  }
  private async runTurn(
    prompt: string | undefined,
    signal: AbortSignal,
    queued?: StoredInput,
  ): Promise<{ answer: string; usage: Usage }> {
    const start = Date.now();
    const usage = emptyUsage();
    let answer = '';
    const given =
      queued?.payload.attachments ??
      (prompt === undefined ? undefined : this.shown.get(prompt)?.attachments);
    const shown = queued
      ? inputPresentation(queued.payload)
      : prompt === undefined
        ? undefined
        : this.shownAs(prompt);
    this.stopContinuations = 0;
    this.stopHookActive = false;
    // A `continue: false` belongs to the turn it was said in
    this.hookStop = undefined;
    // SessionStart's words come before the first prompt
    await this.announceHooks(signal);
    if (prompt !== undefined) {
      const content = await this.attach(
        prompt,
        this.options.session.workspace,
        signal,
        given,
      );
      const changed = () =>
        !!queued &&
        (this.inputIds(queued.kind)[0] !== queued.id ||
          JSON.stringify(this.input(queued.id).payload) !==
            JSON.stringify(queued.payload));
      const again = () => {
        const next = this.nextQueued(queued!.kind);
        return next
          ? this.runTurn(next.payload.text, signal, next)
          : Promise.resolve({ answer: '', usage: emptyUsage() });
      };
      if (changed()) return again();
      // UserPromptSubmit sees the message before the model does, and can keep it from the model
      const verdict = await this.promptHooks(prompt, signal);
      signal.throwIfAborted();
      if (changed()) return again();
      if (verdict && (verdict.blocked || verdict.stop)) {
        const note = this.blockedPrompt(prompt, verdict);
        // The turn never starts: the model is not asked, and nothing waits for an answer
        if (queued) this.dropInput(queued, note);
        else this.save(note);
        this.flushHookNotes();
        return { answer: '', usage };
      }
      if (queued) this.consumeInput(queued, content);
      else this.save({ id: randomUUID(), role: 'user', ...content, ...shown });
      this.options.skills?.message(this.sessionId);
      if (verdict) this.hookContext(verdict, 'UserPromptSubmit');
    }
    const session = this.options.store.get(this.sessionId)!;
    if (!session.title && shown?.display !== undefined) {
      const fallback = fallbackTitle(shown.display);
      // The desktop holds a sentence untitled until its summary arrives, also
      // while a tool approval is open. A short line such as "hi" is its title.
      const hold =
        this.options.holdTitle &&
        !titleSkipReason(shown.display.trim(), this.model.sideRequests);
      if (!hold) {
        this.options.store.rename(this.sessionId, fallback);
        this.bus.emit('info', {
          payload: { title: fallback, session_id: this.sessionId },
        });
      }
      this.pendingTitle = { display: shown.display, fallback };
    }
    this.bus.emit('run_start', { payload: { message: prompt } });
    // A step the endpoint refuses as too long is compacted and tried again, for as long as
    // each try is smaller than the one refused before it: with automatic compaction on,
    // a person never meets a full context that compaction could have made room in
    let refused: { input: number; times: number } | undefined;
    try {
      for (let step = 0; step < (this.options.maxSteps ?? 9999); step++) {
        signal.throwIfAborted();
        // A subagent whose turns are spent ends here with what it has written: the run is cut short, not failed
        if (
          this.options.maxTurns !== undefined &&
          this.turnsTaken >= this.options.maxTurns
        ) {
          this.turnLimitHit = true;
          answer = String(
            this.messages.findLast(
              (message) =>
                message.role === 'assistant' &&
                String(message.content ?? '').trim(),
            )?.content ?? '',
          );
          this.bus.emit('run_end', {
            payload: { answer },
            usage: { ...usage },
            elapsed_ms: Date.now() - start,
          });
          this.flushTitle();
          return { answer, usage };
        }
        if (this.options.maxTurns !== undefined && !this.turnLimitSaid) {
          const left = this.options.maxTurns - this.turnsTaken;
          if (left <= turnsLeftToRemind(this.options.maxTurns)) {
            this.turnLimitSaid = true;
            this.save({
              id: randomUUID(),
              role: 'user',
              internal: 'turn_limit',
              content:
                '<system-reminder data-source="turn-limit">\n' +
                `This session can make ${left} more model ${left === 1 ? 'request' : 'requests'} of its ${this.options.maxTurns}. When they are spent it ends with what it has written to files and said by then, and anything learned and not written down is lost. Write the result the task asks for now; use the requests that remain to check and correct it.\n` +
                '</system-reminder>',
            });
          }
        }
        // The step starts here: a steerNow while the messages before are read stops it
        const stepControl = new AbortController();
        this.step = stepControl;
        const stepSignal = AbortSignal.any([signal, stepControl.signal]);
        // One at a time, each left waiting until it is stored: one that fails, or is taken
        // back while its files are read, does not take the others with it
        while (this.steering.length) {
          const version = this.queueVersion;
          const message = this.steering[0]!;
          const input = this.input(this.steeringIds[0]!);
          const content = await this.attach(
            message,
            session.workspace,
            signal,
            input.payload.attachments,
          );
          if (version !== this.queueVersion || this.steering[0] !== message)
            continue;
          const verdict = await this.promptHooks(message, signal);
          signal.throwIfAborted();
          // Taken back or replaced while the hooks ran: the next message is read; others queued meanwhile wait
          if (this.steeringIds[0] !== input.id || this.steering[0] !== message)
            continue;
          if (verdict && (verdict.blocked || verdict.stop)) {
            this.dropInput(input, this.blockedPrompt(message, verdict));
            this.flushHookNotes();
            continue;
          }
          this.consumeInput(input, content);
          this.options.skills?.message(this.sessionId);
          this.bus.emit('steer', { payload: { message } });
          if (verdict) this.hookContext(verdict, 'UserPromptSubmit');
        }
        this.deliverBackgroundHooks();
        this.options.beforeStep?.();
        try {
          stepSignal.throwIfAborted();
          this.streamed = '';
          this.streamedThinking = '';
          this.thinkingAt = undefined;
          this.thinkingSeconds = undefined;
          this.bus.emit('llm_start');
          // After the user message is stored, and not for a title or side request.
          this.options.store.noteTurn(this.sessionId);
          const request: ModelRequest = {
            enforceBudget: true,
            cacheKey: this.sessionId,
            system:
              this.system +
              (this.readOnly
                ? this.options.planPrompt
                  ? '\n\n' + this.options.planPrompt()
                  : '\nRead-only mode: inspect and plan; do not change files or run commands.'
                : ''),
            messages: orderModeToolResults(
              this.options.prepareMessages
                ? await this.options.prepareMessages(signal)
                : this.options.store.projectedMessages(this.sessionId),
            ),
            tools: this.offered(),
            ...(this.options.effort ? { effort: this.options.effort } : {}),
            signal: stepSignal,
            notice: (event) =>
              this.bus.emit('info', { payload: { model_notice: event } }),
            token: (text, thinking) => {
              // Stop forwards nothing that arrives after the person stops the turn.
              if (stepSignal.aborted) return;
              if (thinking) {
                const visible = text.replace(
                  /[\s\u200b\u200c\u200d\ufeff\u2060\u00ad]/g,
                  '',
                );
                if (visible) {
                  this.streamedThinking += text;
                  this.thinkingAt ??= Date.now();
                }
              } else {
                if (
                  this.thinkingAt !== undefined &&
                  this.thinkingSeconds === undefined
                )
                  this.thinkingSeconds = (Date.now() - this.thinkingAt) / 1000;
                this.streamed += text;
              }
              this.bus.emit('llm_token', {
                payload: { text, thinking: Boolean(thinking) },
              });
            },
          };
          let response: ModelResponse;
          try {
            response = await this.model.complete(request);
            this.turnsTaken++;
          } catch (error) {
            // The model's endpoint refused the request as too long, before any of an
            // answer came: the context it has is smaller than the one Circle measured.
            // The refused size is noted as the limit, so the step's next preparation
            // compacts the conversation to fit, and the step is tried again. A try no
            // smaller than the last refused one, or a sixth, ends the turn with the error.
            const input = requestBudget(this.model, request).input;
            if (
              (!refused || (input < refused.input && refused.times < 5)) &&
              !stepSignal.aborted &&
              isContextLimitError(error) &&
              // Circle's own measure, not the endpoint's refusal: nothing to learn
              !(error instanceof BudgetExceeded) &&
              !this.streamed.trim() &&
              !this.streamedThinking.trim()
            ) {
              refused = { input, times: (refused?.times ?? 0) + 1 };
              this.model.noteContextRefusal?.(input);
              continue;
            }
            throw error;
          }
          refused = undefined;
          stepSignal.throwIfAborted();
          const originalCalls = response.message.tool_calls;
          response.message.tool_calls = originalCalls?.map(
            (call) =>
              this.tools
                .find((tool) => tool.name === call.name)
                ?.privacy?.(call) ?? safeKnowledgeCall(call),
          );
          if (
            response.message.tool_calls?.some(
              (call, index) => call !== originalCalls?.[index],
            )
          ) {
            // Provider blocks, encrypted reasoning and the step's thought signature
            // still hold the original calls.
            response.message.provider_content = undefined;
            response.message.reasoning_items = undefined;
            response.message.tool_calls = response.message.tool_calls.map(
              (call, index) => unsignedCall(call, originalCalls![index]!),
            );
          }
          const message = {
            ...response.message,
            request_model: this.model.model,
            ...this.thoughtClock(),
            usage: response.usage,
            cost:
              response.message.cost ??
              this.options.priceUsage?.(
                response.message.model || this.model.model,
                response.usage,
              ),
          };
          this.save(message);
          this.streamed = '';
          this.streamedThinking = '';
          addUsage(usage, response.usage);
          this.bus.emit('llm_end', {
            payload: { message },
            usage: { ...response.usage },
          });
          const calls = response.message.tool_calls ?? [];
          const incomplete = completionFailure(message);
          if (incomplete) {
            // No tool in an incomplete response is safe to execute, including
            // earlier calls whose arguments happened to parse before the cutoff.
            for (const call of calls)
              this.finishCall({
                id: randomUUID(),
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                status: 'error',
                content: `not run: ${incomplete.message}`,
              });
            throw incomplete;
          }
          if (!calls.length) {
            answer = response.message.content;
            if (this.steering.length) continue;
            if (
              this.hookStop === undefined &&
              (await this.blockStop(answer, signal))
            )
              continue;
            this.hookStop = undefined;
            this.bus.emit('run_end', {
              payload: { answer },
              usage: { ...usage },
              elapsed_ms: Date.now() - start,
            });
            this.flushTitle();
            return { answer, usage };
          }
          // A tool call starts the Stop hooks' count again
          this.stopContinuations = 0;
          // The subagents of task calls next to each other run at the same time;
          // every other call runs on its own, in order. Results are stored in the order of the
          // calls, each once those before it are in.
          for (let index = 0; index < calls.length;) {
            let end = index + 1;
            if (this.parallel(calls[index]!))
              while (end < calls.length && this.parallel(calls[end]!)) end++;
            const batch = calls.slice(index, end);
            const results: (Message | undefined)[] = [];
            let stored = 0;
            const settled = await Promise.allSettled(
              batch.map(async (call, at) => {
                results[at] = await this.runCall(call, stepSignal);
                if (results[at]!.usage) addUsage(usage, results[at]!.usage!);
                while (results[stored]) this.finishCall(results[stored++]!);
              }),
            );
            for (const outcome of settled)
              if (outcome.status === 'rejected') throw outcome.reason;
            this.flushHookNotes();
            index = end;
          }
          stepSignal.throwIfAborted();
          // A hook said `continue: false`: the turn ends with the calls it has made
          if (this.hookStop !== undefined) {
            this.hookStop = undefined;
            this.bus.emit('run_end', {
              payload: { answer },
              usage: { ...usage },
              elapsed_ms: Date.now() - start,
            });
            this.flushTitle();
            return { answer, usage };
          }
        } catch (error) {
          // Stopped by `steerNow`: the next step reads the messages; the turn goes on
          if (signal.aborted || !stepControl.signal.aborted) throw error;
        } finally {
          if (this.step === stepControl) this.step = undefined;
        }
      }
      throw new Error('maximum model steps reached');
    } catch (error) {
      if (this.streamed.trim() || this.streamedThinking.trim()) {
        try {
          const estimated = {
            input_tokens: this.estimateInputTokens(),
            output_tokens: Math.max(
              1,
              Math.ceil(
                (this.streamed.length + this.streamedThinking.length) / 4,
              ),
            ),
            cache_read_tokens: 0,
          };
          let cost: Message['cost'];
          try {
            cost = this.options.priceUsage?.(this.model.model, estimated);
          } catch {
            cost = undefined;
          }
          const message: Message = {
            id: randomUUID(),
            role: 'assistant',
            content: this.streamed,
            ...(this.streamedThinking
              ? { thinking: this.streamedThinking }
              : {}),
            ...this.thoughtClock(),
            interrupted: true,
            usage: estimated,
            ...(cost ? { cost } : {}),
          };
          this.save(message);
          // The footer sums this usage. The turn line only hears it from llm_end.
          // Without that event a stop mid-thought shows ↓ 0 under the turn and the
          // estimate in the footer.
          this.bus.emit('llm_end', {
            payload: { message },
            usage: { ...estimated },
          });
        } catch {
          /* The store may already be closing. The turn still reports the failure. */
        }
        this.streamed = '';
        this.streamedThinking = '';
      } else if (!signal.aborted) {
        const asked = this.messages.some(
          (message) => message.role === 'user' && !message.internal,
        );
        // Keep the person's words on screen. Drop the row only when nothing was saved.
        if (!asked)
          try {
            this.options.store.abandonUnanswered(this.sessionId);
          } catch {
            /* Keep the original failure. */
          }
      }
      this.flushTitle();
      const failure = signal.aborted ? signal.reason : error;
      const compactionOperationId =
        (error as { compactionOperationId?: string })?.compactionOperationId ??
        (failure as { compactionOperationId?: string })?.compactionOperationId;
      // A turn and its compactor have separate AbortControllers. Preserve the
      // operation identity when the turn's cancellation reason replaces its error.
      if (compactionOperationId && failure instanceof Error)
        Object.assign(failure, { compactionOperationId });
      this.bus.emit('run_error', {
        payload: {
          ...(compactionOperationId
            ? { compaction_operation_id: compactionOperationId }
            : {}),
          message: redact(
            failure instanceof Error ? failure.message : String(failure),
          ),
          interrupted: signal.aborted,
          // 401 or 403: the endpoint turned the key down
          status: signal.aborted ? undefined : httpStatus(failure),
          ...(!signal.aborted && failure instanceof ModelCompletionFailure
            ? {
                completion_failure: failure.code,
                completion_message_id: failure.responseId,
              }
            : {}),
          // What the endpoint itself said, under Circle's words for the failure: its
          // code and message are what a person reports, and what tells one cause from another
          ...(!signal.aborted &&
          failure instanceof ModelCompletionFailure &&
          failure.providerError
            ? {
                provider_error: {
                  ...(failure.providerError.code
                    ? { code: failure.providerError.code }
                    : {}),
                  message: redact(failure.providerError.message),
                },
              }
            : {}),
        },
        usage: { ...usage },
        elapsed_ms: Date.now() - start,
      });
      throw failure;
    }
  }
  /**
   * The person reads the hook's own words for them (`user_message`), or else its reason. The model reads each
   * reason once: a failed hook's error text is for the person, and a reason the tool result or the system prompt
   * already carries (`given`) is not repeated here.
   */
  private queueHook(notice: HookNotice, given = false): void {
    const text = hookNoticeText({
      ...notice,
      reason: notice.message || notice.reason,
    });
    const told = escapeReminder(
      hookNoticeText({
        ...notice,
        reason:
          notice.kind === 'failed' || notice.kind === 'message' || given
            ? undefined
            : notice.reason,
      }),
    );
    this.hookNotes.push({
      id: randomUUID(),
      role: 'user',
      internal: 'hook_notice',
      content: `<system-reminder data-source="circle-hooks">\n${told}\n</system-reminder>`,
      display: text,
      hook: notice,
    });
  }
  private flushHookNotes(): void {
    const notes = this.hookNotes;
    if (!notes.length) return;
    this.hookNotes = [];
    for (const note of notes) this.save(note);
    this.bus.emit('info', {
      payload: { hook_notice: true, count: notes.length },
    });
  }
  private saveHook(notice: HookNotice, given = false): void {
    this.queueHook(notice, given);
    this.flushHookNotes();
  }
  private async announceHooks(signal: AbortSignal): Promise<void> {
    if (this.hooksAnnounced || this.options.sessionHooks === false) return;
    this.hooksAnnounced = true;
    const runner = this.options.hooks;
    if (!runner) return;
    const loaded = runner.loaded;
    for (const note of loaded.notes)
      this.saveHook({ kind: 'message', name: 'migration', reason: note });
    if (loaded.untrusted) this.saveHook({ kind: 'untrusted' });
    for (const error of loaded.errors)
      this.saveHook({
        kind: 'failed',
        name: hookFileLabel(error.file),
        reason: error.message,
      });
    const running = runner.active();
    if (running.length)
      this.saveHook({
        kind: 'active',
        count: running.length,
        reason: activeHookSummary(running),
      });
    await this.sessionStartHooks(
      this.options.sessionSource ??
        (this.messages.some((message) => message.role === 'assistant')
          ? 'resume'
          : 'startup'),
      signal,
    );
  }
  /** The permission mode hooks are told: this harness's own, or plan while it is read-only. */
  hookMode(): string | undefined {
    return hookPermissionMode(
      this.approvalMode(),
      this.readOnly,
      this.options.dontAsk?.() === true,
    );
  }
  /** Who and where, for every hook this conversation runs. */
  private hookBase(): {
    sessionId: string;
    agent?: { id: string; type: string };
    cwd: string;
    permissionMode?: string;
    secrets: Record<string, string>;
    extra?: HookDefinition[];
  } {
    const mode = this.hookMode();
    return {
      ...this.hookIdentity(),
      cwd: this.options.session.workspace,
      ...(mode ? { permissionMode: mode } : {}),
      secrets: this.hookSecrets(),
      ...(this.options.agentHooks ? { extra: this.options.agentHooks } : {}),
    };
  }
  /**
   * SessionStart hooks: what they say goes at the start of the conversation, before the first prompt, and again after
   * a compaction (`compact`).
   */
  async sessionStartHooks(
    source: 'startup' | 'resume' | 'clear' | 'compact',
    signal?: AbortSignal,
  ): Promise<void> {
    const runner = this.options.hooks;
    if (this.options.sessionHooks === false || !runner?.has('SessionStart'))
      return;
    const batch = await runner.run({
      event: 'SessionStart',
      ...this.hookBase(),
      matchValue: source,
      fields: { source, model: this.model.model },
      ...(signal ? { signal } : {}),
    });
    this.hookContext(batch, 'SessionStart');
    if (batch.sessionTitle && source !== 'compact' && source !== 'clear') {
      this.options.store.rename(this.sessionId, batch.sessionTitle);
      this.bus.emit('info', {
        payload: { title: batch.sessionTitle, session_id: this.sessionId },
      });
    }
    if (batch.stop) this.hookStop = batch.stop.reason;
  }
  /**
   * UserPromptSubmit hooks: each gets the person's message as written, before the model reads it. Not in a subagent,
   * whose first message is the task the model wrote.
   */
  private async promptHooks(
    prompt: string,
    signal: AbortSignal,
  ): Promise<HookBatch | undefined> {
    const runner = this.options.hooks;
    // A turn started only for messages that wait (after a compaction) has none of its own: they get theirs
    if (
      !prompt.trim() ||
      this.options.sessionHooks === false ||
      !runner?.has('UserPromptSubmit')
    )
      return undefined;
    return runner.run({
      event: 'UserPromptSubmit',
      ...this.hookBase(),
      fields: { prompt },
      signal,
    });
  }
  /** What a hook that kept a message from the model leaves in the conversation: the person sees why. */
  private blockedPrompt(prompt: string, batch: HookBatch): Message {
    for (const notice of batch.notices)
      if (notice.kind !== 'output' && notice.kind !== 'stopped')
        this.queueHook(notice);
    const reason = batch.blocked
      ? batch.reason || 'hook blocked'
      : batch.stop?.reason || 'hook stopped the turn';
    const notice: HookNotice = { kind: 'blocked', tool: 'prompt', reason };
    return {
      id: randomUUID(),
      role: 'user',
      internal: 'hook_notice',
      // The model learns only that a message was held back: not what it said, nor why
      content: `<system-reminder data-source="circle-hooks">\n${hookNoticeText({ kind: 'blocked', tool: 'prompt' })}\n</system-reminder>`,
      display:
        hookNoticeText(notice) +
        (batch.suppressOriginalPrompt ? '' : `\nOriginal prompt: ${prompt}`),
      hook: notice,
    };
  }
  /**
   * What hooks of an event said: their notices, and their words for the model as a reminder at this point of the
   * conversation. The first notice of an output carries the words; the others only name their hook.
   */
  hookContext(batch: HookBatch, event: HookEvent): void {
    const context = escapeReminder(batch.context);
    let told = !context;
    for (const notice of batch.notices) {
      if (notice.kind === 'output' && !told) {
        told = true;
        this.hookNotes.push({
          id: randomUUID(),
          role: 'user',
          internal: 'hook_notice',
          content: `<system-reminder data-source="circle-hooks">\n${event} hook additional context:\n${context}\n</system-reminder>`,
          display: hookNoticeText({
            ...notice,
            reason: notice.message || notice.reason,
          }),
          hook: notice,
        });
      } else this.queueHook(notice, notice.kind === 'output');
    }
    this.flushHookNotes();
    if (batch.sessionTitle && event === 'UserPromptSubmit') {
      this.options.store.rename(this.sessionId, batch.sessionTitle);
      this.bus.emit('info', {
        payload: { title: batch.sessionTitle, session_id: this.sessionId },
      });
    }
    if (batch.stop) this.hookStop = batch.stop.reason;
  }
  /**
   * Stop hooks, when the model ends a turn: a block, or words for the model, send it back to work. At most a few
   * times in a row; a tool call starts the count again.
   */
  private async blockStop(
    answer: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const runner = this.options.hooks;
    if (this.options.sessionHooks === false || !runner?.has('Stop'))
      return false;
    const batch = await runner.run({
      event: 'Stop',
      ...this.hookBase(),
      fields: {
        stop_hook_active: this.stopHookActive,
        last_assistant_message: answer,
        background_tasks: this.options.backgroundTasks?.() ?? [],
        session_crons: [],
      },
      signal,
    });
    for (const notice of batch.notices)
      if (notice.kind !== 'output') this.saveHook(notice);
    // `continue: false` comes before any block: the turn ends
    if (batch.stop || (!batch.blocked && !batch.context)) return false;
    if (this.stopContinuations >= stopHookCap()) {
      this.saveHook({
        kind: 'limit',
        name: batch.outcomes.map((item) => item.hook.name).join(', '),
      });
      return false;
    }
    this.stopContinuations++;
    this.stopHookActive = true;
    const reason = batch.reason || 'hook blocked stop';
    const notice: HookNotice = batch.blocked
      ? {
          kind: 'blocked',
          reason,
          ...(batch.userMessage ? { message: batch.userMessage } : {}),
        }
      : {
          kind: 'output',
          name: batch.outcomes
            .filter((item) => item.answer?.additionalContext)
            .map((item) => item.hook.name)
            .join(', '),
          reason: batch.context.split('\n')[0]?.slice(0, 200),
        };
    this.save({
      id: randomUUID(),
      role: 'user',
      internal: 'hook_notice',
      content: batch.blocked
        ? `<system-reminder data-source="circle-hooks">\nA hook blocked the end of this turn: ${escapeReminder(reason)}${batch.context ? `\n${escapeReminder(batch.context)}` : ''}\nFix the problem and finish the task. Do not stop while the hook blocks.\n</system-reminder>`
        : `<system-reminder data-source="circle-hooks">\nStop hook feedback:\n${escapeReminder(batch.context)}\n</system-reminder>`,
      display: hookNoticeText({
        ...notice,
        reason: notice.message || notice.reason,
      }),
      hook: notice,
    });
    return true;
  }
  private async gateTool(
    event: 'PreToolUse' | 'PermissionRequest',
    call: ToolCall,
    args: Record<string, unknown>,
    paths: string[],
    signal: AbortSignal,
    fields?: Record<string, unknown>,
  ): Promise<HookBatch | undefined> {
    if (!this.options.hooks?.has(event, this.options.agentHooks))
      return undefined;
    const batch = await this.options.hooks.run({
      event,
      ...this.hookBase(),
      toolName: call.name,
      toolInput: args,
      toolUseId: call.id,
      paths,
      ...(fields ? { fields } : {}),
      signal,
    });
    // Every deny's reason is in the tool result (`Hook denied this call:`). An ask's is not on every path.
    for (const notice of batch.notices)
      this.queueHook(
        notice,
        notice.kind === 'denied' || notice.kind === 'output',
      );
    if (batch.stop) this.hookStop ??= batch.stop.reason;
    return batch;
  }
  /** Who this harness's calls run for (#551): the conversation's session, and in a subagent its own as the agent's. */
  private identity(): CallIdentity {
    return this.options.agent
      ? { sessionId: this.options.agent.sessionId, agentId: this.sessionId }
      : { sessionId: this.sessionId };
  }
  /** A hook hears the conversation's session; in a subagent also which agent the call came from (#550). */
  private hookIdentity(): {
    sessionId: string;
    agent?: { id: string; type: string };
  } {
    return this.options.agent
      ? {
          sessionId: this.options.agent.sessionId,
          agent: { id: this.sessionId, type: this.options.agent.type },
        }
      : { sessionId: this.sessionId };
  }
  private hookSecrets(): Record<string, string> {
    return this.options.secrets?.() ?? {};
  }
  /** What background hooks said since the last request: for the model, not shown. */
  private deliverBackgroundHooks(): void {
    const identity = this.hookIdentity();
    const delivered =
      this.options.hooks?.takeDelivered(
        identity.sessionId,
        identity.agent?.id,
      ) ?? [];
    for (const item of delivered) {
      const text = [item.context, item.message].filter(Boolean).join('\n');
      if (!text) continue;
      this.save({
        id: randomUUID(),
        role: 'user',
        internal: 'hook_context',
        content: `<system-reminder data-source="circle-hooks">\nA background hook (${item.name}) said:\n${escapeReminder(text)}\n</system-reminder>`,
      });
    }
  }
  /** What PostToolUse and PostToolUseFailure hooks said, beside the result the model reads. */
  private afterToolHooks(batch: HookBatch, content: string): string {
    for (const notice of batch.notices)
      this.queueHook(notice, notice.kind === 'output');
    if (batch.stop) this.hookStop ??= batch.stop.reason;
    const said = [batch.blocked ? batch.reason : '', batch.context].filter(
      Boolean,
    );
    if (!said.length) return content;
    const names = batch.outcomes
      .filter(
        (item) =>
          item.answer?.additionalContext || item.answer?.block || item.blocking,
      )
      .map((item) => item.hook.name);
    return `${content}\n\n${HOOK_OUTPUT_LINE} (${[...new Set(names)].join(', ') || 'hook'}):\n${said.join('\n\n')}`;
  }
  /** A skill was loaded after the session's hooks were announced: its hooks run from now on. */
  skillHooksArmed(hooks: HookDefinition[]): void {
    if (!hooks.length || !this.hooksAnnounced || !this.options.hooks) return;
    this.saveHook({
      kind: 'active',
      count: hooks.length,
      reason: [...new Set(hooks.map((hook) => hook.skill ?? hook.name))].join(
        ', ',
      ),
    });
  }
  // A task call (its name as the tool table resolves it), whose subagent can run beside others, or a call of a tool
  // that says its calls may, as an MCP tool its server marks read-only.
  private parallel(call: ToolCall): boolean {
    try {
      const tool = prepareToolCall(call, this.offered()).tool;
      return tool.name === 'task' || tool.parallel === true;
    } catch {
      return false;
    }
  }
  async runCommandCall(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<{ message: Message; command: CommandResult | undefined }> {
    let command: CommandResult | undefined;
    const message = await this.runCall(call, signal, true, (result) => {
      command = result;
    });
    return { message, command };
  }
  // One call: checked, approved when it must be, and run. The result comes back to be stored
  // by the caller, which keeps the results in the order of the calls.
  private async runCall(
    original: ToolCall,
    signal: AbortSignal,
    quiet = false,
    onCommandResult?: (result: CommandResult) => void,
  ): Promise<Message> {
    const callModel = this.model;
    let call = original;
    let secrets: Record<string, string> = {};
    // A command or a page may show a secret back: the model and a workflow script read its name instead, for the
    // values the call used and the ones saved now, unless the person or the model wrote it
    const shown = (text: string): string =>
      this.redact(text, secrets, () => written(this.messages));
    let content = '';
    // Set when a before_tool hook rewrote the call: the tool result starts with it, whatever happens next
    let changedLine = '';
    let status: 'success' | 'error' = 'success';
    let recoverable = false;
    // What the tool hooks heard, and when the tool itself started: a failure after that is the tool's
    let hookArgs: Record<string, unknown> = {};
    let hookPaths: string[] = [];
    let ranAt: number | undefined;
    // What the PreToolUse hooks said, for their words beside the result
    let preHook: HookBatch | undefined;
    let attachments: MediaAttachment[] = [];
    let acceptingAttachments = true;
    let previousExecutionId: string | undefined;
    try {
      previousExecutionId = this.options.commandExecution?.forCall(
        this.sessionId,
        original.id,
      )?.executionId;
    } catch {
      /* Optional metadata cannot own tool execution. */
    }
    const modelCalls: ToolModelCall[] = [];
    if (!quiet) this.bus.emit('tool_call', { payload: { ...call } });
    try {
      signal.throwIfAborted();
      // The values go in once, before anything is decided: what is checked and approved is
      // what runs. The call the person sees and a rule keeps has plain variables' values and
      // secrets' names; a tool whose arguments a model reads keeps the names when it runs.
      // A before_tool hook's rewrite goes through all of this again before anything is decided.
      const check = (next: ToolCall, facts: readonly string[] = []) => {
        // What Circle works out for the card is Circle's to work out again, not a rewrite's to set
        const prepared = prepareToolCall(
          facts.length
            ? {
                ...next,
                args: Object.fromEntries(
                  Object.entries(next.args).filter(
                    ([key]) => !facts.includes(key),
                  ),
                ),
              }
            : next,
          this.offered(),
        );
        let call = prepared.call;
        const tool = prepared.tool;
        const variables =
          tool.variables === false ? {} : (this.options.variables?.() ?? {});
        const secrets =
          tool.variables === false || tool.variables === 'plain'
            ? {}
            : (this.options.secrets?.() ?? {});
        const used = new Set<string>();
        const raw = call.args;
        let resolved = expandVariables(raw, { ...variables, ...secrets }, used);
        call = { ...call, args: expandVariables(raw, variables) };
        const plain = call.args;
        // After the arguments were checked, from the values: the model cannot give these itself.
        // The rules judge them as they are; the card and the hooks see each secret's value
        // back as its name, as they see the arguments.
        const found = tool.approvalFacts?.(
          resolved,
          this.sessionId,
          call.args,
          callModel.imageInput,
        );
        if (found) {
          call = {
            ...call,
            args: { ...call.args, ...namedSecrets(found, secrets) },
          };
          resolved = { ...resolved, ...found };
        }
        const usedSecrets = [...used].filter((name) =>
          Object.hasOwn(secrets, name),
        );
        // What this call does, which can be more than what the tool does: a read that sends
        // a local file or a secret's value elsewhere asks, and read-only mode refuses it
        const effect = tool.callEffect?.(resolved, usedSecrets) ?? tool.effect;
        // The paths the hooks match: those Circle's own tools name, and the tool's own
        const paths = [
          ...new Set([
            ...hookToolPaths(call.name, resolved),
            ...(tool.paths?.(resolved) ?? []),
          ]),
        ];
        if (this.readOnlyRefuses(call, effect) && !tool.planAsks)
          throw new Error('read-only mode: this tool cannot run');
        // A command's effects are those of what it runs: a value can make it delete
        const review = this.options.policy.review(call.name, resolved);
        if (review.verdict === 'DENY')
          throw new Error(review.message || review.reason);
        return {
          call,
          tool,
          secrets,
          used,
          raw,
          plain,
          resolved,
          usedSecrets,
          effect,
          paths,
          found: review,
          facts: Object.keys(found ?? {}),
        };
      };
      let checked = check(call);
      secrets = checked.secrets;
      // Hooks see the arguments with secret values put back to %NAME%. A deny
      // stands in every approval mode. A hard denial above is not reconsidered.
      // An allow can skip an ordinary card only: an always-ask stays a card.
      const before = await this.gateTool(
        'PreToolUse',
        checked.call,
        checked.resolved,
        checked.paths,
        signal,
      );
      preHook = before;
      if (before?.decision === 'deny')
        throw new Error(hookDeniedMessage(before.reason || 'hook denied'));
      // Hooks that each rewrote the call differently leave no form it can run in
      if (before?.conflict.length)
        throw new Error(
          hookDeniedMessage(
            `hooks ${[...new Set(before.conflict)].join(', ')} each changed this call's input differently, so it does not run`,
          ),
        );
      // A hook rewrote the input: the call runs as rewritten, and so is checked, matched by the rules, shown on
      // the card and remembered, as if the model had sent it. Nothing on screen marks it (owner, 2026-11-14): only
      // the model is told what changed, at the start of the tool result.
      let secretAdded = false;
      if (before?.updatedInput) {
        const original = checked;
        const by = before.changedBy.join(', ');
        const saved = this.hookSecrets();
        // What the hooks were given: each secret's value as its name
        const shown = redactHookValue(original.resolved, saved);
        try {
          checked = check(
            {
              id: original.call.id,
              name: original.call.name,
              args: keepUnchanged(
                before.updatedInput,
                shown,
                original.raw,
              ) as Record<string, unknown>,
            },
            original.facts,
          );
        } catch (error) {
          throw new Error(
            `${HOOK_CHANGED_LINE} (${by}), and it cannot run: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const changed = changedArguments(original.plain, checked.plain);
        // Only a key order or a fact Circle works out again differs: the call is the model's
        if (!changed.length) checked = original;
        else {
          secrets = checked.secrets;
          // A secret the call did not carry is not a hook's to send: you see the call before it runs
          const named = (value: unknown) => {
            const text = JSON.stringify(value) ?? '';
            return Object.keys(saved).filter((name) =>
              text.includes(`%${name}%`),
            );
          };
          const carried = new Set(named(shown));
          secretAdded = named(before.updatedInput).some(
            (name) => !carried.has(name),
          );
          changedLine = hookChangedLine(by, changed, checked.plain);
        }
      }
      const { tool, used, raw, resolved, usedSecrets, effect, paths, found } =
        checked;
      call = checked.call;
      hookArgs = resolved;
      hookPaths = paths;
      if (before?.decision === 'ask') call = hookAsked(call, before);
      let hookLine = '';
      // A command the settings' allowed_commands patterns cover runs without
      // asking: in every mode, including the always-asking calls and the
      // headless run that cannot show a card. A hook deny already threw.
      // A hook ask forces the card, even in auto. A hook allow does not.
      const settingsAllowed = this.options.policy.allowedBySettings(
        call.name,
        call.args,
      );
      // In read-only mode a workflow asks as in manual mode, auto included: the person's yes or a rule starts it,
      // and a hook's allow alone does not
      const readOnlyWorkflow = call.name === 'workflow' && this.readOnly;
      // A first write to one of the person's terminal tabs asks as well, in every mode
      const alwaysAsk =
        secretAdded ||
        tool.personApproval === true ||
        found.verdict === 'ASK_FORCED' ||
        this.options.policy.tabAlwaysAsks(call.name, resolved) ||
        readOnlyWorkflow;
      const hookAsk = before?.decision === 'ask';
      const hookAllow = before?.decision === 'allow' && !alwaysAsk;
      const skillAllowed =
        !alwaysAsk &&
        this.options.skills?.allows(this.sessionId, tool.name, resolved) ===
          true;
      const preparedRun = tool.prepare
        ? await tool.prepare(resolved, {
            signal,
            sessionId: this.sessionId,
            callId: call.id,
            imageInput: this.model.imageInput,
          })
        : undefined;
      signal.throwIfAborted();
      // What the prepared call took (a file's size and digest) is what the card and the
      // events show for that argument; the call runs with what was taken
      if (preparedRun?.shown)
        call = {
          ...call,
          args: { ...call.args, ...namedSecrets(preparedRun.shown, secrets) },
        };
      const wouldAsk =
        secretAdded ||
        tool.personApproval === true ||
        // An ask rule, a critical delete: asked in every mode, whatever allows the call otherwise
        found.always ||
        (!settingsAllowed &&
          !skillAllowed &&
          !this.options.planFileMutation?.(call) &&
          effect !== 'read' &&
          tool.approval !== false &&
          (this.options.policy.needsApproval(
            call.name,
            resolved,
            this.options.approvalSessionId ?? this.sessionId,
            // In plan mode a tool that asks there asks as in manual mode, whatever mode is under it
            !(this.readOnly && tool.planAsks === true),
            readOnlyWorkflow ? 'manual' : this.approvalMode(),
          ) ||
            (this.options.headless && found.verdict === 'ASK_FORCED')));
      if (!hookAllow && (hookAsk || wouldAsk)) {
        const permission = await this.gateTool(
          'PermissionRequest',
          call,
          resolved,
          paths,
          signal,
          found.reason ? { permission_reason: found.reason } : undefined,
        );
        if (permission?.decision === 'deny') {
          if (permission.interrupt)
            this.hookStop ??= permission.reason || 'hook denied';
          throw new Error(
            hookDeniedMessage(permission.reason || 'hook denied'),
          );
        }
        // An allow that would run the call in another form is not applied: the card stays the person's
        const granted =
          permission?.decision === 'allow' &&
          !permission.updatedInput &&
          !permission.conflict.length;
        if (permission?.decision === 'allow' && !granted)
          this.queueHook({
            kind: 'message',
            name:
              [...permission.changedBy, ...permission.conflict].join(', ') ||
              'hook',
            reason:
              'allowed this call in another form, which Circle does not apply here, so the card asks you',
          });
        if (!granted || alwaysAsk) {
          // A subagent that does not ask refuses what would: only a rule, a setting or a hook lets a call through
          if (this.options.dontAsk?.())
            throw new Error(
              'not run: this subagent does not ask (permissionMode dontAsk), and no rule allows this call',
            );
          this.bus.emit('tool_waiting', {
            payload: {
              ...call,
              reason: call.hook_message || call.hook_reason || found.reason,
            },
          });
          if (!this.options.approve)
            throw new Error(
              found.verdict === 'ASK_FORCED'
                ? 'not run: this operation always asks'
                : readOnlyWorkflow
                  ? 'not run: in read-only mode a workflow starts only with your approval or a rule that allows it'
                  : 'not run: needs --yolo or approval',
            );
          const decision = await this.options.approve(call, signal);
          if (call.hook_reason)
            hookLine = `${HOOK_ASKED_LINE} ${call.hook_reason}`;
          signal.throwIfAborted();
          const reason =
            typeof decision === 'string' ? '' : decision.message.trim();
          if (
            !this.options.policy.remember(
              this.options.approvalSessionId ?? this.sessionId,
              call.name,
              call.args,
              typeof decision === 'string' ? decision : decision.decision,
            )
          )
            throw new Error(
              'The user rejected this tool call.' +
                (call.hook_reason ? ` A hook asked: ${call.hook_reason}` : '') +
                (reason ? ` The user said: ${reason}` : ''),
            );
        }
      }
      signal.throwIfAborted();
      if (this.readOnlyRefuses(call, effect) && !tool.planAsks)
        throw new Error('read-only mode: this tool cannot run');
      if (!quiet) this.bus.emit('tool_start', { payload: { ...call } });
      const args = resolved;
      const readOnlyCommand =
        this.approvalMode() === 'accept-edits'
          ? this.options.policy.readOnlyCommand(call.name, resolved)?.command
          : undefined;
      const context: ToolContext = {
        ...(onCommandResult
          ? {
              onCommandResult: (result) =>
                onCommandResult({
                  code: result.code,
                  output: shown(result.output).trimEnd(),
                }),
            }
          : {}),
        signal,
        ...(readOnlyCommand ? { readOnlyCommand } : {}),
        sessionId: this.sessionId,
        identity: this.identity(),
        callId: call.id,
        progress: (text) => {
          if (!quiet)
            this.bus.emit('tool_progress', { payload: { id: call.id, text } });
        },
        ...(used.size ? { rawArgs: structuredClone(raw) } : {}),
        ...(usedSecrets.length ? { secretNames: usedSecrets } : {}),
        imageInput: callModel.imageInput,
        ...(this.options.webSearch
          ? {
              webSearch: (query: string, numResults: number) =>
                this.options.webSearch!(callModel, query, numResults, context),
            }
          : {}),
        ...(this.options.vision
          ? {
              vision: (paths: string[], question: string) =>
                this.options.vision!(paths, question, context),
            }
          : {}),
        recordModelCall: (record) => {
          if (!acceptingAttachments)
            throw new Error('tool accounting channel is closed');
          modelCalls.push(structuredClone(record));
        },
        emitAttachments: (items: MediaAttachment[]) => {
          if (!acceptingAttachments)
            throw new Error('tool attachment channel is closed');
          signal.throwIfAborted();
          validateAttachments(items);
          if (
            callModel.imageInput === false &&
            items.some((item) => item.kind === 'image')
          )
            throw new Error(`${callModel.model} does not read images`);
          attachments.push(...structuredClone(items));
          validateAttachments(attachments);
        },
      };
      const guardedTool: Tool = {
        ...tool,
        run: async (args, context) => {
          const run = async () => {
            signal.throwIfAborted();
            if (this.readOnlyRefuses(call, effect) && !tool.planAsks)
              throw new Error('read-only mode: this tool cannot run');
            return (preparedRun ?? tool.run)(args, context);
          };
          return this.options.executeTool
            ? this.options.executeTool(tool, args, context, run)
            : run();
        },
      };
      ranAt = Date.now();
      const output = this.options.toolBoundary
        ? await this.options.toolBoundary(guardedTool, args, context)
        : await guardedTool.run(args, context);
      if (typeof output !== 'string') throw new Error('tool must return text');
      signal.throwIfAborted();
      const after = this.options.hooks?.has(
        'PostToolUse',
        this.options.agentHooks,
      )
        ? await this.options.hooks.run({
            event: 'PostToolUse',
            ...this.hookBase(),
            toolName: call.name,
            toolInput: args,
            toolUseId: call.id,
            paths,
            fields: { tool_response: output, duration_ms: Date.now() - ranAt },
            ...(this.options.hookScreenshot
              ? {
                  screenshot: (capture: AbortSignal) =>
                    this.options.hookScreenshot!(this.sessionId, capture),
                }
              : {}),
            signal,
          })
        : undefined;
      // A hook can put another text in place of the result the model reads; the tool has run all the same
      content = after?.updatedToolOutput ?? output;
      if (hookLine) content = `${hookLine}\n\n${content}`;
      if (after) content = this.afterToolHooks(after, content);
    } catch (error) {
      status = 'error';
      recoverable = error instanceof RecoverableToolError;
      attachments = [];
      content =
        error instanceof CommandFailure
          ? error.message
          : redact(error instanceof Error ? error.message : String(error));
      // The tool itself failed, not a check before it, and nobody stopped it: PostToolUseFailure hooks hear of it
      if (
        ranAt !== undefined &&
        !signal.aborted &&
        this.options.hooks?.has('PostToolUseFailure', this.options.agentHooks)
      ) {
        const failed = await this.options.hooks.run({
          event: 'PostToolUseFailure',
          ...this.hookBase(),
          toolName: call.name,
          toolInput: hookArgs,
          toolUseId: call.id,
          paths: hookPaths,
          fields: {
            error: content,
            is_interrupt: false,
            duration_ms: Date.now() - ranAt,
          },
          signal,
        });
        content = this.afterToolHooks(failed, content);
      }
    } finally {
      acceptingAttachments = false;
    }
    // What PreToolUse hooks said for the model goes beside the result, as what the hooks after the tool say does
    if (preHook?.context) {
      const names = preHook.outcomes
        .filter(
          (item) =>
            item.answer?.additionalContext &&
            item.answer.permissionDecision !== 'defer',
        )
        .map((item) => item.hook.name);
      content = `${content}\n\n${HOOK_OUTPUT_LINE} (${[...new Set(names)].join(', ') || 'hook'}):\n${preHook.context}`;
    }
    if (changedLine) content = `${changedLine}\n\n${content}`;
    content = shown(content);
    let commandExecutions: Message['commandExecutions'];
    try {
      const binding = this.options.commandExecution;
      const execution = binding?.forCall(this.sessionId, call.id);
      if (
        execution?.epoch === binding?.epoch &&
        execution?.executionSessionId === this.sessionId &&
        execution.toolCallId === call.id &&
        execution.executionId !== previousExecutionId
      ) {
        const receipt = commandExecutionReceipt(execution);
        if (receipt) commandExecutions = [receipt];
      }
    } catch {
      /* A metadata observer cannot change a real command's result. */
    }
    const toolUsage = emptyUsage();
    for (const record of modelCalls) addUsage(toolUsage, record.usage);
    return {
      id: randomUUID(),
      role: 'tool',
      content,
      tool_call_id: call.id,
      name: call.name,
      status,
      ...(modelCalls.length
        ? { model_calls: modelCalls, usage: toolUsage }
        : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(recoverable ? { recoverable: true } : {}),
      ...(commandExecutions ? { commandExecutions } : {}),
    };
  }
  // The result of a call goes into the conversation and onto the bus.
  private finishCall(result: Message): void {
    this.save(result);
    const status = result.status ?? 'success';
    this.bus.emit('tool_result', {
      payload: {
        id: result.tool_call_id,
        name: result.name,
        status,
        output: result.content,
        ...(result.commandExecutions
          ? { commandExecutions: result.commandExecutions }
          : {}),
        ...(result.model_calls?.length
          ? { model_calls: structuredClone(result.model_calls) }
          : {}),
      },
      ...(result.usage ? { usage: { ...result.usage } } : {}),
    });
    this.bus.emit('tool_end', { payload: { id: result.tool_call_id, status } });
  }
}
