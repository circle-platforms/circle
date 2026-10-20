import { randomUUID } from 'node:crypto';
import { orderModeToolResults } from './tool_history.js';
import type {
  ChatModel,
  Message,
  Tool,
  ToolCall,
  Usage,
  MediaAttachment,
  ToolContext,
  ToolModelCall,
} from './types.js';
import { emptyUsage, addUsage } from './types.js';
import { EventBus } from './events.js';
import { ApprovalPolicy, wildcard } from './approvals.js';
import { CheckpointStore, type Session } from './checkpoint_store.js';
import { attachPrompt } from './mentions.js';
import { prepareToolCall, RecoverableToolError } from './tool_call_compat.js';
import { redact } from './redact.js';
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
  ModelCompletionFailure,
} from './model_completion.js';
import {
  activeHookSummary,
  hookDeniedMessage,
  hookFileLabel,
  hookNoticeText,
  hookToolPaths,
  HOOK_ALLOWED_LINE,
  HOOK_ASKED_LINE,
  HOOK_OUTPUT_LINE,
  type HookBatch,
  type HookDefinition,
  type HookNotice,
  type HookRunner,
} from './hooks.js';
import type {
  InputPayload,
  StoredInput,
  ResolveInputsRequest,
  ResolveInputsResult,
} from './input_outbox.js';
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
  planFileMutation?: (call: ToolCall) => boolean;
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
  /** False for a subagent: tool hooks still run, session start and stop do not. */
  sessionHooks?: boolean;
}
/** A message that waits for the model, as the input box showed it. */
export interface QueuedMessage {
  message: string;
  display: string;
  pastes?: Record<string, string>;
  attachments?: MediaAttachment[];
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

export class Harness {
  /** Text from session_start, added to the system prompt without replacing it. */
  hookPreface = '';
  private hooksAnnounced = false;
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
  private get readOnly(): boolean {
    return this.planMode || this.options.parentPlanMode?.() === true;
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
  /** Let in-flight titles finish. Closing calls this before the store goes. */
  async finishTitle(): Promise<void> {
    await Promise.all([...this.titleTasks]);
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
    const { message, leftOut, problems } = await attachPrompt(
      prompt,
      workspace,
      signal,
      (path) => this.promptFileAllowed(path),
      this.model.imageInput !== false,
      given,
    );
    if (leftOut)
      this.bus.emit('info', {
        payload: {
          model_notice: {
            event: 'images_left_out',
            model: this.model.model,
            count: leftOut,
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
        signal: AbortSignal.timeout(20_000),
        // `''` asks the Anthropic body for `thinking: {type: 'disabled'}`.
        // `minimal` is sent as output_config.effort and glm rejects it.
        effort: '',
        maxTokens: Harness.titleOutputTokens,
        token: () => {},
      });
    // One retry for a dropped connection. A second failure is reported once.
    const call = async (text: string) => {
      try {
        return await ask(text);
      } catch (error) {
        if (!isNetworkFailure(error)) throw error;
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
    for (const tool of this.tools)
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
    if (prompt !== undefined) {
      const content = await this.attach(
        prompt,
        this.options.session.workspace,
        signal,
        given,
      );
      if (queued) {
        if (
          this.inputIds(queued.kind)[0] !== queued.id ||
          JSON.stringify(this.input(queued.id).payload) !==
            JSON.stringify(queued.payload)
        ) {
          const next = this.nextQueued(queued.kind);
          return next
            ? this.runTurn(next.payload.text, signal, next)
            : { answer: '', usage: emptyUsage() };
        }
        this.consumeInput(queued, content);
      } else
        this.save({ id: randomUUID(), role: 'user', ...content, ...shown });
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
    try {
      for (let step = 0; step < (this.options.maxSteps ?? 9999); step++) {
        signal.throwIfAborted();
        if (step === 0) await this.announceHooks(signal);
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
          this.consumeInput(input, content);
          this.bus.emit('steer', { payload: { message } });
        }
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
          const response = await this.model.complete({
            system:
              this.system +
              (this.hookPreface ? `\n\n${this.hookPreface}` : '') +
              (this.readOnly
                ? this.options.planFileMutation
                  ? '\nRead-only mode: inspect and plan; only plan.md or plan files may be changed, subject to approval. Do not run shell commands.'
                  : '\nRead-only mode: inspect and plan; do not change files or run commands.'
                : ''),
            messages: orderModeToolResults(
              this.options.prepareMessages
                ? await this.options.prepareMessages(signal)
                : this.options.store.projectedMessages(this.sessionId),
            ),
            tools: this.tools,
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
          });
          stepSignal.throwIfAborted();
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
            if (await this.blockStop(signal)) continue;
            this.bus.emit('run_end', {
              payload: { answer },
              usage: { ...usage },
              elapsed_ms: Date.now() - start,
            });
            this.flushTitle();
            return { answer, usage };
          }
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
      this.bus.emit('run_error', {
        payload: {
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
        },
        usage: { ...usage },
        elapsed_ms: Date.now() - start,
      });
      throw failure;
    }
  }
  private queueHook(notice: HookNotice): void {
    const text = hookNoticeText(notice);
    // A failed hook's error text is for the person; the model only learns it failed.
    const told =
      notice.kind === 'failed'
        ? hookNoticeText({ ...notice, reason: undefined })
        : text;
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
  private saveHook(notice: HookNotice): void {
    this.queueHook(notice);
    this.flushHookNotes();
  }
  private async announceHooks(signal: AbortSignal): Promise<void> {
    if (this.hooksAnnounced || this.options.sessionHooks === false) return;
    this.hooksAnnounced = true;
    const runner = this.options.hooks;
    if (!runner) return;
    const loaded = runner.loaded;
    if (loaded.projectIgnored) this.saveHook({ kind: 'untrusted' });
    if (loaded.projectChanged.length) this.saveHook({ kind: 'changed' });
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
    if (!running.some((hook) => hook.event === 'session_start')) return;
    const batch = await runner.run({
      event: 'session_start',
      sessionId: this.sessionId,
      cwd: this.options.session.workspace,
      secrets: this.hookSecrets(),
      signal,
    });
    for (const notice of batch.notices) this.saveHook(notice);
    if (batch.context)
      this.hookPreface = `Hook session_start output:\n${batch.context}`;
  }
  private async blockStop(signal: AbortSignal): Promise<boolean> {
    if (this.options.sessionHooks === false || !this.options.hooks)
      return false;
    const batch = await this.options.hooks.run({
      event: 'before_stop',
      sessionId: this.sessionId,
      cwd: this.options.session.workspace,
      secrets: this.hookSecrets(),
      signal,
    });
    for (const notice of batch.notices) this.saveHook(notice);
    if (batch.decision !== 'deny') return false;
    const reason = batch.reason || 'hook blocked stop';
    this.save({
      id: randomUUID(),
      role: 'user',
      internal: 'hook_notice',
      content: `<system-reminder data-source="circle-hooks">\nA hook blocked the end of this turn: ${reason}\nFix the problem and finish the task. Do not stop while the hook blocks.\n</system-reminder>`,
      display: hookNoticeText({ kind: 'blocked', reason }),
      hook: { kind: 'blocked', reason },
    });
    return true;
  }
  private async gateTool(
    event: 'before_tool' | 'permission_request',
    call: ToolCall,
    args: Record<string, unknown>,
    signal: AbortSignal,
    permissionReason?: string,
  ): Promise<HookBatch | undefined> {
    if (!this.options.hooks) return undefined;
    const batch = await this.options.hooks.run({
      event,
      sessionId: this.sessionId,
      cwd: this.options.session.workspace,
      toolName: call.name,
      toolInput: args,
      paths: hookToolPaths(call.name, args),
      permissionReason,
      secrets: this.hookSecrets(),
      signal,
    });
    for (const notice of batch.notices) this.queueHook(notice);
    return batch;
  }
  private hookSecrets(): Record<string, string> {
    return this.options.secrets?.() ?? {};
  }
  /**
   * A skill was loaded after the session's hooks were announced. Its hooks
   * start now, and a session_start hook it ships runs once.
   */
  async skillHooksArmed(
    hooks: HookDefinition[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!hooks.length || !this.hooksAnnounced || !this.options.hooks) return;
    this.saveHook({
      kind: 'active',
      count: hooks.length,
      reason: [...new Set(hooks.map((hook) => hook.skill ?? hook.name))].join(
        ', ',
      ),
    });
    const starting = hooks.filter((hook) => hook.event === 'session_start');
    if (!starting.length) return;
    const batch = await this.options.hooks.run({
      event: 'session_start',
      sessionId: this.sessionId,
      cwd: this.options.session.workspace,
      secrets: this.hookSecrets(),
      onlyIds: starting.map((hook) => hook.id),
      signal,
    });
    for (const notice of batch.notices) this.saveHook(notice);
    if (batch.context)
      this.hookPreface = this.hookPreface
        ? `${this.hookPreface}\n\n${batch.context}`
        : `Hook session_start output:\n${batch.context}`;
  }
  // A task call (its name as the tool table resolves it): its subagent can run beside others.
  private parallel(call: ToolCall): boolean {
    try {
      return prepareToolCall(call, this.tools).tool.name === 'task';
    } catch {
      return false;
    }
  }
  // One call: checked, approved when it must be, and run. The result comes back to be stored
  // by the caller, which keeps the results in the order of the calls.
  private async runCall(
    original: ToolCall,
    signal: AbortSignal,
  ): Promise<Message> {
    const callModel = this.model;
    let call = original;
    let secrets: Record<string, string> = {};
    let content = '';
    let status: 'success' | 'error' = 'success';
    let recoverable = false;
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
    this.bus.emit('tool_call', { payload: { ...call } });
    try {
      signal.throwIfAborted();
      const prepared = prepareToolCall(call, this.tools);
      call = prepared.call;
      const tool = prepared.tool;
      // The values go in once, before anything is decided: what is checked and approved is
      // what runs. The call the person sees and a rule keeps has plain variables' values and
      // secrets' names; a tool whose arguments a model reads keeps the names when it runs.
      const variables =
        tool.variables === false ? {} : (this.options.variables?.() ?? {});
      secrets =
        tool.variables === false || tool.variables === 'plain'
          ? {}
          : (this.options.secrets?.() ?? {});
      const used = new Set<string>();
      const raw = call.args;
      let resolved = expandVariables(raw, { ...variables, ...secrets }, used);
      call = { ...call, args: expandVariables(raw, variables) };
      // After the arguments were checked, from the values: the model cannot give these itself.
      // The rules judge them as they are; the card and the hooks see each secret's value
      // back as its name, as they see the arguments.
      const facts = tool.approvalFacts?.(resolved, this.sessionId, call.args);
      if (facts) {
        call = {
          ...call,
          args: { ...call.args, ...namedSecrets(facts, secrets) },
        };
        resolved = { ...resolved, ...facts };
      }
      if (
        this.readOnly &&
        tool.effect !== 'read' &&
        !this.options.planFileMutation?.(call)
      )
        throw new Error('read-only mode: this tool cannot run');
      // A command's effects are those of what it runs: a value can make it delete
      const found = this.options.policy.review(call.name, resolved);
      if (found.verdict === 'DENY')
        throw new Error(found.message || found.reason);
      // Hooks see the arguments with secret values put back to %NAME%. A deny
      // stands in every approval mode. A hard denial above is not reconsidered.
      // An allow can skip an ordinary card only: an always-ask stays a card.
      const before = await this.gateTool('before_tool', call, resolved, signal);
      if (before?.decision === 'deny')
        throw new Error(hookDeniedMessage(before.reason || 'hook denied'));
      if (before?.decision === 'ask' && before.reason)
        call = { ...call, hook_reason: before.reason };
      let hookLine = '';
      // A command the settings' allowed_commands patterns cover runs without
      // asking: in every mode, including the always-asking calls and the
      // headless run that cannot show a card. A hook deny already threw.
      // A hook ask forces the card, even in auto. A hook allow does not.
      const settingsAllowed = this.options.policy.allowedBySettings(
        call.name,
        call.args,
      );
      // A first write to one of the person's terminal tabs asks as well, in every mode
      const alwaysAsk =
        found.verdict === 'ASK_FORCED' ||
        this.options.policy.tabAlwaysAsks(call.name, resolved);
      const hookAsk = before?.decision === 'ask';
      const hookAllow = before?.decision === 'allow' && !alwaysAsk;
      if (hookAllow) hookLine = HOOK_ALLOWED_LINE;
      const preparedRun = tool.prepare
        ? await tool.prepare(resolved, {
            signal,
            sessionId: this.sessionId,
            callId: call.id,
            imageInput: this.model.imageInput,
          })
        : undefined;
      signal.throwIfAborted();
      const wouldAsk =
        !settingsAllowed &&
        tool.effect !== 'read' &&
        tool.approval !== false &&
        (this.options.policy.needsApproval(
          call.name,
          resolved,
          this.options.approvalSessionId ?? this.sessionId,
        ) ||
          (this.options.headless && found.verdict === 'ASK_FORCED'));
      if (!hookAllow && (hookAsk || wouldAsk)) {
        const permission = await this.gateTool(
          'permission_request',
          call,
          resolved,
          signal,
          found.reason,
        );
        if (permission?.decision === 'deny')
          throw new Error(
            hookDeniedMessage(permission.reason || 'hook denied'),
          );
        if (permission?.decision === 'ask' && permission.reason)
          call = { ...call, hook_reason: permission.reason };
        if (permission?.decision === 'allow' && !alwaysAsk && !hookAsk) {
          hookLine = HOOK_ALLOWED_LINE;
        } else {
          this.bus.emit('tool_waiting', {
            payload: { ...call, reason: call.hook_reason || found.reason },
          });
          if (!this.options.approve)
            throw new Error(
              found.verdict === 'ASK_FORCED'
                ? 'not run: this operation always asks'
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
      if (
        this.readOnly &&
        tool.effect !== 'read' &&
        !this.options.planFileMutation?.(call)
      )
        throw new Error('read-only mode: this tool cannot run');
      this.bus.emit('tool_start', { payload: { ...call } });
      const args = resolved;
      const usedSecrets = [...used].filter((name) =>
        Object.hasOwn(secrets, name),
      );
      const context: ToolContext = {
        signal,
        sessionId: this.sessionId,
        callId: call.id,
        ...(used.size ? { rawArgs: structuredClone(raw) } : {}),
        ...(usedSecrets.length ? { secretNames: usedSecrets } : {}),
        imageInput: callModel.imageInput,
        ...(this.options.webSearch
          ? {
              webSearch: (query: string, numResults: number) =>
                this.options.webSearch!(callModel, query, numResults, context),
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
            if (
              this.readOnly &&
              tool.effect !== 'read' &&
              !this.options.planFileMutation?.(call)
            )
              throw new Error('read-only mode: this tool cannot run');
            return (preparedRun ?? tool.run)(args, context);
          };
          return this.options.executeTool
            ? this.options.executeTool(tool, args, context, run)
            : run();
        },
      };
      content = this.options.toolBoundary
        ? await this.options.toolBoundary(guardedTool, args, context)
        : await guardedTool.run(args, context);
      if (typeof content !== 'string') throw new Error('tool must return text');
      signal.throwIfAborted();
      if (hookLine) content = `${hookLine}\n\n${content}`;
      const after = this.options.hooks
        ? await this.options.hooks.run({
            event: 'after_tool',
            sessionId: this.sessionId,
            cwd: this.options.session.workspace,
            toolName: call.name,
            toolInput: args,
            paths: hookToolPaths(call.name, args),
            toolOutput: content,
            toolStatus: 'success',
            secrets: this.hookSecrets(),
            signal,
          })
        : undefined;
      if (after) {
        for (const notice of after.notices) this.queueHook(notice);
        const reported = after.outcomes.filter((item) => item.context);
        if (reported.length)
          content += `\n\n${HOOK_OUTPUT_LINE} (${reported
            .map((item) => item.hook.name)
            .join(', ')}):\n${after.context}`;
      }
    } catch (error) {
      status = 'error';
      recoverable = error instanceof RecoverableToolError;
      attachments = [];
      content = redact(error instanceof Error ? error.message : String(error));
    } finally {
      acceptingAttachments = false;
    }
    // A command or a page may show a secret back: the model reads its name instead, for the
    // values the call used and the ones saved now, unless the person or the model wrote it
    content = this.redact(content, secrets, () => written(this.messages));
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
