import { appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  emptyUsage,
  type ChatModel,
  type ModelRequest,
  type ModelResponse,
} from '../../../src/types.js';

export interface RuntimeFixtureReply {
  message?: ModelResponse['message'];
  delayMs?: number;
  waitForAbort?: boolean;
  // `waitForFile` keeps the stream open until a check has seen it and creates the file.
  chunks?: (
    | string
    | { text: string; thinking?: boolean }
    | { waitForFile: string }
  )[];
  usage?: ModelResponse['usage'];
  /** Reject this request with the message, after it is journaled. */
  error?: string;
}
export interface RuntimeFixtureIdentity {
  conversationId: string;
  workspace: string;
  role: 'parent' | 'worker' | 'reviewer';
  firstUser: string;
  taskId?: string;
  taskPrompt?: string;
  access?: 'write' | 'readonly';
  attempt?: number;
}
export interface RuntimeFixtureRoute {
  id: string;
  match: Partial<
    Pick<
      RuntimeFixtureIdentity,
      'role' | 'firstUser' | 'taskId' | 'taskPrompt' | 'access'
    >
  >;
  replies: RuntimeFixtureReply[];
}
export interface RuntimeFixture {
  requestsPath?: string;
  replies?: RuntimeFixtureReply[];
  routes?: RuntimeFixtureRoute[];
}
export interface RuntimeFixtureRequest {
  system: string;
  messages: ModelRequest['messages'];
  tools: Omit<
    ModelRequest['tools'][number],
    'run' | 'approvalFacts' | 'prepare'
  >[];
  fixture: RuntimeFixtureIdentity & {
    routeId?: string;
    step?: number;
    error?: string;
  };
}

/** Test-profile only. Each real conversation has its own script, regardless of scheduling order. */
export class RuntimeFixtureModel implements ChatModel {
  model = 'scripted';
  requests: RuntimeFixtureRequest[] = [];
  private legacyStep = 0;
  private conversations = new Map<
    string,
    { route: RuntimeFixtureRoute; step: number }
  >();
  private workers = new Map<string, RuntimeFixtureIdentity>();

  constructor(private fixture: RuntimeFixture) {
    if (Boolean(fixture.routes) === Boolean(fixture.replies))
      throw Error('runtime fixture requires exactly one of routes or replies');
    const ids = new Set<string>();
    for (const route of fixture.routes ?? []) {
      if (!route.id || ids.has(route.id) || !Array.isArray(route.replies))
        throw Error(
          'runtime fixture route ids must be unique with a replies array',
        );
      ids.add(route.id);
      if (!route.match || !Object.keys(route.match).length)
        throw Error(
          `runtime fixture route ${route.id} needs an explicit match`,
        );
    }
  }

  private identity(request: ModelRequest): RuntimeFixtureIdentity {
    const first = request.messages.find((message) => message.role === 'user');
    if (!first)
      throw Error('runtime fixture requires an actual first user message');
    // The generated env block is appended after project instructions. Its actual cwd
    // binds a fresh independent reviewer to the worker, never the worker's answer.
    const env = [
      ...request.system.matchAll(/<env>\n  Working directory: ([^\n]+)\n/g),
    ].at(-1);
    const workspace = env?.[1] ?? '';
    const base: RuntimeFixtureIdentity = {
      conversationId: first.id,
      workspace,
      role: 'parent',
      firstUser: first.content,
    };
    const task =
      /^Task ([^\n]+), attempt (\d+)\.\n\n([\s\S]*?)\n\nAcceptance criteria:\n/.exec(
        first.content,
      );
    if (task) {
      const access = /\n\nAccess: (write|readonly)\. Baseline commit: /.exec(
        first.content,
      )?.[1];
      if (!workspace || !access)
        throw Error('task fixture needs an actual workspace and access');
      const identity: RuntimeFixtureIdentity = {
        ...base,
        role: 'worker',
        taskId: task[1],
        taskPrompt: task[3],
        attempt: Number(task[2]),
        access: access as 'write' | 'readonly',
      };
      const previous = this.workers.get(workspace);
      if (previous && previous.taskId !== identity.taskId)
        throw Error('task fixture workspaces must be isolated');
      this.workers.set(workspace, identity);
      return identity;
    }
    if (first.content.startsWith('Independently review this candidate.')) {
      const worker = this.workers.get(workspace);
      if (!worker)
        throw Error(
          'independent reviewer has no observed worker in this actual workspace',
        );
      return { ...worker, ...base, role: 'reviewer' };
    }
    return base;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal.throwIfAborted();
    let identity: RuntimeFixtureIdentity = {
      conversationId:
        request.messages.find((message) => message.role === 'user')?.id ?? '',
      workspace: '',
      role: 'parent',
      firstUser:
        request.messages.find((message) => message.role === 'user')?.content ??
        '',
    };
    let entry: RuntimeFixtureReply | undefined;
    let routeId: string | undefined;
    let step: number | undefined;
    let failure: unknown;
    try {
      if (this.fixture.routes) {
        identity = this.identity(request);
        let conversation = this.conversations.get(identity.conversationId);
        if (!conversation) {
          const routes = this.fixture.routes.filter((route) =>
            Object.entries(route.match).every(
              ([key, value]) =>
                identity[key as keyof RuntimeFixtureIdentity] === value,
            ),
          );
          if (routes.length !== 1)
            throw Error(
              `runtime fixture expected one route, found ${routes.length} for ${identity.role} ${identity.taskId ?? identity.firstUser}`,
            );
          conversation = { route: routes[0], step: 0 };
          this.conversations.set(identity.conversationId, conversation);
        }
        routeId = conversation.route.id;
        step = conversation.step++;
        entry = conversation.route.replies[step];
      } else {
        routeId = 'legacy';
        step = this.legacyStep++;
        entry = this.fixture.replies?.[step];
      }
      if (!entry)
        throw Error(
          `runtime fixture ${routeId} has no response at step ${step}`,
        );
    } catch (error) {
      failure = error;
    }
    // Journal before returning or rejecting, including unmatched/exhausted requests.
    const recorded: RuntimeFixtureRequest = structuredClone({
      system: request.system,
      messages: request.messages,
      tools: request.tools.map(
        ({ run: _run, approvalFacts: _facts, prepare: _prepare, ...tool }) =>
          tool,
      ),
      fixture: {
        ...identity,
        routeId,
        step,
        ...(failure ? { error: String(failure) } : {}),
      },
    });
    this.requests.push(recorded);
    if (this.fixture.requestsPath)
      appendFileSync(
        this.fixture.requestsPath,
        JSON.stringify(recorded) + '\n',
        { mode: 0o600 },
      );
    if (failure) throw failure;
    if (entry!.error) throw Error(entry!.error);
    if (entry!.waitForAbort)
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(request.signal.reason ?? Error('aborted'));
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
      });
    for (const chunk of entry!.chunks ?? []) {
      if (typeof chunk !== 'string' && 'waitForFile' in chunk) {
        while (!existsSync(chunk.waitForFile))
          await delay(20, undefined, { signal: request.signal });
        continue;
      }
      if (typeof chunk === 'string') request.token(chunk);
      else request.token(chunk.text, chunk.thinking);
      await delay(entry!.delayMs ?? 15, undefined, { signal: request.signal });
    }
    if (entry!.delayMs && !entry!.chunks)
      await delay(entry!.delayMs, undefined, { signal: request.signal });
    const message = entry!.message ?? {
      id: randomUUID(),
      role: 'assistant' as const,
      content: (entry!.chunks ?? [])
        .flatMap((chunk) =>
          typeof chunk === 'string'
            ? [chunk]
            : 'text' in chunk && !chunk.thinking
              ? [chunk.text]
              : [],
        )
        .join(''),
    };
    if (message.content && !entry!.chunks) request.token(message.content);
    return { message, usage: entry!.usage ?? emptyUsage() };
  }
}
