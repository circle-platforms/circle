import { createHash, createHmac, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatCompletionMessageParam,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import type {
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
import { loadCredentials, type CircleSettings } from './settings.js';
import {
  ModelGuard,
  MissingFinish,
  TextRepetitionLoop,
  type GuardOptions,
  isThinkingSignatureError,
} from './model_guard.js';
import { parseToolInput } from './tool_call_compat.js';
import { isRecord } from './settings.js';
import { circleHome } from './paths.js';
import { ModelCatalog, type ModelFacts } from './model_catalog.js';
import {
  modelProfile,
  fitEffort,
  THINKING_BUDGET,
  supportsThinkingDisplay,
} from './model_profiles.js';
import { priceCall } from './pricing.js';
import { isNetworkFailure, networkError } from './net.js';
import {
  checkRequestMedia,
  openAIContent,
  anthropicContent,
} from './model_media.js';
import { orderModeToolResults } from './tool_history.js';
export const EFFORT_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
function completion(
  protocol: 'openai' | 'anthropic',
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
  private openai?: OpenAI;
  private anthropic?: Anthropic;
  // How long a request waits for the answer to start (`CIRCLE_LLM_TIMEOUT`)
  private readonly timeout: number;
  effort: string;
  private readonly dropped = new Set<string>();
  /**
   * Parameters the latest requests sent, newest last. Each request keeps its own set:
   * a title request beside the turn must not replace the turn's, or a 400 would drop
   * the wrong field. The guard drops a field after its request returned.
   */
  private readonly sentRecent: Set<string>[] = [];
  private readonly thinkingScope: string;
  private readonly rejectedThinking = new Set<string>();
  private readonly guard: ModelGuard;
  readonly catalog: ModelCatalog;
  private readonly searchConnection: import('./native_websearch.js').NativeSearchConnection;
  /** A snapshot of the same connection used by the main model client. Never persisted. */
  webSearchConnection(): import('./native_websearch.js').NativeSearchConnection {
    return { ...this.searchConnection };
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
    const credentials = loadCredentials(home);
    const apiKey =
      credentials[settings.auth.api_key_ref] || credentials.api_key;
    if (!apiKey) throw new Error('missing API key; re-run circle --init');
    this.searchConnection = Object.freeze({
      baseUrl: settings.auth.base_url,
      protocol: settings.auth.protocol === 'anthropic' ? 'anthropic' : 'openai',
      model: this.model,
      apiKey,
    });
    // Keyed identity lets saved history detect account/endpoint/model changes without
    // storing a key or endpoint in the transcript. Rotation conservatively drops replay.
    this.thinkingScope = createHmac('sha256', apiKey)
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
      apiKey,
      baseURL: settings.auth.base_url,
      timeout: this.timeout,
      maxRetries: 0,
    };
    if (settings.auth.protocol === 'anthropic')
      this.anthropic = new Anthropic(options);
    else this.openai = new OpenAI(options);
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
    request = { ...request, messages: orderModeToolResults(request.messages) };
    checkRequestMedia(request.messages);
    let response: ModelResponse;
    try {
      response = await this.guard.execute(request, (current) =>
        this.anthropic
          ? this.completeAnthropic(current)
          : this.completeOpenAI(current),
      );
    } catch (error) {
      if (request.signal.aborted || !isNetworkFailure(error)) throw error;
      throw networkError(error, this.settings.auth.base_url);
    }
    response.message.cost = priceCall(
      this.catalog.facts(
        response.message.model || this.model,
        this.settings,
        modelProfile(this.settings.auth.protocol, this.model)?.max_input_tokens,
      ),
      response.usage,
    );
    return response;
  }
  get modelFacts(): ModelFacts {
    return this.catalog.facts(
      this.model,
      this.settings,
      modelProfile(this.settings.auth.protocol, this.model)?.max_input_tokens,
    );
  }
  get contextWindow(): number {
    return this.modelFacts.contextWindow;
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
      modelProfile(this.settings.auth.protocol, this.model)?.image_inputs
    );
  }
  get outputBudget(): number | undefined {
    if (!this.anthropic) return undefined;
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
        this.modelFacts.outputLimit ?? profile?.max_output_tokens ?? Infinity,
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
    return this.sentRecent.some((sent) => sent.has(parameter));
  }
  get downgrades(): Record<string, string> {
    return Object.fromEntries(this.guard.downgrades);
  }
  private dropParameter(parameter: string): boolean {
    if (parameter === 'thinking.display') {
      if (
        !this.anthropic ||
        !this.sent(parameter) ||
        this.dropped.has(parameter)
      )
        return false;
      this.dropped.add(parameter);
      return true;
    }
    let root = parameter.split('.')[0]!;
    if (root === 'effort')
      root = this.anthropic ? 'output_config' : 'reasoning_effort';
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
      ].includes(root) ||
      !this.sent(root) ||
      this.dropped.has(root)
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
    this.sentRecent.push(sent);
    if (this.sentRecent.length > 8) this.sentRecent.shift();
  }
  private async completeOpenAI(request: ModelRequest): Promise<ModelResponse> {
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
      if (message.role === 'system')
        messages.push({ role: 'system', content: message.content });
      else if (message.role === 'tool') {
        messages.push({
          role: 'tool',
          content: message.content,
          tool_call_id: message.tool_call_id!,
        });
        toolMedia.push(...(message.attachments ?? []));
      } else if (message.role === 'assistant')
        messages.push({
          role: 'assistant',
          content: message.content || null,
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
      else
        messages.push({
          role: 'user',
          content: message.attachments?.length
            ? openAIContent(message.content, message.attachments)
            : message.content,
        });
    }
    flushToolMedia();
    const body: ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
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
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    this.configureBody(body as unknown as Record<string, unknown>);
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
    let cacheReported = false;
    let guardedStop = false;
    try {
      for await (const chunk of stream) {
        if (request.signal.aborted) break;
        if (chunk.model) servedModel = chunk.model;
        if (chunk.usage) {
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
    const tool_calls: ToolCall[] = [...calls.values()].map((call) => {
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
    const response: ModelResponse = {
      message: {
        id: randomUUID(),
        role: 'assistant',
        model: servedModel,
        content,
        thinking,
        tool_calls,
        ...(cacheReported ? {} : { cache_reported: false }),
        completion: completion('openai', finish, undefined, guardedStop),
        ...(guardedStop || !finish || finish === 'length'
          ? { truncated: true }
          : {}),
      },
      usage,
    };
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
  private async sendAnthropic(request: ModelRequest): Promise<ModelResponse> {
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
              ? anthropicContent(message.content, message.attachments)
              : message.content,
            is_error: message.status === 'error',
          },
        ];
      } else if (message.role === 'assistant') {
        role = 'assistant';
        content = message.provider_content
          ? ([...message.provider_content] as ContentBlockParam[])
          : [
              ...(message.content
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
        content = anthropicContent(message.content, message.attachments);
      }
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
    this.configureBody(body as unknown as Record<string, unknown>);
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
    const inputParts = new Map<number, string>();
    let messageStopped = false;
    let guardedStop = false;
    try {
      for await (const event of stream) {
        if (request.signal.aborted) break;
        if (event.type === 'message_start') {
          snapshot = structuredClone(event.message);
          for (const block of snapshot.content) {
            if (block.type === 'text' && block.text) request.token(block.text);
            else if (block.type === 'thinking' && block.thinking)
              request.token(block.thinking, true);
          }
        } else if (!snapshot) {
          throw new Error('Anthropic stream event preceded message_start');
        } else if (event.type === 'message_delta') {
          Object.assign(snapshot, event.delta);
          // Usage events are cumulative, including cache categories when present.
          // Null means omitted, not zero; preserve known counters as the SDK does.
          Object.assign(
            snapshot.usage,
            Object.fromEntries(
              Object.entries(event.usage).filter(([, value]) => value != null),
            ),
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
        ...(guardedStop ||
        missingFinish ||
        final.stop_reason === 'max_tokens' ||
        final.stop_reason === 'model_context_window_exceeded'
          ? { truncated: true }
          : {}),
      },
      usage: {
        input_tokens:
          final.usage.input_tokens +
          (final.usage.cache_read_input_tokens ?? 0) +
          (final.usage.cache_creation_input_tokens ?? 0),
        output_tokens: final.usage.output_tokens,
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
    };
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
      ]),
    )
    .digest('hex');
}
