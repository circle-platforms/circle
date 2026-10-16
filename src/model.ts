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
import { modelProfile, fitEffort, THINKING_BUDGET } from './model_profiles.js';
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
  /** Parameters each in-flight request actually sent. A parallel title request must not
   * replace the turn's set, or a 400 would drop the wrong field. */
  private readonly sentNow = new Set<Set<string>>();
  /** Finished bodies, newest last. Drop runs after the request returns. */
  private readonly sentRecent: Set<string>[] = [];
  private readonly thinkingScope: string;
  private readonly rejectedThinking = new Set<string>();
  private readonly guard: ModelGuard;
  readonly catalog: ModelCatalog;
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
  get downgrades(): Record<string, string> {
    return Object.fromEntries(this.guard.downgrades);
  }
  private dropParameter(parameter: string): boolean {
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
      ![...this.sentNow, ...this.sentRecent].some((sent) => sent.has(root)) ||
      this.dropped.has(root)
    )
      return false;
    this.dropped.add(root);
    return true;
  }
  private configureBody(body: Record<string, unknown>): Set<string> {
    for (const field of this.dropped) delete body[field];
    const sent = new Set(Object.keys(body));
    this.sentNow.add(sent);
    return sent;
  }
  private releaseBody(sent: Set<string>): void {
    this.sentNow.delete(sent);
    // The guard drops a rejected field after this request has already returned.
    // Keep a few finished bodies so that drop still sees what was sent, including
    // when a title request is in flight beside the turn.
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
    const sent = this.configureBody(body as unknown as Record<string, unknown>);
    try {
      const stream = await this.openai!.chat.completions.create(body, {
        signal: request.signal,
        timeout: this.requestTimeout(request),
      });
      request.progress?.('connected');
      let content = '';
      let thinking = '';
      let finish = '';
      let servedModel = this.model;
      const calls = new Map<
        number,
        { id: string; name: string; args: string }
      >();
      const usage = emptyUsage();
      let cacheReported = false;
      let guardedStop = false;
      try {
        for await (const chunk of stream) {
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
              usage.cache_read_tokens = Math.max(
                usage.cache_read_tokens,
                cached,
              );
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
            const call = calls.get(part.index) ?? {
              id: '',
              name: '',
              args: '',
            };
            if (part.id) call.id = part.id;
            if (part.function?.name) call.name += part.function.name;
            if (part.function?.arguments) call.args += part.function.arguments;
            calls.set(part.index, call);
          }
        }
      } catch (error) {
        if (error instanceof TextRepetitionLoop && error.answered) {
          guardedStop = true;
          request.notice?.({
            event: 'repetition_stopped',
            period: error.period,
          });
        } else throw error;
      } finally {
        stream.controller.abort();
      }
      request.signal.throwIfAborted();
      const tool_calls: ToolCall[] = [...calls.values()].map((call) => {
        if (!call.id || !call.name) throw new Error('incomplete tool call');
        let args = parseToolInput(call.args || '{}');
        if (typeof args === 'string') args = parseToolInput(args);
        return {
          id: call.id,
          name: call.name,
          args: isRecord(args) ? args : {},
          ...(!isRecord(args)
            ? {
                raw_args: call.args,
                argument_error:
                  'tool arguments must be a JSON object; repair the call before retrying',
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
    } finally {
      this.releaseBody(sent);
    }
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
    const sent = this.configureBody(body as unknown as Record<string, unknown>);
    try {
      const stream = this.anthropic!.messages.stream(body, {
        signal: request.signal,
        timeout: this.requestTimeout(request),
      });
      stream.on('connect', () => request.progress?.('connected'));
      let snapshot: Anthropic.Message | undefined;
      let guardedStop = false;
      try {
        for await (const event of stream) {
          snapshot = stream.currentMessage ?? snapshot;
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
                : event.type === 'message_start' ||
                    event.type === 'message_delta'
                  ? 'usage'
                  : 'keepalive',
            );
        }
      } catch (error) {
        if (error instanceof TextRepetitionLoop && error.answered && snapshot) {
          guardedStop = true;
          request.notice?.({
            event: 'repetition_stopped',
            period: error.period,
          });
        } else throw error;
      } finally {
        if (guardedStop) {
          stream.abort();
          await stream.finalMessage().catch(() => {});
        }
      }
      const final = guardedStop ? snapshot! : await stream.finalMessage();
      request.signal.throwIfAborted();
      const tool_calls: ToolCall[] = [];
      let content = '';
      let thinking = '';
      for (const block of final.content) {
        if (block.type === 'text') content += block.text;
        else if (block.type === 'thinking') thinking += block.thinking;
        else if (block.type === 'tool_use')
          tool_calls.push({
            id: block.id,
            name: block.name,
            args: block.input as Record<string, unknown>,
          });
      }
      const response: ModelResponse = {
        message: {
          id: randomUUID(),
          role: 'assistant',
          model: final.model,
          content,
          thinking,
          tool_calls,
          ...(typeof final.usage.cache_read_input_tokens === 'number' ||
          typeof final.usage.cache_creation_input_tokens === 'number'
            ? {}
            : { cache_reported: false }),
          provider_content: final.content,
          thinking_scope: this.thinkingScope,
          ...(guardedStop ||
          !final.stop_reason ||
          final.stop_reason === 'max_tokens'
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
      if (!final.stop_reason && !guardedStop)
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
    } finally {
      this.releaseBody(sent);
    }
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
