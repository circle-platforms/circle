import { randomUUID, createHash } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, join, relative, isAbsolute } from 'node:path';
import { AgentRuntime, type InteractionContext } from '../../../src/runtime.js';
import type {
  ChatModel,
  ToolCall,
  Message as CoreMessage,
  MediaAttachment,
} from '../../../src/types.js';
import type { ApprovalDecision } from '../../../src/harness.js';
import {
  loadSettings,
  settingsForRun,
  saveSettings,
  saveCredentials,
  clearCredentials,
  withConnection,
  isFolderTrusted,
  trustFolder,
  isReady,
  writePrivateJson,
  loadCredentials,
  type CircleSettings,
} from '../../../src/settings.js';
import {
  discoverCustomCommands,
  substituteArguments,
  splitArguments,
} from '../../../src/commands.js';
import { loadSkillBody } from '../../../src/skills.js';
import { attachmentFromBase64 } from '../../../src/media.js';
import { readPrompt } from '../../../src/system_prompt.js';
import { toMarkdown, toHtml } from '../../../src/session_export.js';
import { normalizeBaseUrl, resolveEndpoint } from '../../../src/probe.js';
import { availableUpdate } from '../../../src/update.js';
import { BUILTIN_SLASH } from '../../../src/tui/slash_commands.js';
import { ModelCatalog } from '../../../src/model_catalog.js';
import { VERSION } from '../../../src/version.js';
class DisconnectedModel implements ChatModel {
  model = 'not connected';
  async complete(): Promise<never> {
    throw Error('connect an API URL, key and model first');
  }
}
import {
  submitAnswer,
  cancelRequest,
  type SecretRequest,
} from '../../../src/secret_prompt.js';
import { elapsed, outputTail } from '../../../src/jobs.js';
import type { CircleEvent } from '../../../src/events.js';
import type {
  WorkbenchSnapshot,
  Session,
  Message,
  Interaction,
  Effort,
} from '../../workbench/src/model/types';
import {
  validateRuntimeCommand,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeUpdate,
} from './runtime-protocol';

const identity = (path: string) =>
  createHash('sha256').update(path).digest('hex').slice(0, 24);
const text = (value: unknown, label: string, max = 1_000_000) => {
  if (typeof value !== 'string' || value.length > max)
    throw Error(`invalid ${label}`);
  return value;
};
const flag = (value: unknown) => {
  if (typeof value !== 'boolean') throw Error('boolean required');
  return value;
};
interface Pending {
  row: Interaction;
  signal: AbortSignal;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  secret?: SecretRequest;
}
interface Streaming {
  id: string;
  text: string;
  thinking: string;
}
export interface ControllerOptions {
  home: string;
  workspace?: string;
  userHome?: string;
  model?: ChatModel;
  catalog?: (home: string) => ModelCatalog;
  emit: (update: RuntimeUpdate) => void;
}

/** The IPC adapter delegates execution and persistence to the existing Circle core. */
export class RuntimeController {
  readonly home: string;
  private runtimes = new Map<string, AgentRuntime>();
  private active!: AgentRuntime;
  private previous: string | null = null;
  private sequence = 0;
  private pending = new Map<string, Pending>();
  private history: Interaction[] = [];
  private streams = new Map<string, Streaming>();
  private activeRuns = new Set<string>();
  private toolStates = new Map<
    string,
    { status: 'running' | 'waiting' | 'error' | 'success'; output?: string }
  >();
  private error?: string;
  private closing = false;
  private mutation = Promise.resolve();
  private accepted = new Map<
    string,
    { signature: string; reply: Promise<RuntimeReply> }
  >();
  private tasks = new Set<Promise<unknown>>();
  private discoveredModels: string[] = [];
  constructor(readonly options: ControllerOptions) {
    this.home = options.home;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const saved = this.savedLocation();
    const workspace =
      options.workspace ?? saved?.workspace ?? join(this.home, 'workspace');
    mkdirSync(workspace, { recursive: true });
    // The empty, app-owned scratch workspace is safe to initialize without user files.
    if (workspace === join(this.home, 'workspace'))
      saveSettings(trustFolder(loadSettings(this.home), workspace), this.home);
    this.active = this.runtime(workspace, saved?.sessionId);
  }
  private savedLocation():
    { workspace: string; sessionId: string } | undefined {
    try {
      const data = JSON.parse(
        readFileSync(join(this.home, 'desktop-session.json'), 'utf8'),
      );
      if (
        typeof data.workspace === 'string' &&
        existsSync(data.workspace) &&
        typeof data.sessionId === 'string'
      )
        return data;
    } catch {
      /* First launch has no active session. */
    }
    return undefined;
  }
  private runtime(workspace: string, sessionId?: string): AgentRuntime {
    workspace = realpathSync(workspace);
    const existing = this.runtimes.get(workspace);
    if (existing) return existing;
    const settings = settingsForRun(this.home, workspace).settings;
    const create = (session?: string) =>
      new AgentRuntime({
        workspace,
        home: this.home,
        userHome: this.options.userHome,
        localContext: isFolderTrusted(settings, workspace),
        settings,
        model:
          this.options.model ??
          (isReady(settings) ? undefined : new DisconnectedModel()),
        catalog: this.options.catalog?.(this.home),
        session,
        approve: (call, signal, origin) =>
          this.approve(runtime, call, signal, origin),
        question: (args, signal, origin) =>
          this.question(runtime, args, signal, origin),
        secret: (request, signal, origin) =>
          this.secret(runtime, request, signal, origin),
      });
    // A missing/deleted session is not a reason to discard other sessions.
    let runtime: AgentRuntime;
    try {
      runtime = create(sessionId);
    } catch (error) {
      if (sessionId && String(error).includes('unknown session'))
        runtime = create();
      else throw error;
    }
    runtime.bus.subscribe((event) => this.event(runtime, event));
    this.runtimes.set(workspace, runtime);
    return runtime;
  }
  private persistLocation() {
    writePrivateJson(join(this.home, 'desktop-session.json'), {
      workspace: this.active.options.workspace,
      sessionId: this.active.session.id,
    });
  }
  private projectMessages(runtime: AgentRuntime, id: string): Message[] {
    const nodes = runtime.store.tree(id);
    const labels = runtime.store.labels(id);
    const result: Message[] = [];
    const calls = new Map<string, Message>();
    for (const node of nodes) {
      const raw = node.message;
      if (!raw || raw.internal || raw.role === 'system') continue;
      if (raw.role === 'tool') {
        const call = calls.get(raw.tool_call_id ?? '');
        if (call?.tool) {
          result.splice(result.indexOf(call), 1);
          result.push({
            ...call,
            id: node.id,
            parentId: node.parent,
            tool: {
              ...call.tool,
              output: raw.content,
              status: raw.status ?? 'success',
            },
          });
        } else
          result.push({
            id: node.id,
            parentId: node.parent,
            role: 'tool',
            text: raw.content,
            at: new Date(node.created).toISOString(),
          });
        continue;
      }
      const base: Message = {
        id: node.id,
        parentId: node.parent,
        role: raw.role,
        text: raw.display ?? raw.content,
        thinking: raw.thinking,
        label: labels[raw.id],
        at: new Date(node.created).toISOString(),
        attachments: raw.attachments?.map((a, index) => ({
          id: `${node.id}-attachment-${index}`,
          name: a.filename,
          kind: a.kind,
          content: a.data,
          mime: a.mime_type,
        })),
        usage: raw.usage
          ? {
              input: raw.usage.input_tokens,
              output: raw.usage.output_tokens,
              cost: null,
              elapsed: '',
            }
          : undefined,
      };
      if (
        raw.role !== 'assistant' ||
        base.text ||
        base.thinking ||
        base.attachments?.length
      )
        result.push(base);
      for (const call of raw.tool_calls ?? []) {
        const state = this.toolStates.get(`${id}:${call.id}`);
        const row: Message = {
          id: `${node.id}:${call.id}`,
          parentId: node.id,
          role: 'tool',
          text: '',
          at: base.at,
          tool: {
            id: call.id,
            name: call.name,
            input: call.args,
            output: state?.output ?? '',
            status: state?.status ?? 'unknown',
            filePath:
              String(call.args.file_path ?? call.args.path ?? '') || undefined,
          },
        };
        calls.set(call.id, row);
        result.push(row);
      }
    }
    const stream = this.streams.get(id);
    if (stream && (stream.text || stream.thinking))
      result.push({
        id: stream.id,
        parentId: runtime.store.get(id)?.head ?? null,
        role: 'assistant',
        text: stream.text,
        thinking: stream.thinking,
        at: 'streaming',
      });
    return result;
  }
  snapshot(): WorkbenchSnapshot {
    const runtime = this.active;
    const settings = runtime.options.settings;
    const savedSettings = loadSettings(this.home);
    const rows = runtime.store.list();
    const paths = [
      ...new Set([
        ...rows.map((row) => row.workspace),
        runtime.options.workspace,
      ]),
    ];
    const sessions: Session[] = rows.map((row) => {
      const owner = this.runtimes.get(row.workspace);
      const selected = owner?.session.id === row.id;
      const queue = selected
        ? owner.harness.queuedMessages
        : { steering: [], followUp: [] };
      const path = new Set(
        runtime.store.messages(row.id).map((message) => message.id),
      );
      const branchIds = runtime.store
        .tree(row.id)
        .filter((node) => node.message && path.has(node.message.id))
        .flatMap((node) => [
          node.id,
          ...(node.message?.tool_calls ?? []).map(
            (call) => `${node.id}:${call.id}`,
          ),
        ]);
      const stream = this.streams.get(row.id);
      if (stream) branchIds.push(stream.id);
      return {
        id: row.id,
        title: row.title || 'new session',
        workspaceId: identity(row.workspace),
        model: selected ? owner.harness.model.model : row.model,
        effort: ((selected ? owner.thinkingLevel : settings.default_thinking) ||
          'default') as Effort,
        draft: '',
        attachments: [],
        messages: this.projectMessages(runtime, row.id),
        leafId: row.head,
        branchIds,
        hiddenIds: [],
        undoStack: [],
        queue: [
          ...queue.steering.map((value, i) => ({
            id: `steer-${i}`,
            text: value,
            kind: 'steering' as const,
          })),
          ...queue.followUp.map((value, i) => ({
            id: `follow-${i}`,
            text: value,
            kind: 'follow-up' as const,
          })),
        ],
        state: selected && owner.busy ? 'waiting' : 'idle',
        readOnly: selected ? owner.harness.planMode : false,
        auto: selected ? owner.policy.yoloEnabled(row.id) : false,
        showThinking: !settings.hide_thinking,
        expandTools: false,
        todos: selected
          ? owner.todos.map((todo, i) => ({
              id: `todo-${i}`,
              text: todo.content,
              status: todo.status === 'in_progress' ? 'running' : todo.status,
            }))
          : [],
        pinned: false,
        shared: false,
        updatedAt: new Date(row.updated).toISOString(),
      };
    });
    const models = [
      ...new Set([
        settings.auth.model,
        ...this.discoveredModels,
        ...settings.enabled_models,
        ...rows.map((row) => row.model),
        runtime.harness.model.model,
      ]),
    ]
      .filter(Boolean)
      .map((id) => {
        const facts = runtime.catalog.facts(id, settings);
        return {
          id,
          provider: facts.provider,
          contextWindow: facts.windowKnown ? facts.contextWindow : null,
          inputPrice: facts.rates?.input ?? null,
          outputPrice: facts.rates?.output ?? null,
          vision: false,
        };
      });
    return {
      version: 1,
      activeSessionId: runtime.session.id,
      previousSessionId: this.previous,
      runtime: {
        connected: !this.closing,
        processId: process.pid,
        coreVersion: VERSION,
        observedAt: new Date().toISOString(),
        configured: !!this.options.model || isReady(settings),
        error: this.error,
      },
      workspaces: paths.map((path) => ({
        id: identity(path),
        name: path === join(this.home, 'workspace') ? 'circle' : basename(path),
        path,
        branch: 'local workspace',
        trusted: isFolderTrusted(settings, path),
        origin: 'native',
        instructions: [],
      })),
      sessions,
      files: [],
      agents: runtime.store
        .list(undefined, true)
        .filter((row) => row.parent_id)
        .map((row) => ({
          id: row.id,
          sessionId: row.parent_id!,
          name: row.title || 'agent',
          description: row.title,
          status: [...this.pending.values()].some(
            (pending) => pending.row.origin?.agent === row.id,
          )
            ? 'waiting'
            : this.activeRuns.has(row.id)
              ? 'running'
              : 'completed',
          model: row.model,
          tokens: 0,
          messages: this.projectMessages(runtime, row.id),
        })),
      jobs: [...this.runtimes.values()].flatMap((owner) =>
        owner.jobs.list().map((job) => ({
          id: `${job.sessionId}:${job.id}`,
          sessionId: job.sessionId,
          kind:
            job.kind === 'shell' || job.kind === 'adopted'
              ? ('command' as const)
              : job.kind,
          title: job.title,
          state:
            job.status === 'running'
              ? ('running' as const)
              : job.status === 'done'
                ? ('completed' as const)
                : ('failed' as const),
          elapsed: elapsed(job),
          output: existsSync(job.outputPath) ? outputTail(job.outputPath) : '',
          outputPath: job.virtualPath,
          stopRequested: false,
        })),
      ),
      interactions: [
        ...this.history,
        ...[...this.pending.values()].map((pending) => pending.row),
      ],
      approvalRules: sessions.flatMap((session) =>
        runtime.policy.store.rules(session.id).map((rule) => ({
          id: identity(
            JSON.stringify([session.id, rule.tool, rule.pattern, rule.at]),
          ),
          sessionId: session.id,
          description: `${rule.tool} · ${rule.label}`,
          kind: rule.pattern.startsWith('prefix:')
            ? ('prefix' as const)
            : rule.tool === 'execute'
              ? ('command' as const)
              : ('tool' as const),
        })),
      ),
      models,
      skills: runtime.skills.map((skill) => ({
        id: identity(skill.path),
        name: skill.name,
        description: skill.description,
        path: skill.path,
        scope:
          skill.source_label.startsWith('Project') ||
          skill.source_label.startsWith('Ancestor')
            ? 'project'
            : 'user',
        content: loadSkillBody(skill.name, runtime.skills),
      })),
      commands: isFolderTrusted(settings, runtime.options.workspace)
        ? [
            ...discoverCustomCommands(
              runtime.options.workspace,
              this.home,
              this.options.userHome,
            ).map((command) => ({
              name: command.name,
              description: command.description,
              arguments: command.argument_hint,
              scope: command.source.startsWith(runtime.options.workspace)
                ? ('project' as const)
                : ('user' as const),
              template: command.template,
            })),
            ...[...runtime.extensions.commands().values()].map((command) => ({
              name: command.name,
              description: command.description,
              arguments: '',
              scope: 'extension' as const,
              template: '',
            })),
          ]
        : [],
      mcp: savedSettings.mcp_servers.map((spec, i) => {
        const applied = settings.mcp_servers.find(
          (row) => row.name === spec.name,
        );
        const pendingReload = JSON.stringify(applied) !== JSON.stringify(spec);
        const status = runtime.mcp.status.find((row) => row.name === spec.name);
        return {
          id: String(spec.id ?? spec.name ?? i),
          name: String(spec.name ?? `server ${i + 1}`),
          transport: String(spec.transport ?? 'stdio') as 'stdio',
          command: String(spec.command ?? ''),
          args: Array.isArray(spec.args)
            ? spec.args.map((arg) => JSON.stringify(arg)).join(' ')
            : '',
          url: String(spec.url ?? ''),
          enabled: spec.enabled !== false,
          status: pendingReload
            ? 'reload required'
            : status
              ? status.error
                ? 'error'
                : 'connected'
              : 'not connected',
          error: status?.error,
          tools: runtime.mcp.tools
            .filter((tool) => status?.tools.includes(tool.name))
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              schema: tool.parameters,
            })),
        };
      }),
      extensions: runtime.extensions.extensions.map((extension) => ({
        id: extension.name,
        name: extension.name,
        version: '',
        scope: extension.source,
        enabled: extension.enabled,
        tools: extension.tools.map((tool) => tool.name),
        commands: extension.commands.map((command) => command.name),
        events: [...extension.handlers.keys()],
        error: extension.error || undefined,
      })),
      requests: [],
      tools: runtime.allTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        kind: tool.effect,
        detail:
          tool.approval === false
            ? 'Runs under the core tool boundary.'
            : 'Approval is enforced by the Circle core.',
        schema: tool.parameters,
      })),
      uiPlugins: ['files', 'activity', 'browser'],
      settings: {
        theme: settings.theme,
        hideThinking: settings.hide_thinking,
        defaultModel: settings.auth.model,
        defaultEffort: (settings.default_thinking || 'default') as Effort,
        enabledModels: settings.enabled_models,
        doubleEscape: settings.double_escape,
        endpoint: settings.auth.base_url,
        protocol: settings.auth.protocol as 'openai' | 'anthropic',
        credentialFiles: settings.credential_files,
        updateCheck: settings.update_check,
        uiFontSize: 13,
        codeFontSize: 12,
        keybindings: {},
      },
    };
  }
  publish(event?: RuntimeUpdate['event']) {
    if (this.closing) return;
    this.persistLocation();
    this.options.emit({
      seq: ++this.sequence,
      connected: true,
      snapshot: this.snapshot(),
      event,
    });
  }
  private event(runtime: AgentRuntime, event: CircleEvent) {
    if (runtime.isClosing) return;
    const id = String(
      event.tags?.subagent ?? event.tags?.session_id ?? runtime.session.id,
    );
    if (event.kind === 'run_start') this.activeRuns.add(id);
    if (['run_end', 'run_error'].includes(event.kind))
      this.activeRuns.delete(id);
    if (event.kind === 'llm_start')
      this.streams.set(id, {
        id: `stream-${randomUUID()}`,
        text: '',
        thinking: '',
      });
    if (event.kind === 'llm_token') {
      const stream = this.streams.get(id);
      if (stream) {
        if (event.payload.thinking)
          stream.thinking += String(event.payload.text ?? '');
        else stream.text += String(event.payload.text ?? '');
      }
    }
    if (['llm_end', 'run_end', 'run_error', 'error'].includes(event.kind))
      this.streams.delete(id);
    if (
      ['tool_waiting', 'tool_start', 'tool_result', 'tool_end'].includes(
        event.kind,
      )
    ) {
      const result = event.payload.message as CoreMessage | undefined;
      const callId = String(event.payload.id ?? result?.tool_call_id ?? '');
      this.toolStates.set(`${id}:${callId}`, {
        status:
          event.kind === 'tool_waiting'
            ? 'waiting'
            : event.kind === 'tool_start'
              ? 'running'
              : event.payload.status === 'error' || result?.status === 'error'
                ? 'error'
                : 'success',
        output:
          result?.content ?? this.toolStates.get(`${id}:${callId}`)?.output,
      });
    }
    // The bus is observation only. Enforcement remains inside Harness and awaited callbacks.
    this.publish({
      kind: event.kind,
      sessionId: id,
      payload: event.payload,
      runId: event.run_id,
      eventSeq: event.seq,
      at: event.ts,
      parentRunId: event.parent_run_id ?? undefined,
    });
  }
  private wait(
    runtime: AgentRuntime,
    row: Omit<Interaction, 'id' | 'sessionId' | 'status' | 'revision'>,
    signal: AbortSignal,
    origin?: InteractionContext,
    secret?: SecretRequest,
  ): Promise<string> {
    const id = `interaction-${randomUUID()}`;
    const interaction: Interaction = {
      ...row,
      id,
      sessionId: runtime.session.id,
      status: 'pending',
      revision: 1,
      origin: origin ? { ...origin } : undefined,
    };
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(new Error('interaction cancelled'));
        this.publish();
      };
      const finish = (answer: string) => {
        signal.removeEventListener('abort', abort);
        resolve(answer);
      };
      this.pending.set(id, {
        row: interaction,
        signal,
        resolve: finish,
        reject: (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
        secret,
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else this.publish();
    });
  }
  private async approve(
    runtime: AgentRuntime,
    call: ToolCall,
    signal: AbortSignal,
    origin?: InteractionContext,
  ): Promise<ApprovalDecision> {
    const review = runtime.policy.review(call.name, call.args);
    const answer = await this.wait(
      runtime,
      {
        kind: 'approval',
        callId: call.id,
        input: structuredClone(call.args),
        title: `${call.name} · ${review.reason}`,
        tool: call.name,
        command:
          typeof call.args.command === 'string' ? call.args.command : undefined,
        target: String(call.args.file_path ?? call.args.path ?? ''),
        after:
          typeof call.args.content === 'string' ? call.args.content : undefined,
        choices: [
          'approve',
          ...(review.verdict === 'ASK' && review.pattern ? ['always'] : []),
          ...(review.prefix.length ? ['prefix'] : []),
          'reject',
        ],
      },
      signal,
      origin,
    );
    return answer.startsWith('reject: ')
      ? { decision: 'reject', message: answer.slice(8) }
      : (answer as ApprovalDecision);
  }
  private async question(
    runtime: AgentRuntime,
    args: Record<string, unknown>,
    signal: AbortSignal,
    origin?: InteractionContext,
  ): Promise<string> {
    const questions = args.questions as {
      question: string;
      options: { label: string; description: string }[];
      multiple: boolean;
    }[];
    const answers: (string | string[])[] = [];
    for (const question of questions) {
      const answer = await this.wait(
        runtime,
        {
          kind: 'question',
          title: question.question,
          choices: question.options.map((option) => option.label),
          multiple: question.multiple,
        },
        signal,
        origin,
      );
      try {
        const value = JSON.parse(answer);
        answers.push([
          ...(Array.isArray(value.choices) ? value.choices : []),
          ...(value.comment ? [value.comment] : []),
        ]);
      } catch {
        answers.push(answer === 'cancelled' ? '' : answer);
      }
    }
    return JSON.stringify(answers);
  }
  private async secret(
    runtime: AgentRuntime,
    request: SecretRequest,
    signal: AbortSignal,
    origin?: InteractionContext,
  ): Promise<void> {
    await this.wait(
      runtime,
      { kind: 'secret', title: request.question, target: request.target_file },
      signal,
      origin,
      request,
    );
  }
  private track(task: Promise<unknown>) {
    this.tasks.add(task);
    void task
      .catch((error) => {
        if (!this.closing) {
          this.error =
            error instanceof Error ? error.message : 'runtime failed';
          this.publish();
        }
      })
      .finally(() => {
        this.tasks.delete(task);
        if (!this.closing) this.publish();
      });
  }
  async dispatch(input: unknown): Promise<RuntimeReply> {
    let command: RuntimeCommand;
    try {
      command = validateRuntimeCommand(input);
    } catch (error) {
      return {
        id: String((input as RuntimeCommand)?.id ?? 'invalid'),
        ok: false,
        error: String(error),
      };
    }
    const signature = createHash('sha256')
      .update(JSON.stringify(command))
      .digest('hex');
    const accepted = this.accepted.get(command.id);
    if (accepted)
      return accepted.signature === signature
        ? accepted.reply
        : {
            id: command.id,
            ok: false,
            error: 'command identity was reused with different input',
          };
    const operation = async (): Promise<RuntimeReply> => {
      try {
        this.error = undefined;
        if (this.closing && command.name !== 'close')
          throw Error('runtime is closing');
        // Reject stale actions after a session switch. Answer additionally binds its request origin.
        if (
          command.sessionId &&
          command.sessionId !== this.active.session.id &&
          ![
            'select-session',
            'delete-session',
            'rename-session',
            'answer',
          ].includes(command.name)
        )
          throw Error('session changed; retry from the current session');
        const data = await this.execute(command);
        if (!this.closing) this.publish();
        return { id: command.id, ok: true, data };
      } catch (error) {
        return {
          id: command.id,
          ok: false,
          error:
            error instanceof Error ? error.message : 'runtime command failed',
        };
      }
    };
    // Answers and interrupts must remain available while an asynchronous action is running.
    const immediate = [
      'answer',
      'abort',
      'state',
      'close',
      'background',
      'stop-job',
    ].includes(command.name);
    const result = immediate ? operation() : this.mutation.then(operation);
    if (!immediate) this.mutation = result.then(() => {});
    if (!['state', 'export'].includes(command.name)) {
      this.accepted.set(command.id, { signature, reply: result });
      if (this.accepted.size > 100)
        this.accepted.delete(this.accepted.keys().next().value!);
    }
    return result;
  }
  private async execute(command: RuntimeCommand): Promise<unknown> {
    const p = command.payload;
    let runtime = this.active;
    switch (command.name) {
      case 'state':
        return this.snapshot();
      case 'prompt': {
        if (
          !isFolderTrusted(runtime.options.settings, runtime.options.workspace)
        )
          throw Error('trust the workspace before running Circle');
        if (!this.options.model && !isReady(runtime.options.settings))
          throw Error('connect an API URL, key and model first');
        const prompt = text(p.text, 'prompt');
        if (!prompt.trim()) throw Error('prompt is empty');
        const kind = p.kind ?? 'steering';
        if (!['steering', 'follow-up'].includes(String(kind)))
          throw Error('invalid queue kind');
        if (
          p.attachments !== undefined &&
          (!Array.isArray(p.attachments) || p.attachments.length > 16)
        )
          throw Error('invalid attachments');
        const attachments = (
          (p.attachments ?? []) as {
            content: string;
            mime: MediaAttachment['mime_type'];
            name: string;
          }[]
        ).map((item) =>
          attachmentFromBase64(
            text(item.content, 'attachment').replace(/^data:[^;]+;base64,/, ''),
            item.mime,
            text(item.name, 'filename', 500),
          ),
        );
        if (runtime.busy)
          runtime.harness.queue(
            prompt,
            kind === 'follow-up' ? 'followUp' : 'steer',
            attachments,
          );
        else {
          const display =
            p.display === undefined ? undefined : text(p.display, 'display');
          this.track(runtime.harness.run(prompt, display, attachments));
        }
        return {};
      }
      case 'abort':
        await runtime.cancel({ keepQueue: false });
        return {};
      case 'clear-queue':
        return runtime.harness.clearQueue();
      case 'remove-queued': {
        if (!['steering', 'follow-up'].includes(String(p.kind)))
          throw Error('invalid queue kind');
        return runtime.harness.removeQueued(
          p.kind === 'steering' ? 'steer' : 'followUp',
          Number(p.index),
          text(p.text, 'queued message'),
        );
      }
      case 'background':
        return runtime.jobs.backgroundForeground();
      case 'new-session': {
        const previous = runtime.session.id;
        await runtime.newSession();
        this.previous = previous;
        return { sessionId: runtime.session.id };
      }
      case 'select-session': {
        const id = text(p.id, 'session', 200);
        const row = runtime.store.get(id);
        if (!row || row.parent_id) throw Error('session not found');
        if (id === runtime.session.id) return { sessionId: id };
        this.previous = runtime.session.id;
        runtime = this.runtime(row.workspace);
        await runtime.switchSession(id);
        this.active = runtime;
        return { sessionId: runtime.session.id };
      }
      case 'delete-session': {
        const id = text(p.id, 'session', 200);
        const row = runtime.store.get(id);
        if (!row || row.parent_id) throw Error('session not found');
        const owner = this.runtimes.get(row.workspace);
        if (owner?.session.id === id) {
          if (
            owner.busy ||
            owner.jobs.list(id).some((job) => job.status === 'running')
          )
            throw Error('stop this session before deleting it');
          await owner.newSession();
        }
        runtime.store.delete(id);
        return {};
      }
      case 'rename-session':
        if (!runtime.store.get(String(p.id ?? command.sessionId)))
          throw Error('session not found');
        runtime.store.rename(
          String(p.id ?? command.sessionId),
          text(p.title, 'title', 500),
        );
        return {};
      case 'fork':
      case 'clone':
      case 'select-branch': {
        if (runtime.busy) throw Error('stop the current turn before branching');
        const nodes = runtime.store.tree(runtime.session.id);
        const node = p.messageId
          ? nodes.find((node) => node.id === p.messageId)
          : undefined;
        if (p.messageId && !node) throw Error('checkpoint not found');
        const head =
          command.name === 'clone'
            ? runtime.store.get(runtime.session.id)!.head
            : command.name === 'fork'
              ? node!.parent
              : node!.id;
        runtime.store.requireBalancedTools(
          runtime.store.messages(runtime.session.id, head),
        );
        if (command.name === 'select-branch') {
          runtime.store.select(runtime.session.id, head);
          await runtime.switchSession(runtime.session.id);
        } else {
          const previous = runtime.session.id;
          const fork = runtime.store.fork(
            runtime.session.id,
            runtime.options.workspace,
            head,
          );
          await runtime.switchSession(fork.id);
          this.previous = previous;
        }
        runtime.policy.setYolo(runtime.session.id, false);
        return { sessionId: runtime.session.id };
      }
      case 'label-branch': {
        const node = runtime.store
          .tree(runtime.session.id)
          .find((node) => node.id === p.messageId);
        if (!node?.message) throw Error('checkpoint not found');
        runtime.store.setLabel(
          runtime.session.id,
          node.message.id,
          text(p.label, 'label', 500),
        );
        return {};
      }
      case 'set-model': {
        runtime.setModel(text(p.modelId, 'model', 500));
        if (p.saveDefault === true) {
          const settings = loadSettings(this.home);
          settings.auth.model = runtime.harness.model.model;
          saveSettings(settings, this.home);
          runtime.options.settings.auth.model = settings.auth.model;
        }
        return {};
      }
      case 'set-effort':
        runtime.setThinkingLevel(text(p.effort, 'effort', 20));
        return {};
      case 'set-plan-mode':
        runtime.setPlanMode(flag(p.enabled));
        return {};
      case 'set-auto':
        runtime.policy.setYolo(runtime.session.id, flag(p.enabled));
        return {};
      case 'configure': {
        if (
          [...this.runtimes.values()].some(
            (owner) =>
              owner.busy ||
              owner.jobs
                .list()
                .some(
                  (job) => job.kind === 'agent' && job.status === 'running',
                ),
          )
        )
          throw Error('finish the current turn before changing connection');
        const endpoint = new URL(text(p.endpoint, 'endpoint', 2000));
        if (
          !['http:', 'https:'].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password
        )
          throw Error('invalid API endpoint');
        const protocol = text(p.protocol, 'protocol', 20);
        if (!['openai', 'anthropic'].includes(protocol))
          throw Error('invalid protocol');
        const baseUrl = normalizeBaseUrl(endpoint.href, protocol);
        const model = text(p.model, 'model', 500);
        if (!model.trim()) throw Error('model required');
        const secret = text(p.apiKey, 'API key', 4096);
        if (!secret.trim()) throw Error('API key required');
        saveCredentials({ api_key: secret }, this.home);
        const settings = withConnection(
          { protocol, base_url: baseUrl, model, api_key_ref: 'api_key' },
          this.home,
        );
        saveSettings(settings, this.home);
        for (const owner of this.runtimes.values()) {
          owner.options.settings = {
            ...owner.options.settings,
            auth: structuredClone(settings.auth),
            initialized: settings.initialized,
          };
          owner.options.model = undefined;
          owner.setModel(model);
        }
        return {};
      }
      case 'logout': {
        if (
          [...this.runtimes.values()].some(
            (owner) =>
              owner.busy ||
              owner.jobs
                .list()
                .some(
                  (job) => job.kind === 'agent' && job.status === 'running',
                ),
          )
        )
          throw Error('stop the current turn before signing out');
        clearCredentials(this.home);
        const settings = loadSettings(this.home);
        settings.initialized = false;
        settings.auth.base_url = '';
        saveSettings(settings, this.home);
        for (const owner of this.runtimes.values()) {
          owner.options.settings = structuredClone(settings);
          owner.options.model = new DisconnectedModel();
          owner.harness.model = owner.options.model;
        }
        return {};
      }
      case 'trust': {
        if (p.enabled !== true)
          throw Error('explicit trust confirmation required');
        saveSettings(
          trustFolder(loadSettings(this.home), runtime.options.workspace),
          this.home,
        );
        runtime.options.localContext = true;
        await runtime.reloadIntegrations();
        return {};
      }
      case 'save-settings': {
        const settings = loadSettings(this.home);
        const data = p.settings as Record<string, unknown>;
        if (!data || typeof data !== 'object' || Array.isArray(data))
          throw Error('invalid settings');
        if (data.theme !== undefined) {
          if (!['auto', 'light', 'dark'].includes(String(data.theme)))
            throw Error('invalid theme');
          settings.theme = data.theme as CircleSettings['theme'];
        }
        if (data.hideThinking !== undefined)
          settings.hide_thinking = flag(data.hideThinking);
        if (data.updateCheck !== undefined)
          settings.update_check = flag(data.updateCheck);
        if (data.defaultModel !== undefined)
          settings.auth.model = text(data.defaultModel, 'model', 500);
        if (data.defaultEffort !== undefined) {
          const value = text(data.defaultEffort, 'effort', 20);
          if (
            ![
              'default',
              'minimal',
              'low',
              'medium',
              'high',
              'xhigh',
              'max',
            ].includes(value)
          )
            throw Error('invalid effort');
          settings.default_thinking = value === 'default' ? '' : value;
        }
        if (data.doubleEscape !== undefined) {
          if (!['tree', 'fork', 'none'].includes(String(data.doubleEscape)))
            throw Error('invalid shortcut');
          settings.double_escape =
            data.doubleEscape as CircleSettings['double_escape'];
        }
        for (const [ui, core] of [
          ['enabledModels', 'enabled_models'],
          ['credentialFiles', 'credential_files'],
        ] as const)
          if (data[ui] !== undefined) {
            if (
              !Array.isArray(data[ui]) ||
              !(data[ui] as unknown[]).every(
                (item) => typeof item === 'string' && item.length < 1000,
              )
            )
              throw Error('invalid settings list');
            settings[core] = data[ui] as string[];
          }
        if (p.mcp !== undefined) {
          if (!Array.isArray(p.mcp)) throw Error('invalid MCP settings');
          settings.mcp_servers = p.mcp.map((entry) => {
            if (!entry || typeof entry !== 'object')
              throw Error('invalid MCP server');
            const row = entry as Record<string, unknown>;
            const transport = text(row.transport, 'transport', 50);
            if (
              !['stdio', 'sse', 'streamable_http', 'websocket'].includes(
                transport,
              )
            )
              throw Error('invalid transport');
            return {
              ...settings.mcp_servers.find(
                (saved) =>
                  saved.name === row.name || (row.id && saved.id === row.id),
              ),
              id: text(row.id ?? row.name, 'server id', 200),
              name: text(row.name, 'server name', 100),
              transport,
              command: text(row.command ?? '', 'command', 4000),
              args: splitArguments(text(row.args ?? '', 'args', 4000)),
              url: text(row.url ?? '', 'url', 4000),
              enabled: flag(row.enabled),
            };
          });
        }
        if (p.extensions !== undefined) {
          if (!Array.isArray(p.extensions)) throw Error('invalid extensions');
          for (const row of p.extensions as {
            name: string;
            enabled: boolean;
          }[])
            settings.extensions[text(row.name, 'extension', 100)] = {
              ...settings.extensions[row.name],
              enabled: flag(row.enabled),
            };
        }
        saveSettings(settings, this.home);
        Object.assign(runtime.options.settings, {
          theme: settings.theme,
          hide_thinking: settings.hide_thinking,
          double_escape: settings.double_escape,
          update_check: settings.update_check,
          enabled_models: settings.enabled_models,
          credential_files: settings.credential_files,
        });
        return {};
      }
      case 'reload': {
        if (
          !isFolderTrusted(loadSettings(this.home), runtime.options.workspace)
        )
          throw Error('trust the workspace first');
        await runtime.reloadIntegrations();
        if (!this.options.model && isReady(runtime.options.settings))
          runtime.setModel(runtime.options.settings.auth.model);
        return {};
      }
      case 'answer': {
        const id = text(p.id, 'interaction', 200);
        const pending = this.pending.get(id);
        if (
          !pending ||
          pending.signal.aborted ||
          pending.row.revision !== p.revision ||
          pending.row.sessionId !== command.sessionId
        )
          throw Error('stale interaction');
        if (p.cancel === true) {
          if (pending.secret) await cancelRequest(this.home, pending.secret.id);
          this.pending.delete(id);
          this.history.push({
            ...pending.row,
            status: 'recorded',
            decision: 'cancelled',
          });
          pending.resolve(
            pending.row.kind === 'approval' ? 'reject' : 'cancelled',
          );
          return {};
        }
        const answer = text(p.answer, 'answer', pending.secret ? 4096 : 16000);
        if (
          pending.row.kind === 'approval' &&
          !pending.row.choices?.includes(answer) &&
          !answer.startsWith('reject: ')
        )
          throw Error('invalid approval decision');
        if (pending.secret)
          await submitAnswer(this.home, pending.secret.id, answer);
        this.pending.delete(id);
        this.history.push({
          ...pending.row,
          status: 'recorded',
          decision: pending.secret ? 'submitted' : answer,
        });
        this.history = this.history.slice(-100);
        pending.resolve(pending.secret ? 'submitted' : answer);
        return {};
      }
      case 'compact':
        if (!this.options.model && !isReady(runtime.options.settings))
          throw Error('connect an endpoint before compacting');
        if (runtime.busy) throw Error('a turn is running');
        this.track(runtime.compact(text(p.hint ?? '', 'hint', 10000)));
        return {};
      case 'export': {
        const format = p.format ?? 'jsonl';
        if (!['jsonl', 'html', 'md'].includes(String(format)))
          throw Error('choose jsonl, html or md');
        runtime.exportSession(); // The same busy/background gate also applies to presentation exports.
        const row = runtime.store.get(runtime.session.id)!;
        const meta = {
          thread_id: row.id,
          title: row.title,
          workspace: row.workspace,
          model: row.model,
        };
        return {
          content:
            format === 'jsonl'
              ? runtime.exportSession()
              : format === 'html'
                ? toHtml(runtime.harness.messages, meta)
                : toMarkdown(runtime.harness.messages, meta),
          name: `${runtime.session.id}.${format}`,
        };
      }
      case 'import':
        await runtime.importSession(
          text(p.content, 'session export', 4_000_000),
        );
        return { sessionId: runtime.session.id };
      case 'stop-job': {
        const id = text(p.id, 'job', 200);
        const jobId = id.split(':').at(-1)!;
        const owner = [...this.runtimes.values()].find(
          (owner) =>
            owner.jobs.get(jobId)?.sessionId === command.sessionId &&
            `${command.sessionId}:${jobId}` === id,
        );
        if (!owner) throw Error('job not found in this session');
        await owner.jobs.stop(jobId, 'user');
        return {};
      }
      case 'revoke-approval': {
        const id = text(p.ruleId, 'rule', 200);
        const rules = runtime.policy.store.rules(runtime.session.id);
        const index = rules.findIndex(
          (rule) =>
            identity(
              JSON.stringify([
                runtime.session.id,
                rule.tool,
                rule.pattern,
                rule.at,
              ]),
            ) === id,
        );
        if (index < 0) throw Error('rule not found');
        runtime.policy.store.revoke(runtime.session.id, index);
        return {};
      }
      case 'open-workspace': {
        const workspace = realpathSync(text(p.path, 'workspace', 8000));
        const owner = this.runtime(workspace);
        this.previous = runtime.session.id;
        this.active = owner;
        return {
          workspaceId: identity(workspace),
          sessionId: owner.session.id,
        };
      }
      case 'load-skill': {
        const skill = runtime.skills.find((skill) => skill.name === p.name);
        if (!skill) throw Error('skill not found');
        return {
          name: skill.name,
          content: loadSkillBody(skill.name, runtime.skills),
        };
      }
      case 'init':
        return this.execute({
          ...command,
          name: 'prompt',
          payload: { text: readPrompt('commands', 'initialize.md') },
        });
      case 'shell': {
        if (
          !isFolderTrusted(runtime.options.settings, runtime.options.workspace)
        )
          throw Error('trust this workspace first');
        return runtime.userShells.run(
          text(p.command, 'shell command', 32000),
          p.quiet === true,
        );
      }
      case 'custom-command': {
        if (
          !isFolderTrusted(runtime.options.settings, runtime.options.workspace)
        )
          throw Error('trust this workspace first');
        if (runtime.busy) throw Error('a turn is running');
        const name = text(p.name, 'command name', 100);
        const args = text(p.args ?? '', 'command args', 16000);
        const extension = runtime.extensions.commands().get(name);
        if (extension) {
          await extension.handler(args, {
            workspace: runtime.options.workspace,
            toast: (message) => {
              this.error = message;
              this.publish();
            },
            append: (content) =>
              runtime.store.append(runtime.session.id, [
                { id: randomUUID(), role: 'assistant', content },
              ]),
            sendUserMessage: (prompt) => {
              this.track(runtime.harness.run(prompt));
            },
          });
          return {};
        }
        const custom = discoverCustomCommands(
          runtime.options.workspace,
          this.home,
          this.options.userHome,
        ).find((item) => item.name === name);
        if (!custom) throw Error('custom command not found');
        let prompt = substituteArguments(custom.template, args);
        for (const match of [...prompt.matchAll(/!`([^`]+)`/g)].reverse()) {
          const result = await runtime.userShells.run(match[1]!);
          if (result.exit_code !== 0)
            throw Error('command template shell did not complete successfully');
          prompt =
            prompt.slice(0, match.index) +
            result.output.trim() +
            prompt.slice(match.index! + match[0].length);
        }
        return this.execute({
          ...command,
          name: 'prompt',
          payload: { text: prompt, display: `/${name} ${args}`.trim() },
        });
      }
      case 'save-command': {
        if (runtime.busy)
          throw Error('finish the current turn before saving a command');
        const name = text(p.name, 'command name', 100);
        if (
          !/^[a-z][a-z0-9_-]{0,63}$/.test(name) ||
          BUILTIN_SLASH.some(
            (item) => item.name === name || item.aliases?.includes(name),
          ) ||
          runtime.extensions.commands().has(name)
        )
          throw Error('invalid or reserved command name');
        const scope = p.scope ?? 'user';
        if (!['project', 'user'].includes(String(scope)))
          throw Error('invalid command scope');
        if (
          scope === 'project' &&
          !isFolderTrusted(runtime.options.settings, runtime.options.workspace)
        )
          throw Error('trust this workspace first');
        const owner =
          scope === 'project' ? runtime.options.workspace : this.home;
        const folder =
          scope === 'project'
            ? join(owner, '.circle', 'commands')
            : join(owner, 'commands');
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const rel = relative(realpathSync(owner), realpathSync(folder));
        if (rel.startsWith('..') || isAbsolute(rel))
          throw Error('command folder leaves its owner');
        const path = join(realpathSync(folder), name + '.md');
        if (existsSync(path) && realpathSync(path) !== path)
          throw Error('linked commands must be edited in their source folder');
        const template = text(p.template, 'template', 120_000);
        const description = text(p.description ?? '', 'description', 1000);
        writeFileSync(
          path,
          `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\nargument-hint: ${JSON.stringify(text(p.arguments ?? '', 'argument hint', 1000))}\n---\n\n${template}\n`,
          { mode: 0o600 },
        );
        return { name, path };
      }
      case 'write-file': {
        if (
          !isFolderTrusted(runtime.options.settings, runtime.options.workspace)
        )
          throw Error('trust this workspace first');
        if (runtime.busy) throw Error('finish the current turn before saving');
        const path = text(p.path, 'path', 8000);
        const target = runtime.sandbox.resolvePath(path);
        const rel = relative(runtime.options.workspace, target);
        if (
          !rel ||
          rel === '..' ||
          rel.startsWith('../') ||
          rel.startsWith('..\\') ||
          isAbsolute(rel)
        )
          throw Error('file must be inside this workspace');
        if (runtime.harness.planMode && basename(target) !== 'plan.md')
          throw Error('plan mode allows saving plan.md only');
        const tool = runtime.allTools.find(
          (tool) => tool.name === 'write_file',
        )!;
        const output = await tool.run(
          { file_path: path, content: text(p.content, 'file', 4_000_000) },
          {
            sessionId: runtime.session.id,
            signal: new AbortController().signal,
          },
        );
        return { output };
      }
      case 'share':
      case 'unshare': {
        const folder = join(this.home, 'shares');
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const path = join(folder, `${runtime.session.id}.md`);
        if (command.name === 'unshare') {
          if (existsSync(path)) unlinkSync(path);
          return { path };
        }
        const reply = (await this.execute({
          ...command,
          name: 'export',
          payload: { format: 'md' },
        })) as { content: string };
        writeFileSync(path, reply.content, { mode: 0o600 });
        return { path };
      }
      case 'discover-models': {
        const settings = loadSettings(this.home);
        if (!isReady(settings)) throw Error('connect an endpoint first');
        const found = await resolveEndpoint(
          settings.auth.base_url,
          loadCredentials(this.home)[settings.auth.api_key_ref] ?? '',
          { protocol: settings.auth.protocol },
        );
        if (found.status === 'failed')
          throw Error(found.detail || 'model discovery failed');
        this.discoveredModels = found.models;
        return { models: found.models, detail: found.detail };
      }
      case 'check-update':
        return {
          available: await availableUpdate(this.home),
          automaticInstall: false,
        };
      case 'launch-options':
        throw Error(
          'desktop launch options must be supplied when starting the application; use session controls for model, effort and plan mode',
        );
      case 'close':
        await this.close();
        return {};
    }
  }
  async close() {
    if (this.closing) return;
    this.persistLocation();
    this.closing = true;
    for (const pending of this.pending.values())
      pending.reject(new Error('runtime closed'));
    this.pending.clear();
    await Promise.all(
      [...this.runtimes.values()].map((runtime) => runtime.close()),
    );
    await Promise.allSettled(this.tasks);
  }
}
