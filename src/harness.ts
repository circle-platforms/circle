import { randomUUID } from 'node:crypto';
import type {
  ChatModel,
  Message,
  Tool,
  ToolCall,
  Usage,
  MediaAttachment,
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
  secretRedactor,
  written,
  type Redactor,
} from './secrets.js';
import { httpStatus } from './model_guard.js';
import { validateAttachments } from './media.js';
import { readPrompt } from './system_prompt.js';
import {
  acceptGeneratedTitle,
  fallbackTitle,
  TITLE_MAX_TOKENS,
  titleConversation,
  titleSkipReason,
} from './session_title.js';

/** `CIRCLE_DEBUG=1` prints why a title was skipped or rejected. */
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
  beforeTurn?: () => void;
  beforeStep?: () => void;
  priceUsage?: (
    model: string,
    usage: Usage,
  ) => import('./pricing.js').PriceReceipt;
  toolBoundary?: (
    tool: Tool,
    args: Record<string, unknown>,
    context: import('./types.js').ToolContext,
  ) => Promise<string>;
  prepareMessages?: (signal: AbortSignal) => Promise<Message[]>;
  approvalSessionId?: string;
  parentPlanMode?: () => boolean;
  planFileMutation?: (call: ToolCall) => boolean;
}
/** A message that waits for the model, as the input box showed it. */
export interface QueuedMessage {
  message: string;
  display: string;
  pastes?: Record<string, string>;
}
export class Harness {
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
  /** How the input box showed a prompt the model reads in full: long pastes stay folded on screen. */
  readonly shown = new Map<
    string,
    {
      display: string;
      pastes?: Record<string, string>;
      attachments?: MediaAttachment[];
    }
  >();
  private active?: Promise<{ answer: string; usage: Usage }>;
  /** Set once the fallback is saved. Sent after the turn so it does not share that request. */
  private pendingTitle?: { display: string; fallback: string };
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
    options.store.repairInterrupted(this.sessionId);
  }
  get busy(): boolean {
    return Boolean(this.active);
  }
  get pendingMessageCount(): number {
    return this.steering.length + this.followUps.length;
  }
  get messages(): Message[] {
    return this.options.store.messages(this.sessionId);
  }
  private get readOnly(): boolean {
    return this.planMode || this.options.parentPlanMode?.() === true;
  }
  queue(
    message: string,
    mode: 'steer' | 'followUp' = 'steer',
    attachments?: MediaAttachment[],
  ): void {
    if (attachments?.length) {
      validateAttachments(attachments);
      this.shown.set(message, {
        display: message,
        attachments: structuredClone(attachments),
      });
    }
    (mode === 'steer' ? this.steering : this.followUps).push(message);
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
    const [message] = queue.splice(index, 1);
    if (![...this.steering, ...this.followUps].includes(message!))
      this.shown.delete(message!);
    return message!;
  }
  /** The waiting messages as the input box showed them (long pastes and images folded). */
  get queuedShown(): { steering: string[]; followUp: string[] } {
    const shown = (message: string) =>
      this.shown.get(message)?.display ?? message;
    return {
      steering: this.steering.map(shown),
      followUp: this.followUps.map(shown),
    };
  }
  /**
   * Take back messages the model has not read, as the box showed them: the last one listed
   * (the last follow-up, else the last steering message), or `all` of them in list order.
   */
  takeBack(all = false): QueuedMessage[] {
    const taken = all
      ? [...this.steering.splice(0), ...this.followUps.splice(0)]
      : this.followUps.length
        ? this.followUps.splice(-1)
        : this.steering.splice(-1);
    return taken.map((message) => {
      const shown = this.shown.get(message);
      this.shown.delete(message);
      return {
        message,
        display: shown?.display ?? message,
        ...(shown?.pastes ? { pastes: shown.pastes } : {}),
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
    const result = {
      steering: this.steering.splice(0),
      followUp: this.followUps.splice(0),
    };
    for (const message of [...result.steering, ...result.followUp])
      this.shown.delete(message);
    return result;
  }
  // Stop the turn. `keepQueue`, as esc in 0.5.0: the messages it had not read yet stay, each
  // to be sent as a turn of its own (the steering ones first), and nothing starts them here.
  async cancel(options: { keepQueue?: boolean } = {}): Promise<void> {
    if (options.keepQueue) this.followUps.unshift(...this.steering.splice(0));
    else {
      this.followUps = [];
      this.steering = [];
      this.shown.clear();
    }
    this.controller?.abort(new Error('Interrupted'));
    try {
      await this.active;
    } catch {
      /* run_error and persisted results record the stop. */
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
    this.shown.delete(prompt);
    if (!shown) return { display: prompt };
    return {
      display: shown.display,
      ...(shown.pastes ? { pastes: shown.pastes } : {}),
    };
  }
  // `display` is what the conversation shows for the prompt when it differs from the text
  // the model gets (`circle "question" @file`).
  async run(
    prompt?: string,
    display?: string,
    attachments?: MediaAttachment[],
  ): Promise<{ answer: string; usage: Usage }> {
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
      this.options.beforeTurn?.();
      signal.throwIfAborted();
      const next = first
        ? (prompt ?? this.steering.shift() ?? this.followUps.shift())
        : this.followUps.shift();
      const result = await this.runTurn(next, signal);
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
   * Ask the model for a short title after the fallback is already saved. A scripted model
   * never sees this call. A rename that landed first is left alone. The request disables
   * thinking: glm-5.3 still reasons when the field is omitted. Reasoning text is
   * not a title. The prompt is wrapped as data, and a reply that answers the
   * user is discarded.
   */
  private generateTitle(display: string, fallback: string): void {
    // `this.model`, not the model passed at construction: /model and a reload replace it.
    const model = this.model;
    const prompt = display.trim();
    const report = (message: string): void => {
      titleTrace(`failed: ${message}`);
      this.bus.emit('info', {
        payload: { model_notice: { event: 'title_failed', message } },
      });
    };
    // A short line keeps the fallback. A long line with no side request used
    // to return here with no footer: the extension wrapper had dropped
    // `sideRequests`. Either way the footer says why.
    const skip = titleSkipReason(prompt, model.sideRequests);
    if (skip) {
      titleTrace(`skipped (${skip})`);
      report(skip);
      return;
    }
    titleTrace(
      `request model=${model.model} chars=${prompt.length} maxTokens=${Harness.titleOutputTokens} thinking=disabled`,
    );
    void model
      .complete({
        system: readPrompt('agent', 'title.md'),
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
      })
      .then((response) => {
        // Reasoning is never a title, even when the answer is empty.
        const decision = acceptGeneratedTitle(response.message.content, prompt);
        if (!decision.title) {
          titleTrace(`discarded (${decision.reason})`);
          report(decision.reason);
          return;
        }
        const title = decision.title;
        const current = this.options.store.get(this.sessionId);
        if (!current || current.title !== fallback) {
          titleTrace(
            `discarded ${JSON.stringify(title)} (session title is ${JSON.stringify(current?.title ?? '')})`,
          );
          return;
        }
        this.options.store.rename(this.sessionId, title);
        titleTrace(`renamed to ${JSON.stringify(title)}`);
        this.bus.emit('info', { payload: { title } });
      })
      .catch((error: unknown) => {
        // The fallback title stays. A side request must not fail the turn.
        report(error instanceof Error ? error.message : String(error));
      });
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
  ): Promise<{ answer: string; usage: Usage }> {
    const start = Date.now();
    const usage = emptyUsage();
    let answer = '';
    const given =
      prompt === undefined ? undefined : this.shown.get(prompt)?.attachments;
    const shown = prompt === undefined ? undefined : this.shownAs(prompt);
    if (prompt !== undefined)
      this.save({
        id: randomUUID(),
        role: 'user',
        ...(await this.attach(
          prompt,
          this.options.session.workspace,
          signal,
          given,
        )),
        ...shown,
      });
    const session = this.options.store.get(this.sessionId)!;
    if (!session.title && shown?.display !== undefined) {
      const fallback = fallbackTitle(shown.display);
      this.options.store.rename(this.sessionId, fallback);
      this.bus.emit('info', { payload: { title: fallback } });
      this.pendingTitle = { display: shown.display, fallback };
    }
    this.bus.emit('run_start', { payload: { message: prompt } });
    try {
      for (let step = 0; step < (this.options.maxSteps ?? 9999); step++) {
        signal.throwIfAborted();
        // The step starts here: a steerNow while the messages before are read stops it
        const stepControl = new AbortController();
        this.step = stepControl;
        const stepSignal = AbortSignal.any([signal, stepControl.signal]);
        // One at a time, each left waiting until it is stored: one that fails, or is taken
        // back while its files are read, does not take the others with it
        while (this.steering.length) {
          const message = this.steering[0]!;
          const content = await this.attach(
            message,
            session.workspace,
            signal,
            this.shown.get(message)?.attachments,
          );
          const at = this.steering.indexOf(message);
          if (at < 0) continue;
          this.steering.splice(at, 1);
          this.save({
            id: randomUUID(),
            role: 'user',
            ...content,
            ...this.shownAs(message),
          });
          this.bus.emit('steer', { payload: { message } });
        }
        this.options.beforeStep?.();
        try {
          stepSignal.throwIfAborted();
          this.bus.emit('llm_start');
          const response = await this.model.complete({
            system:
              this.system +
              (this.readOnly
                ? this.options.planFileMutation
                  ? '\nRead-only mode: inspect and plan; only plan.md or plan files may be changed, subject to approval. Do not run shell commands.'
                  : '\nRead-only mode: inspect and plan; do not change files or run commands.'
                : ''),
            messages: this.options.prepareMessages
              ? await this.options.prepareMessages(signal)
              : this.options.store.projectedMessages(this.sessionId),
            tools: this.tools,
            signal: stepSignal,
            notice: (event) =>
              this.bus.emit('info', { payload: { model_notice: event } }),
            token: (text, thinking) =>
              this.bus.emit('llm_token', {
                payload: { text, thinking: Boolean(thinking) },
              }),
          });
          stepSignal.throwIfAborted();
          const message = {
            ...response.message,
            request_model: this.model.model,
            usage: response.usage,
            cost:
              response.message.cost ??
              this.options.priceUsage?.(
                response.message.model || this.model.model,
                response.usage,
              ),
          };
          this.save(message);
          addUsage(usage, response.usage);
          this.bus.emit('llm_end', {
            payload: { message },
            usage: { ...response.usage },
          });
          const calls = response.message.tool_calls ?? [];
          if (!calls.length) {
            answer = response.message.content;
            if (!answer.trim())
              throw new Error('model ended without an answer');
            if (this.steering.length) continue;
            this.bus.emit('run_end', {
              payload: { answer },
              usage: { ...usage },
              elapsed_ms: Date.now() - start,
            });
            this.flushTitle();
            return { answer, usage };
          }
          // As in 0.5.0, the subagents of task calls next to each other run at the same time;
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
                while (results[stored]) this.finishCall(results[stored++]!);
              }),
            );
            for (const outcome of settled)
              if (outcome.status === 'rejected') throw outcome.reason;
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
        },
        usage: { ...usage },
        elapsed_ms: Date.now() - start,
      });
      throw failure;
    }
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
    let call = original;
    let secrets: Record<string, string> = {};
    let content = '';
    let status: 'success' | 'error' = 'success';
    let recoverable = false;
    let attachments: MediaAttachment[] = [];
    let acceptingAttachments = true;
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
      // After the arguments were checked, from the values: the model cannot give these itself
      const facts = tool.approvalFacts?.(resolved, this.sessionId);
      if (facts) {
        call = { ...call, args: { ...call.args, ...facts } };
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
      // A command the settings' allowed_commands patterns cover runs without
      // asking: in every mode, including the always-asking calls and the
      // headless run that cannot show a card.
      const settingsAllowed = this.options.policy.allowedBySettings(
        call.name,
        call.args,
      );
      if (
        !settingsAllowed &&
        tool.effect !== 'read' &&
        tool.approval !== false &&
        (this.options.policy.needsApproval(
          call.name,
          resolved,
          this.options.approvalSessionId ?? this.sessionId,
        ) ||
          (this.options.headless && found.verdict === 'ASK_FORCED'))
      ) {
        this.bus.emit('tool_waiting', {
          payload: { ...call, reason: found.reason },
        });
        if (!this.options.approve)
          throw new Error(
            found.verdict === 'ASK_FORCED'
              ? 'not run: this operation always asks'
              : 'not run: needs --yolo or approval',
          );
        const decision = await this.options.approve(call, signal);
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
              (reason ? ` The user said: ${reason}` : ''),
          );
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
      const context = {
        signal,
        sessionId: this.sessionId,
        callId: call.id,
        ...(used.size ? { rawArgs: structuredClone(raw) } : {}),
        ...(usedSecrets.length ? { secretNames: usedSecrets } : {}),
        imageInput: this.model.imageInput,
        emitAttachments: (items: MediaAttachment[]) => {
          if (!acceptingAttachments)
            throw new Error('tool attachment channel is closed');
          signal.throwIfAborted();
          validateAttachments(items);
          if (
            this.model.imageInput === false &&
            items.some((item) => item.kind === 'image')
          )
            throw new Error(`${this.model.model} does not read images`);
          attachments.push(...structuredClone(items));
          validateAttachments(attachments);
        },
      };
      const guardedTool: Tool = {
        ...tool,
        run: async (args, context) => {
          signal.throwIfAborted();
          if (
            this.readOnly &&
            tool.effect !== 'read' &&
            !this.options.planFileMutation?.(call)
          )
            throw new Error('read-only mode: this tool cannot run');
          return tool.run(args, context);
        },
      };
      content = this.options.toolBoundary
        ? await this.options.toolBoundary(guardedTool, args, context)
        : await guardedTool.run(args, context);
      if (typeof content !== 'string') throw new Error('tool must return text');
      signal.throwIfAborted();
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
    return {
      id: randomUUID(),
      role: 'tool',
      content,
      tool_call_id: call.id,
      name: call.name,
      status,
      ...(attachments.length ? { attachments } : {}),
      ...(recoverable ? { recoverable: true } : {}),
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
      },
    });
    this.bus.emit('tool_end', { payload: { id: result.tool_call_id, status } });
  }
}
