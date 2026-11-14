import { createHash, createHmac, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatCompletionMessageParam,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import type {
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type {
  CacheControlEphemeral,
  ContentBlockParam,
  MessageParam,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  ChatModel,
  Message,
  ModelRequest,
  ModelResponse,
  ModelCompletion,
  ToolCall,
} from './types.js';
import { emptyUsage } from './types.js';
import { commandExecutionModelContent } from './command_process.js';
import { loadCredentials, type CircleSettings } from './settings.js';
import {
  ModelGuard,
  MissingFinish,
  TextRepetitionLoop,
  type GuardOptions,
  isThinkingSignatureError,
  isEncryptedReasoningError,
} from './model_guard.js';
import { apiFamily, CHATGPT_PROTOCOL, speaksResponses } from './protocols.js';
import { zstdCompressSync } from 'node:zlib';
import {
  chatgptAccessToken,
  chatgptIdentityIfSignedIn,
  ChatGPTSignInError,
  planFailureMessage,
} from './chatgpt_plan.js';
import { parseToolInput } from './tool_call_compat.js';
import { isRecord } from './settings.js';
import { desktopText } from './locale.js';
import { circleHome } from './paths.js';
import { ModelCatalog, type ModelFacts } from './model_catalog.js';
import {
  modelProfile,
  fitEffort,
  THINKING_BUDGET,
  supportsThinkingDisplay,
} from './model_profiles.js';
import { priceCall } from './pricing.js';
import { isNetworkFailure, networkError, networkErrorReason } from './net.js';
import {
  checkRequestMedia,
  endpointRefusesImages,
  leaveOutImages,
  openAIContent,
  anthropicContent,
  responsesContent,
} from './model_media.js';
import { orderModeToolResults } from './tool_history.js';
import {
  budgetForEstimate,
  BudgetExceeded,
  providerInputEstimate,
  resolveBudget,
  type RequestFrame,
} from './request_budget.js';
import {
  isContextLimitError,
  ModelCompletionFailure,
  providerErrorRecords,
} from './model_completion.js';
// What a Chat Completions tool row says when the tool returned no text. Strict
// gateways such as DashScope reject a message whose content is empty.
const EMPTY_TOOL_RESULT = '(no output)';
import { EFFORT_LEVELS } from './effort.js';
export { EFFORT_LEVELS };
function completion(
  protocol: 'openai' | 'anthropic' | 'responses',
  finish: string | null | undefined,
  outputLimit?: number,
  repetition = false,
): ModelCompletion {
  const reasons: Record<string, ModelCompletion['reason']> =
    protocol === 'anthropic'
      ? {
          end_turn: 'stop',
          stop_sequence: 'stop',
          tool_use: 'tool_calls',
          max_tokens: 'length',
          model_context_window_exceeded: 'length',
          refusal: 'filter',
          pause_turn: 'pause',
        }
      : protocol === 'responses'
        ? {
            completed: 'stop',
            max_output_tokens: 'length',
            content_filter: 'filter',
          }
        : {
            stop: 'stop',
            tool_calls: 'tool_calls',
            function_call: 'tool_calls',
            length: 'length',
            content_filter: 'filter',
          };
  return {
    reason: finish
      ? Object.hasOwn(reasons, finish)
        ? reasons[finish]!
        : 'unknown'
      : 'missing',
    ...(finish ? { provider_reason: finish } : {}),
    ...(outputLimit !== undefined ? { output_limit: outputLimit } : {}),
    ...(repetition ? { client_stop: 'repetition' as const } : {}),
  };
}
/** Depth when the user has not chosen one. Anthropic used to fall back to `xhigh`. */
export function defaultEffort(
  protocol: string,
  saved = '',
  env = process.env.CIRCLE_REASONING_EFFORT || '',
): string {
  const fallback = protocol === 'anthropic' ? 'medium' : '';
  const chosen = (env || saved || fallback).trim();
  if (chosen && !(EFFORT_LEVELS as readonly string[]).includes(chosen))
    return fallback;
  return chosen;
}
export class GatewayModel implements ChatModel {
  readonly model: string;
  /** A title request may call `complete` while a turn is in flight. */
  readonly sideRequests = true;
  readonly reportsAttempts = true;
  private openai?: OpenAI;
  private anthropic?: Anthropic;
  /** The connection speaks the Responses API through the OpenAI client. */
  private readonly responsesApi: boolean;
  /** A ChatGPT plan: OAuth tokens and the plan route's request rules. */
  private readonly planRoute: boolean;
  // How long a request waits for the answer to start (`CIRCLE_LLM_TIMEOUT`)
  private readonly timeout: number;
  effort: string;
  private readonly dropped = new Set<string>();
  /**
   * The current physical attempt's parameters, scoped to this asynchronous request.
   * Titles and parallel summaries must not replace each other's rejection evidence.
   */
  private readonly sentParameters = new AsyncLocalStorage<Set<string>>();
  private readonly thinkingScope: string;
  private readonly rejectedThinking = new Set<string>();
  private observedContextLimit?: number;
  private observedInputLimit?: number;
  private observedOutputLimit?: number;
  private estimateFactor = 1.5;
  private readonly guard: ModelGuard;
  readonly catalog: ModelCatalog;
  private readonly searchConnection?: import('./native_websearch.js').NativeSearchConnection;
  /**
   * A snapshot of the same connection used by the main model client. Never persisted.
   * A ChatGPT plan has none: hosted search is not part of its route.
   */
  webSearchConnection():
    import('./native_websearch.js').NativeSearchConnection | undefined {
    return this.searchConnection && { ...this.searchConnection };
  }
  constructor(
    readonly settings: CircleSettings,
    home?: string,
    modelOverride?: string,
    guardOptions: GuardOptions = {},
    catalog?: ModelCatalog,
  ) {
    this.model = modelOverride || settings.auth.model;
    this.catalog = catalog ?? new ModelCatalog(circleHome(home));
    if (!this.model)
      throw new Error('no model name in settings; re-run circle --init');
    this.planRoute = settings.auth.protocol === CHATGPT_PROTOCOL;
    this.responsesApi = speaksResponses(settings.auth.protocol);
    let apiKey: string | (() => Promise<string>);
    let identity: string;
    if (this.planRoute) {
      const signedIn = home ?? circleHome();
      // The account, never its rotating token, names whose reasoning history holds.
      // Signed out, the connection still starts: its first request says to sign in.
      identity = chatgptIdentityIfSignedIn(signedIn) ?? 'chatgpt signed out';
      apiKey = () => chatgptAccessToken(signedIn);
    } else {
      const credentials = loadCredentials(home);
      const key = credentials[settings.auth.api_key_ref] || credentials.api_key;
      if (!key)
        throw new Error(desktopText('missing API key; re-run circle --init'));
      apiKey = identity = key;
      this.searchConnection = Object.freeze({
        baseUrl: settings.auth.base_url,
        protocol:
          settings.auth.protocol === 'anthropic' ? 'anthropic' : 'openai',
        model: this.model,
        apiKey: key,
      });
    }
    // Keyed identity lets saved history detect account/endpoint/model changes without
    // storing a key or endpoint in the transcript. Rotation conservatively drops replay.
    this.thinkingScope = createHmac('sha256', identity)
      .update(
        JSON.stringify([
          settings.auth.protocol,
          settings.auth.base_url.replace(/\/+$/, ''),
          this.model,
        ]),
      )
      .digest('hex');
    // Whole milliseconds: the SDKs refuse a fractional per-request timeout
    this.timeout = Math.max(
      5000,
      Math.round((Number(process.env.CIRCLE_LLM_TIMEOUT) || 45) * 1000),
    );
    const options = {
      baseURL: settings.auth.base_url,
      timeout: this.timeout,
      maxRetries: 0,
    };
    if (settings.auth.protocol === 'anthropic')
      this.anthropic = new Anthropic({ ...options, apiKey: apiKey as string });
    else
      this.openai = new OpenAI({
        ...options,
        apiKey,
        // The plan route takes compressed bodies and refuses large plain ones.
        ...(this.planRoute ? { fetch: compressedFetch } : {}),
      });
    this.effort = defaultEffort(
      this.anthropic ? 'anthropic' : 'openai',
      settings.default_thinking,
    );
    this.guard = new ModelGuard(
      (parameter) => this.dropParameter(parameter),
      guardOptions,
    );
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    request = {
      ...request,
      messages: leaveOutImages(
        orderModeToolResults(request.messages),
        this.imageInput === false,
      ),
    };
    checkRequestMedia(request.messages);
    let response: ModelResponse;
    const hadImages = request.messages.some((message) =>
      (message.attachments ?? []).some((item) => item.kind === 'image'),
    );
    try {
      response = await this.sentParameters.run(new Set<string>(), () =>
        this.guard.execute(request, (current) =>
          this.anthropic
            ? this.completeAnthropic(current)
            : this.responsesApi
              ? this.completeResponses(current)
              : this.completeOpenAI(current),
        ),
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      const records = providerErrorRecords(error);
      if (this.planRoute) {
        // A sign-in that has ended says so itself, not as the SDK's key failure.
        for (
          let cause: unknown = error;
          cause;
          cause = (cause as { cause?: unknown }).cause
        )
          if (cause instanceof ChatGPTSignInError) throw cause;
        const plan = planFailureMessage(
          records,
          (error as { status?: number }).status,
        );
        if (plan) throw new Error(plan, { cause: error });
      }
      const limit = (name: string) =>
        records
          .map((row) => row[name])
          .find(
            (value) =>
              typeof value === 'number' &&
              Number.isSafeInteger(value) &&
              value > 0,
          ) as number | undefined;
      const output = limit('max_output_tokens');
      if (output !== undefined)
        this.observedOutputLimit = Math.min(
          this.observedOutputLimit ?? Infinity,
          output,
        );
      if (isContextLimitError(error)) {
        const detail = error as {
          error?: { max_context_tokens?: number; max_input_tokens?: number };
          message?: string;
        };
        const context =
          limit('max_context_tokens') ??
          Number(
            detail.message?.match(/maximum context length is\s+(\d+)/i)?.[1],
          );
        const input = limit('max_input_tokens');
        if (Number.isSafeInteger(context) && context > 0)
          this.observedContextLimit = Math.min(
            this.observedContextLimit ?? Infinity,
            context,
          );
        if (input !== undefined && Number.isSafeInteger(input) && input > 0)
          this.observedInputLimit = Math.min(
            this.observedInputLimit ?? Infinity,
            input,
          );
        if (error instanceof ModelCompletionFailure) throw error;
        const failure = new ModelCompletionFailure('context_limit');
        failure.providerError = {
          code: records
            .map((row) => row.code)
            .find((code) => typeof code === 'string') as string | undefined,
          message: detail.message ?? String(error),
          contextLimit:
            Number.isSafeInteger(context) && context > 0 ? context : undefined,
          inputLimit: input,
          outputLimit: output,
        };
        throw failure;
      }
      if (
        output !== undefined &&
        request.maxTokens &&
        request.maxTokens > output
      ) {
        const failure = new ModelCompletionFailure('output_limit');
        failure.message = 'requested output exceeds the endpoint limit';
        failure.providerError = {
          message: error instanceof Error ? error.message : String(error),
          outputLimit: output,
        };
        throw failure;
      }
      // A model Circle does not know may not read images; the endpoint says so as a 400
      // the field-dropping guard cannot fix, so say which part of the request that was
      const status =
        (error as { status?: number; statusCode?: number }).status ??
        (error as { status?: number; statusCode?: number }).statusCode;
      const reason = networkErrorReason(error);
      // Only an endpoint that says the model takes no pictures marks it: an error that
      // merely mentions them (too large, too many) is the endpoint's to explain
      if (
        hadImages &&
        this.imageInput === undefined &&
        [400, 415, 422].includes(Number(status)) &&
        endpointRefusesImages(reason)
      ) {
        this.catalog.reportUnknownImage(this.model);
        throw new Error(
          `the endpoint refused the request's pictures (${reason.slice(0, 300)}): ${this.model} does not read images. Until Circle quits, this conversation gives it the pictures' paths instead; send the message again. Set "models": {"${this.model}": {"images": false}} in settings.json to keep it so, or /models lists what this endpoint offers.`,
          { cause: error },
        );
      }
      if (!isNetworkFailure(error)) throw error;
      throw networkError(error, this.settings.auth.base_url);
    }
    response.message.cost = priceCall(
      this.catalog.facts(
        response.message.model || this.model,
        this.settings,
        modelProfile(this.profileProtocol, this.model)?.max_input_tokens,
      ),
      response.usage,
    );
    return response;
  }
  /** Model profiles are kept per API family; a Responses connection reads OpenAI's. */
  private get profileProtocol(): string {
    return apiFamily(this.settings.auth.protocol);
  }
  get modelFacts(): ModelFacts {
    const facts = this.catalog.facts(
      this.model,
      this.settings,
      modelProfile(this.profileProtocol, this.model)?.max_input_tokens,
    );
    return this.observedContextLimit === undefined ||
      this.observedContextLimit >= facts.contextWindow
      ? facts
      : {
          ...facts,
          contextWindow: Math.min(
            facts.contextWindow,
            this.observedContextLimit,
          ),
          windowKnown: true,
          windowSource: 'provider',
        };
  }
  /**
   * The endpoint refused a request this size as too long without saying its limit, as
   * OpenAI's "Your input exceeds the context window of this model" does: the context is
   * no larger than the refused request. Measured as Circle measures a request, so the
   * next one that size compacts first.
   */
  noteContextRefusal(input: number): void {
    if (!Number.isSafeInteger(input) || input <= 0) return;
    this.observedContextLimit = Math.min(
      this.observedContextLimit ?? Infinity,
      input,
    );
  }
  get contextWindow(): number {
    return Math.min(
      this.modelFacts.contextWindow,
      this.observedContextLimit ?? Infinity,
    );
  }
  get inputLimit(): number | undefined {
    const limit = Math.min(
      this.modelFacts.inputLimit ?? Infinity,
      this.observedInputLimit ?? Infinity,
    );
    return Number.isFinite(limit) ? limit : undefined;
  }
  get outputLimit(): number | undefined {
    const limit = Math.min(
      this.modelFacts.outputLimit ??
        modelProfile(this.profileProtocol, this.model)?.max_output_tokens ??
        Infinity,
      this.observedOutputLimit ?? Infinity,
    );
    return Number.isFinite(limit) ? limit : undefined;
  }
  get budgetIdentity(): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          this.thinkingScope,
          this.effort,
          [...this.dropped].sort(),
          this.settings.models[this.model],
        ]),
      )
      .digest('hex');
  }
  get inputEstimateFactor(): number {
    return this.estimateFactor;
  }
  estimateInput(request: RequestFrame): number {
    const full = {
      ...request,
      signal: new AbortController().signal,
      token: () => {},
    };
    const projected = {
      ...full,
      messages: leaveOutImages(
        orderModeToolResults(full.messages),
        this.imageInput === false,
      ),
    };
    if (this.responsesApi) {
      const body = this.responsesBody(projected);
      return providerInputEstimate({
        system: body.instructions,
        messages: body.input,
        tools: body.tools,
      });
    }
    const body = this.anthropic
      ? this.anthropicBody(this.projectThinking(projected))
      : this.openAIBody(projected);
    return providerInputEstimate({
      system: 'system' in body ? body.system : undefined,
      messages: body.messages,
      tools: body.tools,
    });
  }
  private observeRequest(
    request: ModelRequest,
    body: {
      messages: unknown;
      tools?: unknown;
      system?: unknown;
      max_tokens?: number | null;
      max_completion_tokens?: number | null;
    },
  ) {
    const estimate = providerInputEstimate({
      system: body.system,
      messages: body.messages,
      tools: body.tools,
    });
    const budget = budgetForEstimate(
      this,
      resolveBudget(this),
      estimate,
      body.max_completion_tokens ??
        body.max_tokens ??
        resolveBudget(this).output,
    );
    if (request.enforceBudget && !budget.fits) throw new BudgetExceeded(budget);
    const id = randomUUID();
    const report = (
      phase: 'start' | 'usage' | 'end',
      usage?: import('./types.js').Usage,
      finish?: ModelCompletion,
    ) => {
      if (usage && estimate > 0 && usage.input_tokens > 0)
        this.estimateFactor = Math.max(
          this.estimateFactor,
          (usage.input_tokens / estimate) * 1.1,
        );
      request.observeAttempt?.({
        id,
        phase,
        budget,
        usage,
        completion: finish,
      });
    };
    report('start');
    return Object.assign(report, { budget });
  }
  // How long this try waits for the answer to start: longer after a timeout, but no more
  // than the 5 minutes Node.js's fetch waits for an answer anyway
  private requestTimeout(request: ModelRequest): number {
    return Math.min(
      Math.max(this.timeout, 300_000),
      this.timeout * (request.timeoutScale ?? 1),
    );
  }
  get imageInput(): boolean | undefined {
    return (
      this.modelFacts.imageInput ??
      modelProfile(this.profileProtocol, this.model)?.image_inputs
    );
  }
  get outputBudget(): number | undefined {
    if (!this.anthropic)
      return Math.max(
        1,
        Math.min(
          this.outputLimit ?? 4096,
          32000,
          Math.floor(this.contextWindow / 4),
        ),
      );
    const profile = modelProfile('anthropic', this.model);
    const legacy =
      this.model.toLowerCase().split('/').at(-1)?.startsWith('claude') &&
      profile &&
      !profile.reasoning_effort_levels?.length;
    const desired =
      legacy && this.effort
        ? (THINKING_BUDGET[this.effort] ?? 16000) + 8192
        : 32000;
    return Math.max(
      1,
      Math.min(
        desired,
        Math.floor(this.contextWindow / 4),
        this.outputLimit ?? Infinity,
      ),
    );
  }
  private effortFor(request: ModelRequest): string {
    const chosen = request.effort ?? this.effort;
    if (chosen && !(EFFORT_LEVELS as readonly string[]).includes(chosen))
      return this.effort;
    return chosen;
  }
  private sent(parameter: string): boolean {
    return this.sentParameters.getStore()?.has(parameter) ?? false;
  }
  get downgrades(): Record<string, string> {
    return Object.fromEntries(this.guard.downgrades);
  }
  private dropParameter(parameter: string): boolean {
    if (parameter === 'thinking.display') {
      if (!this.anthropic || !this.sent(parameter)) return false;
      this.dropped.add(parameter);
      return true;
    }
    // An endpoint names a refused breakpoint by its place (`system.0.cache_control`):
    // one refused, they all go.
    let root = parameter.includes('cache_control')
      ? 'cache_control'
      : parameter.split('.')[0]!;
    if (root === 'effort')
      root = this.anthropic
        ? 'output_config'
        : this.responsesApi
          ? 'reasoning'
          : 'reasoning_effort';
    if (root === 'budget_tokens') root = 'thinking';
    if (
      ![
        'reasoning_effort',
        'reasoning',
        'output_config',
        'thinking',
        'stream_options',
        'parallel_tool_calls',
        'betas',
        'include',
        'cache_control',
        'prompt_cache_key',
      ].includes(root) ||
      !this.sent(root)
    )
      return false;
    this.dropped.add(root);
    return true;
  }
  private configureBody(body: Record<string, unknown>): void {
    for (const field of this.dropped) {
      if (field === 'thinking.display') {
        if (isRecord(body.thinking)) delete body.thinking.display;
      } else delete body[field];
    }
    const sent = new Set(Object.keys(body));
    if (isRecord(body.thinking) && body.thinking.display !== undefined)
      sent.add('thinking.display');
    const current = this.sentParameters.getStore();
    current?.clear();
    for (const parameter of sent) current?.add(parameter);
  }
  private openAIBody(
    request: ModelRequest,
  ): ChatCompletionCreateParamsStreaming {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: request.system },
    ];
    const toolMedia: import('./types.js').MediaAttachment[] = [];
    const flushToolMedia = (): void => {
      if (!toolMedia.length) return;
      messages.push({
        role: 'user',
        content: openAIContent(
          'Attachments returned by the preceding tools:',
          toolMedia,
        ),
      });
      toolMedia.length = 0;
    };
    for (const message of request.messages) {
      // Chat Completions allows media only in user content. Keep the complete
      // tool-result batch together, then project its media into a user item.
      if (message.role !== 'tool') flushToolMedia();
      if (message.role === 'system') {
        if (message.content.trim())
          messages.push({ role: 'system', content: message.content });
      } else if (message.role === 'tool') {
        messages.push({
          role: 'tool',
          content: commandExecutionModelContent(message) || EMPTY_TOOL_RESULT,
          tool_call_id: message.tool_call_id!,
        });
        toolMedia.push(...(message.attachments ?? []));
      } else if (message.role === 'assistant') {
        // A thinking-only/interrupted turn has no Chat Completions content.
        // Preserve it in history, but do not send it: there is nothing to say.
        if (!message.content?.trim() && !message.tool_calls?.length) continue;
        // Content is a string on every row, '' beside tool calls. OpenAI takes
        // '' as it takes null; strict gateways such as DashScope reject null
        // ("The content field is a required field") and accept ''.
        messages.push({
          role: 'assistant',
          content: message.content || '',
          ...(message.tool_calls?.length
            ? {
                tool_calls: message.tool_calls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.args),
                  },
                })),
              }
            : {}),
        });
      } else if (
        !message.attachments?.length &&
        !commandExecutionModelContent(message).trim()
      )
        // An empty prompt says nothing, and strict gateways reject it.
        continue;
      else
        messages.push({
          role: 'user',
          content: message.attachments?.length
            ? openAIContent(
                commandExecutionModelContent(message),
                message.attachments,
              )
            : commandExecutionModelContent(message),
        });
    }
    flushToolMedia();
    const body: ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      // See `responsesBody`: the conversation's steps reach the machine that cached it.
      ...(request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
    };
    if (request.tools.length)
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    const effort = this.effortFor(request);
    if (effort)
      body.reasoning_effort =
        effort as ChatCompletionCreateParamsStreaming['reasoning_effort'];
    const output =
      request.maxTokens ??
      (request.enforceBudget ? this.outputBudget : undefined);
    if (output !== undefined) {
      const field = this.settings.models[this.model]?.output_parameter;
      if (
        field === 'max_completion_tokens' ||
        (field !== 'max_tokens' &&
          /^(?:o[1-9](?:-|$)|gpt-(?:5|6)(?:[.-]|$))/i.test(
            this.model.split('/').at(-1) ?? '',
          ))
      )
        body.max_completion_tokens = output;
      else body.max_tokens = output;
    }
    return body;
  }
  /** The breakpoint this run's `prompt_cache` setting asks for, or none. */
  private cacheBreakpoint(): CacheControlEphemeral | undefined {
    const mode = this.settings.prompt_cache;
    if (mode === 'off' || this.dropped.has('cache_control')) return undefined;
    // The five minutes are the endpoint's default, sent without a `ttl` so a gateway that
    // knows only the plain marker takes it.
    return mode === '1h'
      ? { type: 'ephemeral', ttl: '1h' }
      : { type: 'ephemeral' };
  }
  /**
   * A Claude model behind an OpenAI-format endpoint (OpenRouter, a relay) caches only where
   * the request says, as on Anthropic's own endpoint; every other model there caches by
   * itself. The breakpoints go where such endpoints read them: on the text of the system
   * prompt and of the last user message, and one at the top of the request, which the
   * endpoint moves to the end of the conversation.
   */
  private markChatCache(body: ChatCompletionCreateParamsStreaming): void {
    const cache = this.cacheBreakpoint();
    if (!cache || !/claude/i.test(this.model)) return;
    const mark = (message: ChatCompletionMessageParam | undefined): void => {
      if (!message || (message.role !== 'system' && message.role !== 'user'))
        return;
      const parts =
        typeof message.content === 'string'
          ? message.content.trim()
            ? [{ type: 'text' as const, text: message.content }]
            : []
          : [...message.content];
      const last = parts.findLastIndex((part) => part.type === 'text');
      if (last < 0) return;
      parts[last] = { ...parts[last]!, cache_control: cache } as never;
      message.content = parts as never;
    };
    mark(body.messages[0]);
    mark(body.messages.findLast((message) => message.role === 'user'));
    (body as unknown as Record<string, unknown>).cache_control = cache;
  }
  private async completeOpenAI(request: ModelRequest): Promise<ModelResponse> {
    const body = this.openAIBody(request);
    this.markChatCache(body);
    this.configureBody(body as unknown as Record<string, unknown>);
    const observe = this.observeRequest(request, body);
    const stream = await this.openai!.chat.completions.create(body, {
      signal: request.signal,
      timeout: this.requestTimeout(request),
    });
    const stopStream = () => {
      try {
        stream.controller.abort();
      } catch {
        /* The body is already closed. */
      }
    };
    request.signal.addEventListener('abort', stopStream, { once: true });
    request.progress?.('connected');
    let content = '';
    let thinking = '';
    let finish = '';
    let servedModel = this.model;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const usage = emptyUsage();
    let usageReported = false;
    let inputReported = false;
    let outputReported = false;
    let cacheReported = false;
    let guardedStop = false;
    try {
      for await (const chunk of stream) {
        if (request.signal.aborted) break;
        if (chunk.model) servedModel = chunk.model;
        if (chunk.usage) {
          inputReported ||= Number.isFinite(chunk.usage.prompt_tokens);
          outputReported ||= Number.isFinite(chunk.usage.completion_tokens);
          usageReported = inputReported && outputReported;
          usage.input_tokens = Math.max(
            usage.input_tokens,
            chunk.usage.prompt_tokens || 0,
          );
          usage.output_tokens = Math.max(
            usage.output_tokens,
            chunk.usage.completion_tokens || 0,
          );
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
          if (typeof cached === 'number') {
            cacheReported = true;
            usage.cache_read_tokens = Math.max(usage.cache_read_tokens, cached);
          }
          request.progress?.('usage');
          observe('usage', { ...usage });
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta;
        request.progress?.(
          delta.content
            ? 'text'
            : delta.tool_calls?.length
              ? 'tool'
              : 'keepalive',
        );
        if (delta.content) {
          content += delta.content;
          request.token(delta.content);
        }
        const extra = delta as unknown as Record<string, unknown>;
        const reasoning = extra.reasoning_content ?? extra.reasoning;
        if (typeof reasoning === 'string') {
          thinking += reasoning;
          request.token(reasoning, true);
        }
        for (const part of delta.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: '', name: '', args: '' };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.args += part.function.arguments;
          calls.set(part.index, call);
        }
      }
    } catch (error) {
      if (error instanceof TextRepetitionLoop && error.answered) {
        guardedStop = true;
        request.notice?.({ event: 'repetition_stopped', period: error.period });
      } else throw error;
    } finally {
      request.signal.removeEventListener('abort', stopStream);
      stream.controller.abort();
    }
    request.signal.throwIfAborted();
    const tool_calls = finishedToolCalls([...calls.values()]);
    const response: ModelResponse = {
      message: {
        id: randomUUID(),
        role: 'assistant',
        model: servedModel,
        content,
        thinking,
        tool_calls,
        ...(cacheReported ? {} : { cache_reported: false }),
        completion: completion(
          'openai',
          finish,
          body.max_completion_tokens ?? body.max_tokens ?? undefined,
          guardedStop,
        ),
        ...(request.enforceBudget ? { request_budget: observe.budget } : {}),
        ...(guardedStop || !finish || finish === 'length'
          ? { truncated: true }
          : {}),
      },
      usage,
      ...(usageReported ? {} : { usageReported: false }),
    };
    observe(
      'end',
      usageReported ? response.usage : undefined,
      response.message.completion,
    );
    if (!finish && !guardedStop)
      throw new MissingFinish(
        response,
        Boolean(content || thinking || calls.size),
      );
    if (finish === 'length' && !content && !calls.size)
      request.notice?.({
        event: 'output_budget_exhausted',
        finish_reason: finish,
      });
    return response;
  }
  /** Encrypted reasoning goes back only to the connection that wrote it, and not after a rejection. */
  private replaysReasoning(message: Message): boolean {
    return (
      Boolean(message.reasoning_items?.length) &&
      // A reasoning item must be followed by what it produced; a stopped,
      // thinking-only turn has nothing after it.
      Boolean(message.content?.trim() || message.tool_calls?.length) &&
      message.thinking_scope === this.thinkingScope &&
      !this.rejectedThinking.has(thinkingIdentity(message))
    );
  }
  private responsesBody(request: ModelRequest): ResponseCreateParamsStreaming {
    const input: ResponseInputItem[] = [];
    const text = (role: 'user' | 'developer', content: string) =>
      input.push({
        type: 'message',
        role,
        content: [{ type: 'input_text', text: content }],
      });
    for (const message of request.messages) {
      if (message.role === 'system') {
        if (message.content.trim()) text('developer', message.content);
      } else if (message.role === 'tool') {
        const output =
          commandExecutionModelContent(message) || EMPTY_TOOL_RESULT;
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id!,
          // A tool's pictures travel in its own result, as opencode sends them.
          output: message.attachments?.length
            ? responsesContent(output, message.attachments)
            : output,
        });
      } else if (message.role === 'assistant') {
        if (this.replaysReasoning(message))
          for (const item of message.reasoning_items ?? [])
            if (
              isRecord(item) &&
              item.type === 'reasoning' &&
              typeof item.encrypted_content === 'string'
            )
              input.push(item as unknown as ResponseReasoningItem);
        // The text and calls are rebuilt from the stored message, so a call the
        // harness rewrote for privacy is sent as it was stored.
        if (message.content?.trim())
          input.push({
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: message.content, annotations: [] },
            ],
            // The model reads its channel back; without it, updates read as answers.
            ...(message.phase ? { phase: message.phase } : {}),
            // Replayed without an item id: the endpoint stored nothing to refer to.
          } as unknown as ResponseInputItem);
        for (const call of message.tool_calls ?? [])
          input.push({
            type: 'function_call',
            call_id: call.id,
            ...(this.planRoute ? { namespace: PLAN_TOOL_NAMESPACE } : {}),
            name: call.name,
            arguments: JSON.stringify(call.args),
          });
      } else {
        const content = commandExecutionModelContent(message);
        // An empty prompt says nothing, and strict gateways reject it.
        if (!message.attachments?.length && !content.trim()) continue;
        input.push({
          type: 'message',
          role: 'user',
          content: responsesContent(content, message.attachments),
        });
      }
    }
    const body: ResponseCreateParamsStreaming = {
      model: this.model,
      instructions: request.system,
      input,
      stream: true,
      // Circle keeps the conversation; the endpoint keeps nothing, so reasoning
      // comes back encrypted and is replayed from history.
      store: false,
      include: ['reasoning.encrypted_content'],
      // The endpoint caches a prefix by itself, on the machine the request reached. The
      // key sends the conversation's steps to one machine, away from every other
      // conversation that starts with the same prompt.
      ...(request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
    };
    const functions = request.tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }));
    // The plan route takes function tools grouped in a namespace.
    if (functions.length)
      body.tools = this.planRoute
        ? [
            {
              type: 'namespace',
              name: PLAN_TOOL_NAMESPACE,
              description: "Circle's tools for this workspace.",
              tools: functions,
            },
          ]
        : functions;
    const effort = this.effortFor(request);
    if (effort)
      body.reasoning = {
        effort: effort as NonNullable<
          ResponseCreateParamsStreaming['reasoning']
        >['effort'],
        summary: 'auto',
      };
    const output =
      request.maxTokens ??
      (request.enforceBudget ? this.outputBudget : undefined);
    // The plan route refuses an output cap; the answer's end says when it ran long.
    if (output !== undefined && !this.planRoute)
      body.max_output_tokens = output;
    return body;
  }
  private async completeResponses(
    request: ModelRequest,
  ): Promise<ModelResponse> {
    try {
      return await this.sendResponses(request);
    } catch (error) {
      request.signal.throwIfAborted();
      if (!isEncryptedReasoningError(error)) throw error;
      const replayed = request.messages.filter(
        (message) =>
          message.role === 'assistant' && this.replaysReasoning(message),
      );
      if (!replayed.length) throw error;
      request.recovery?.take();
      // The endpoint cannot read this history's reasoning (another account, or an
      // expired key). Send those turns once more without it, as Anthropic's signed
      // thinking is dropped after the same kind of rejection.
      for (const message of replayed)
        this.rejectedThinking.add(thinkingIdentity(message));
      try {
        request.notice?.({ event: 'thinking_signature_retry' });
      } catch {
        /* Display subscribers cannot stop recovery. */
      }
      return this.sendResponses(request);
    }
  }
  private async sendResponses(request: ModelRequest): Promise<ModelResponse> {
    const body = this.responsesBody(request);
    this.configureBody(body as unknown as Record<string, unknown>);
    const observe = this.observeRequest(request, {
      system: body.instructions,
      messages: body.input,
      tools: body.tools,
      max_tokens: body.max_output_tokens,
    });
    const stream = await this.openai!.responses.create(body, {
      signal: request.signal,
      timeout: this.requestTimeout(request),
    });
    const stopStream = () => {
      try {
        stream.controller.abort();
      } catch {
        /* The body is already closed. */
      }
    };
    request.signal.addEventListener('abort', stopStream, { once: true });
    request.progress?.('connected');
    let content = '';
    let thinking = '';
    let finish = '';
    let servedModel = this.model;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const reasoning: Record<string, unknown>[] = [];
    // Which channels the response's messages came on (commentary, final answer).
    const phases = new Set<string>();
    const notePhase = (item: unknown) => {
      const phase = (item as { phase?: unknown }).phase;
      if (phase === 'commentary' || phase === 'final_answer') phases.add(phase);
    };
    // Output items whose text streamed as deltas; an item that arrives whole is read at its end.
    const streamedText = new Set<number>();
    const usage = emptyUsage();
    let usageReported = false;
    let cacheReported = false;
    let guardedStop = false;
    const think = (delta: string) => {
      thinking += delta;
      request.token(delta, true);
    };
    try {
      for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
        if (request.signal.aborted) break;
        switch (event.type) {
          case 'response.created':
          case 'response.in_progress':
            if (event.response.model) servedModel = event.response.model;
            request.progress?.('keepalive');
            break;
          case 'response.output_text.delta':
            streamedText.add(event.output_index);
            request.progress?.('text');
            content += event.delta;
            request.token(event.delta);
            break;
          case 'response.reasoning_summary_part.added':
            // Summary parts are separate paragraphs.
            if (thinking && !thinking.endsWith('\n\n')) think('\n\n');
            request.progress?.('keepalive');
            break;
          case 'response.reasoning_summary_text.delta':
          case 'response.reasoning_text.delta':
            request.progress?.('keepalive');
            think(event.delta);
            break;
          case 'response.output_item.added':
            if (event.item.type === 'message') notePhase(event.item);
            if (event.item.type === 'function_call')
              calls.set(event.output_index, {
                id: event.item.call_id,
                name: event.item.name,
                args: event.item.arguments ?? '',
              });
            request.progress?.(
              event.item.type === 'function_call' ? 'tool' : 'keepalive',
            );
            break;
          case 'response.function_call_arguments.delta': {
            const call = calls.get(event.output_index) ?? {
              id: '',
              name: '',
              args: '',
            };
            call.args += event.delta;
            calls.set(event.output_index, call);
            request.progress?.('tool');
            break;
          }
          case 'response.output_item.done': {
            const item = event.item;
            if (item.type === 'function_call') {
              const call = calls.get(event.output_index);
              // The finished item is authoritative over the streamed fragments.
              calls.set(event.output_index, {
                id: item.call_id || call?.id || '',
                name: item.name || call?.name || '',
                args:
                  typeof item.arguments === 'string'
                    ? item.arguments
                    : (call?.args ?? ''),
              });
              request.progress?.('tool');
            } else if (item.type === 'reasoning') {
              const kept: Record<string, unknown> = {
                type: 'reasoning',
                id: item.id,
                summary: item.summary ?? [],
              };
              if (typeof item.encrypted_content === 'string')
                kept.encrypted_content = item.encrypted_content;
              reasoning.push(kept);
              request.progress?.('keepalive');
            } else if (item.type === 'message') {
              notePhase(item);
              if (streamedText.has(event.output_index)) {
                request.progress?.('keepalive');
                break;
              }
              const whole = item.content
                .map((part) => (part.type === 'output_text' ? part.text : ''))
                .join('');
              if (whole) {
                request.progress?.('text');
                content += whole;
                request.token(whole);
              }
            } else request.progress?.('keepalive');
            break;
          }
          case 'response.completed':
          case 'response.incomplete': {
            const final = event.response;
            if (final.model) servedModel = final.model;
            finish =
              event.type === 'response.completed'
                ? 'completed'
                : (final.incomplete_details?.reason ?? 'incomplete');
            if (final.usage) {
              usageReported =
                Number.isFinite(final.usage.input_tokens) &&
                Number.isFinite(final.usage.output_tokens);
              usage.input_tokens = final.usage.input_tokens || 0;
              usage.output_tokens = final.usage.output_tokens || 0;
              const cached = final.usage.input_tokens_details?.cached_tokens;
              if (typeof cached === 'number') {
                cacheReported = true;
                usage.cache_read_tokens = cached;
              }
              observe('usage', { ...usage });
            }
            request.progress?.('usage');
            break;
          }
          case 'response.failed': {
            const failure = event.response.error;
            throw new OpenAI.APIError(
              undefined,
              failure ?? { message: 'the response failed' },
              failure?.message ?? 'the response failed',
              undefined,
            );
          }
          case 'error':
            throw new OpenAI.APIError(
              undefined,
              { code: event.code, message: event.message, param: event.param },
              event.message,
              undefined,
            );
          default:
            request.progress?.('keepalive');
        }
      }
    } catch (error) {
      if (error instanceof TextRepetitionLoop && error.answered) {
        guardedStop = true;
        request.notice?.({ event: 'repetition_stopped', period: error.period });
      } else throw error;
    } finally {
      request.signal.removeEventListener('abort', stopStream);
      stream.controller.abort();
    }
    request.signal.throwIfAborted();
    const tool_calls = finishedToolCalls([...calls.values()]);
    const ended = completion(
      'responses',
      finish,
      body.max_output_tokens ?? undefined,
      guardedStop,
    );
    if (ended.reason === 'stop' && tool_calls.length)
      ended.reason = 'tool_calls';
    const response: ModelResponse = {
      message: {
        id: randomUUID(),
        role: 'assistant',
        model: servedModel,
        content,
        thinking,
        tool_calls,
        ...(reasoning.length ? { reasoning_items: reasoning } : {}),
        // An answer outranks an update when one response holds both.
        ...(phases.has('final_answer')
          ? { phase: 'final_answer' as const }
          : phases.has('commentary')
            ? { phase: 'commentary' as const }
            : {}),
        thinking_scope: this.thinkingScope,
        ...(cacheReported ? {} : { cache_reported: false }),
        completion: ended,
        ...(request.enforceBudget ? { request_budget: observe.budget } : {}),
        ...(guardedStop || !finish || ended.reason === 'length'
          ? { truncated: true }
          : {}),
      },
      usage,
      ...(usageReported ? {} : { usageReported: false }),
    };
    observe(
      'end',
      usageReported ? response.usage : undefined,
      response.message.completion,
    );
    if (!finish && !guardedStop)
      throw new MissingFinish(
        response,
        Boolean(content || thinking || calls.size),
      );
    if (ended.reason === 'length' && !content && !calls.size)
      request.notice?.({
        event: 'output_budget_exhausted',
        finish_reason: finish,
      });
    return response;
  }
  private async completeAnthropic(
    request: ModelRequest,
  ): Promise<ModelResponse> {
    const projected = this.projectThinking(request);
    try {
      return await this.sendAnthropic(projected);
    } catch (error) {
      request.signal.throwIfAborted();
      if (!isThinkingSignatureError(error)) throw error;
      const signed = projected.messages.filter(
        (message) =>
          message.role === 'assistant' &&
          message.provider_content?.some(isThinkingBlock),
      );
      if (!signed.length) throw error;
      request.recovery?.take();
      // Legacy/imported histories have no scope. Only an explicit server rejection
      // authorizes dropping their signed blocks, once, from requests to this model.
      // Keep original checkpoints intact, and keep newly generated thinking intact.
      for (const message of signed)
        this.rejectedThinking.add(thinkingIdentity(message));
      try {
        request.notice?.({ event: 'thinking_signature_retry' });
      } catch {
        /* Display subscribers cannot stop recovery. */
      }
      return this.sendAnthropic(this.projectThinking(request));
    }
  }
  private projectThinking(request: ModelRequest): ModelRequest {
    return {
      ...request,
      messages: request.messages.flatMap((message) => {
        if (
          message.role !== 'assistant' ||
          (!(
            this.rejectedThinking.size &&
            this.rejectedThinking.has(thinkingIdentity(message))
          ) &&
            (!message.thinking_scope ||
              message.thinking_scope === this.thinkingScope))
        )
          return [message];
        const blocks = message.provider_content?.filter(
          (block) => !isThinkingBlock(block),
        );
        if (
          blocks?.length === 0 &&
          !message.content &&
          !message.tool_calls?.length
        )
          return [];
        return [
          {
            ...message,
            thinking: undefined,
            provider_content: blocks?.length ? blocks : undefined,
          },
        ];
      }),
    };
  }
  private anthropicBody(
    request: ModelRequest,
  ): MessageCreateParamsNonStreaming {
    const messages: MessageParam[] = [];
    let system = request.system;
    for (const message of request.messages) {
      if (message.role === 'system') {
        if (messages.length)
          throw new Error(
            'Anthropic system messages must precede conversation messages',
          );
        system += '\n\n' + message.content;
        continue;
      }
      let role: 'user' | 'assistant';
      let content: ContentBlockParam[];
      if (message.role === 'tool') {
        role = 'user';
        content = [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id!,
            content: message.attachments?.length
              ? anthropicContent(
                  commandExecutionModelContent(message),
                  message.attachments,
                )
              : commandExecutionModelContent(message),
            is_error: message.status === 'error',
          },
        ];
      } else if (message.role === 'assistant') {
        role = 'assistant';
        content = message.provider_content
          ? ([...message.provider_content] as ContentBlockParam[])
          : [
              // Anthropic rejects a text block of only white space.
              ...(message.content?.trim()
                ? [{ type: 'text' as const, text: message.content }]
                : []),
              ...(message.tool_calls ?? []).map((call) => ({
                type: 'tool_use' as const,
                id: call.id,
                name: call.name,
                input: call.args,
              })),
            ];
      } else {
        role = 'user';
        content = anthropicContent(
          commandExecutionModelContent(message),
          message.attachments,
        );
      }
      // A thinking-only partial saved when a turn was stopped, or an empty
      // prompt, has no block to send, and Anthropic rejects an empty message.
      // It stays in history.
      if (!content.length) continue;
      const previous = messages.at(-1);
      if (previous?.role === role && Array.isArray(previous.content))
        previous.content.push(...content);
      else messages.push({ role, content });
    }
    const body: MessageCreateParamsNonStreaming = {
      model: this.model,
      system,
      messages,
      max_tokens: request.maxTokens ?? this.outputBudget ?? 32000,
    };
    if (request.tools.length)
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: { ...tool.parameters, type: 'object' },
      }));
    const effort = this.effortFor(request);
    if (request.effort === '') {
      // Omitting `thinking` leaves glm-5.3 free to reason until max_tokens.
      // `{type: 'disabled'}` is the switch it accepts.
      body.thinking = { type: 'disabled' };
    } else if (effort) {
      const profile = modelProfile('anthropic', this.model);
      const claude = this.model
        .toLowerCase()
        .split('/')
        .at(-1)
        ?.startsWith('claude');
      if (claude && profile && !profile.reasoning_effort_levels?.length) {
        const requested = THINKING_BUDGET[effort] ?? 16000;
        const budget =
          requested >= body.max_tokens
            ? Math.max(1024, Math.floor(body.max_tokens / 2))
            : requested;
        if (budget < body.max_tokens)
          body.thinking = { type: 'enabled', budget_tokens: budget };
      } else {
        if (claude) body.thinking = { type: 'adaptive' };
        body.output_config = {
          effort: (profile?.reasoning_effort_levels?.length
            ? fitEffort(effort, profile.reasoning_effort_levels)
            : effort) as NonNullable<
            MessageCreateParamsNonStreaming['output_config']
          >['effort'],
        };
      }
    }
    if (
      body.thinking &&
      (body.thinking.type === 'adaptive' || body.thinking.type === 'enabled') &&
      supportsThinkingDisplay('anthropic', this.model)
    ) {
      body.thinking.display = 'summarized';
    }
    return body;
  }
  /**
   * Marks the two places an Anthropic endpoint may cache up to. It caches nothing unasked,
   * so without them every step pays for the whole conversation again. The end of the system
   * prompt holds the tools too, which are rendered before it, and stays readable when the
   * conversation is compacted or a new one starts in the same folder. The end of the
   * conversation moves with every request: the next one reads this one back and writes only
   * what was added. The request's own blocks are marked, never the stored message's.
   */
  private markCache(body: MessageCreateParamsNonStreaming): boolean {
    const cache = this.cacheBreakpoint();
    if (!cache) return false;
    let marked = false;
    if (typeof body.system === 'string' && body.system.trim()) {
      body.system = [{ type: 'text', text: body.system, cache_control: cache }];
      marked = true;
    }
    for (let at = body.messages.length - 1; at >= 0; at--) {
      const content = body.messages[at]!.content;
      if (!Array.isArray(content)) continue;
      for (let index = content.length - 1; index >= 0; index--) {
        const block = content[index]!;
        // Thinking takes no breakpoint, and Anthropic refuses an empty text block.
        if (
          !['text', 'image', 'document', 'tool_use', 'tool_result'].includes(
            block.type,
          ) ||
          (block.type === 'text' && !block.text.trim())
        )
          continue;
        content[index] = {
          ...block,
          cache_control: cache,
        } as ContentBlockParam;
        return true;
      }
    }
    return marked;
  }
  private async sendAnthropic(request: ModelRequest): Promise<ModelResponse> {
    const body = this.anthropicBody(request);
    const cached = this.markCache(body);
    this.configureBody(body as unknown as Record<string, unknown>);
    // Breakpoints sit on blocks, not at the top of the body where the sent fields are read.
    if (cached) this.sentParameters.getStore()?.add('cache_control');
    const observe = this.observeRequest(request, body);
    // Consume the SDK's raw stream so tool JSON cannot throw inside its message
    // accumulator before later usage and stop events have been read.
    const stream = await this.anthropic!.messages.create(
      { ...body, stream: true },
      {
        signal: request.signal,
        timeout: this.requestTimeout(request),
      },
    );
    const stopStream = () => {
      try {
        stream.controller.abort();
      } catch {
        /* The body is already closed. */
      }
    };
    request.signal.addEventListener('abort', stopStream, { once: true });
    request.progress?.('connected');
    let snapshot: Anthropic.Message | undefined;
    let outputUsageReported = false;
    const inputParts = new Map<number, string>();
    let messageStopped = false;
    let guardedStop = false;
    try {
      for await (const event of stream) {
        if (request.signal.aborted) break;
        if (event.type === 'message_start') {
          snapshot = structuredClone(event.message);
          observe('usage', {
            input_tokens:
              (snapshot.usage.input_tokens ?? 0) +
              (snapshot.usage.cache_read_input_tokens ?? 0) +
              (snapshot.usage.cache_creation_input_tokens ?? 0),
            output_tokens: snapshot.usage.output_tokens ?? 0,
            cache_read_tokens: snapshot.usage.cache_read_input_tokens ?? 0,
          });
          for (const block of snapshot.content) {
            if (block.type === 'text' && block.text) request.token(block.text);
            else if (block.type === 'thinking' && block.thinking)
              request.token(block.thinking, true);
          }
        } else if (!snapshot) {
          throw new Error('Anthropic stream event preceded message_start');
        } else if (event.type === 'message_delta') {
          outputUsageReported ||= Number.isFinite(event.usage.output_tokens);
          Object.assign(snapshot, event.delta);
          // Usage events are cumulative, including cache categories when present.
          // Null means omitted, not zero; preserve known counters as the SDK does.
          Object.assign(
            snapshot.usage,
            Object.fromEntries(
              Object.entries(event.usage).filter(([, value]) => value != null),
            ),
          );
          observe(
            'usage',
            {
              input_tokens:
                snapshot.usage.input_tokens +
                (snapshot.usage.cache_read_input_tokens ?? 0) +
                (snapshot.usage.cache_creation_input_tokens ?? 0),
              output_tokens: snapshot.usage.output_tokens,
              cache_read_tokens: snapshot.usage.cache_read_input_tokens ?? 0,
              ...(snapshot.usage.cache_creation_input_tokens
                ? {
                    cache_write_tokens:
                      snapshot.usage.cache_creation_input_tokens,
                  }
                : {}),
            },
            snapshot.stop_reason
              ? completion('anthropic', snapshot.stop_reason, body.max_tokens)
              : undefined,
          );
        } else if (event.type === 'content_block_start') {
          const block = structuredClone(event.content_block);
          snapshot.content[event.index] = block;
          if (block.type === 'text' && block.text) request.token(block.text);
          else if (block.type === 'thinking' && block.thinking)
            request.token(block.thinking, true);
        } else if (event.type === 'content_block_delta') {
          const block = snapshot.content[event.index];
          const delta = event.delta;
          if (block?.type === 'text' && delta.type === 'text_delta')
            block.text += delta.text;
          else if (block?.type === 'text' && delta.type === 'citations_delta')
            block.citations = [...(block.citations ?? []), delta.citation];
          else if (
            block?.type === 'thinking' &&
            delta.type === 'thinking_delta'
          )
            block.thinking += delta.thinking;
          else if (
            block?.type === 'thinking' &&
            delta.type === 'signature_delta'
          )
            block.signature = delta.signature;
        }
        if (event.type === 'message_stop') messageStopped = true;
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'input_json_delta'
        ) {
          inputParts.set(
            event.index,
            (inputParts.get(event.index) ?? '') + event.delta.partial_json,
          );
        }
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        )
          request.token(event.delta.text);
        else if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'thinking_delta'
        )
          request.token(event.delta.thinking, true);
        else
          // A tool call's arguments are content as they stream, and keep the stream alive
          request.progress?.(
            (event.type === 'content_block_start' &&
              event.content_block.type === 'tool_use') ||
              (event.type === 'content_block_delta' &&
                event.delta.type === 'input_json_delta')
              ? 'tool'
              : event.type === 'message_start' || event.type === 'message_delta'
                ? 'usage'
                : 'keepalive',
          );
      }
    } catch (error) {
      if (error instanceof TextRepetitionLoop && error.answered && snapshot) {
        guardedStop = true;
        request.notice?.({ event: 'repetition_stopped', period: error.period });
      } else throw error;
    } finally {
      request.signal.removeEventListener('abort', stopStream);
      stream.controller.abort();
    }
    request.signal.throwIfAborted();
    if (!snapshot)
      throw new MissingFinish(
        {
          message: {
            id: randomUUID(),
            role: 'assistant',
            model: this.model,
            content: '',
            truncated: true,
            completion: completion('anthropic', null, body.max_tokens),
          },
          usage: emptyUsage(),
        },
        false,
      );
    const final = snapshot;
    const missingFinish = !final.stop_reason || !messageStopped;
    const tool_calls: ToolCall[] = [];
    let content = '';
    let thinking = '';
    for (const [index, block] of final.content.entries()) {
      if (block.type === 'text') content += block.text;
      else if (block.type === 'thinking') thinking += block.thinking;
      else if (block.type === 'server_tool_use' && inputParts.has(index)) {
        block.input = parseToolInput(inputParts.get(index)!);
      } else if (block.type === 'tool_use') {
        const raw = inputParts.get(index);
        const originalInput = block.input;
        let args = raw === undefined ? originalInput : parseToolInput(raw);
        if (typeof args === 'string') args = parseToolInput(args);
        // Raw fragments remain on the call as evidence. Keep the replayable
        // provider block valid even when those fragments are unfinished JSON.
        block.input = isRecord(args) ? args : {};
        tool_calls.push({
          id: block.id,
          name: block.name,
          args: isRecord(args) ? args : {},
          ...(!isRecord(args)
            ? {
                raw_args: raw ?? JSON.stringify(originalInput),
                argument_error:
                  'tool arguments must be a JSON object; repair the call before retrying',
              }
            : {}),
        });
      }
    }
    const response: ModelResponse = {
      message: {
        id: randomUUID(),
        role: 'assistant',
        model: final.model,
        content,
        thinking,
        tool_calls,
        provider_content: final.content,
        ...(typeof final.usage.cache_read_input_tokens === 'number' ||
        typeof final.usage.cache_creation_input_tokens === 'number'
          ? {}
          : { cache_reported: false }),
        completion: {
          ...completion(
            'anthropic',
            final.stop_reason,
            body.max_tokens,
            guardedStop,
          ),
          ...(missingFinish && !guardedStop
            ? { reason: 'missing' as const }
            : {}),
        },
        thinking_scope: this.thinkingScope,
        ...(request.enforceBudget ? { request_budget: observe.budget } : {}),
        ...(guardedStop ||
        missingFinish ||
        final.stop_reason === 'max_tokens' ||
        final.stop_reason === 'model_context_window_exceeded'
          ? { truncated: true }
          : {}),
      },
      usage: {
        input_tokens:
          (final.usage.input_tokens ?? 0) +
          (final.usage.cache_read_input_tokens ?? 0) +
          (final.usage.cache_creation_input_tokens ?? 0),
        output_tokens: final.usage.output_tokens ?? 0,
        cache_read_tokens: final.usage.cache_read_input_tokens ?? 0,
        ...(final.usage.cache_creation_input_tokens
          ? { cache_write_tokens: final.usage.cache_creation_input_tokens }
          : {}),
        ...(final.usage.cache_creation?.ephemeral_1h_input_tokens
          ? {
              cache_write_1h_tokens:
                final.usage.cache_creation.ephemeral_1h_input_tokens,
            }
          : {}),
      },
      ...(!outputUsageReported || !Number.isFinite(final.usage.input_tokens)
        ? { usageReported: false }
        : {}),
    };
    observe(
      'end',
      response.usageReported === false ? undefined : response.usage,
      response.message.completion,
    );
    if (missingFinish && !guardedStop)
      throw new MissingFinish(
        response,
        Boolean(content || thinking || tool_calls.length),
      );
    if (final.stop_reason === 'max_tokens' && !content && !tool_calls.length)
      request.notice?.({
        event: 'output_budget_exhausted',
        finish_reason: final.stop_reason,
      });
    return response;
  }
}

/** The namespace a ChatGPT plan request groups Circle's function tools in. */
const PLAN_TOOL_NAMESPACE = 'circle';
/**
 * Fetch for the ChatGPT plan route: request bodies go zstd-compressed, which the route
 * decodes, so a long conversation with its encrypted reasoning stays under the route's
 * limit for plain bodies.
 */
const compressedFetch: typeof fetch = (input, init) => {
  if (typeof init?.body !== 'string') return fetch(input, init);
  const headers = new Headers(init.headers);
  headers.set('Content-Encoding', 'zstd');
  return fetch(input, {
    ...init,
    headers,
    body: zstdCompressSync(Buffer.from(init.body)),
  });
};
/** Streamed function calls as Circle stores them; a broken one keeps its raw text as evidence. */
function finishedToolCalls(
  calls: { id: string; name: string; args: string }[],
): ToolCall[] {
  return calls.map((call) => {
    const incomplete = !call.id || !call.name;
    let args = parseToolInput(call.args || '{}');
    if (typeof args === 'string') args = parseToolInput(args);
    return {
      id: call.id || randomUUID(),
      name: call.name || 'incomplete_tool_call',
      args: isRecord(args) ? args : {},
      ...(incomplete || !isRecord(args)
        ? {
            raw_args: call.args,
            argument_error: incomplete
              ? 'incomplete tool call; repair the call before retrying'
              : 'tool arguments must be a JSON object; repair the call before retrying',
          }
        : {}),
    };
  });
}

function isThinkingBlock(block: unknown): boolean {
  return (
    isRecord(block) &&
    ['thinking', 'redacted_thinking'].includes(String(block.type))
  );
}

/** Imported sessions can reuse ids; rejection belongs to this exact signed payload. */
function thinkingIdentity(message: Message): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        message.id,
        message.provider_content?.filter(isThinkingBlock),
        message.reasoning_items,
      ]),
    )
    .digest('hex');
}
