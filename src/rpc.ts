import { connectionKey } from './chatgpt_plan.js';
import { createInterface } from 'node:readline';
import type { AgentRuntime } from './runtime.js';
import { jsonEvent } from './headless.js';
import { resolveEndpoint } from './probe.js';
import { toHtml } from './session_export.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { rpcMessage, rpcJob } from './rpc_codec.js';
import { JobWake, answerJobsBeforeLeaving } from './job_wake.js';
export interface RpcIO {
  input: Readable;
  write(text: string): void;
}
export async function runRpc(
  runtime: AgentRuntime,
  io: RpcIO = {
    input: process.stdin,
    write: (text) => {
      process.stdout.write(text);
    },
  },
): Promise<number> {
  const send = (record: unknown): void => {
    io.write(JSON.stringify(record) + '\n');
  };
  let lastAnswer = '';
  let running: Promise<void> | undefined;
  let code = 0;
  let ended = false;
  const wake = new JobWake({
    hasNotice: () => runtime.jobs.hasNotices(runtime.session.id, true),
    occupied: () => runtime.busy,
    closed: () => ended,
    start: () => {
      const run = runtime.runJobNotices();
      running = run
        .then(
          () => {},
          () => {},
        )
        .finally(() => send({ type: 'agent_settled' }));
      return run;
    },
  });
  const off = runtime.bus.subscribe((event) => {
    if (event.kind === 'job_ended') wake.jobEnded();
    if (event.kind === 'run_end')
      lastAnswer = String(event.payload.answer ?? '');
    const record = jsonEvent(event);
    if (event.kind === 'run_error' && event.payload.interrupted)
      send({ type: 'turn_end', aborted: true });
    else if (record) send(record);
  });
  const input = createInterface({ input: io.input, terminal: false });
  const lines = input[Symbol.asyncIterator]();
  // A disconnected Readable can close without ending. Readline does not propagate
  // that event, so its async iterator otherwise waits forever on a destroyed pipe.
  const inputClosed = () => input.close();
  io.input.once('close', inputClosed);
  if (io.input.destroyed) input.close();
  const interrupt = (): void => {
    code = 130;
    input.close();
    void runtime.cancel();
  };
  process.on('SIGINT', interrupt);
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let command: Record<string, unknown>;
      try {
        command = JSON.parse(line);
        if (!command || typeof command !== 'object' || Array.isArray(command))
          throw new Error('not an object');
      } catch {
        send({
          type: 'response',
          command: 'parse',
          success: false,
          error: 'invalid JSON command',
        });
        continue;
      }
      const type = String(command.type || '');
      const response = (data?: unknown): void =>
        send({
          type: 'response',
          command: type,
          success: true,
          ...(command.id != null ? { id: command.id } : {}),
          ...(data !== undefined ? { data } : {}),
        });
      try {
        if (['prompt', 'steer', 'follow_up'].includes(type)) {
          if (typeof command.message !== 'string' || !command.message.trim())
            throw new Error('message is required');
          wake.personSent();
          if (runtime.harness.busy) {
            const mode =
              type === 'steer'
                ? 'steer'
                : type === 'follow_up'
                  ? 'followUp'
                  : command.streamingBehavior;
            if (mode !== 'steer' && mode !== 'followUp')
              throw new Error('streamingBehavior must be steer or followUp');
            runtime.harness.queue(command.message, mode);
            response({ disposition: 'queued' });
          } else {
            response({ disposition: 'started' });
            running = runtime.harness
              .run(command.message)
              .then(
                () => {},
                () => {},
              )
              .finally(() => send({ type: 'agent_settled' }));
          }
        } else if (type === 'abort') {
          wake.snooze();
          await runtime.cancel();
          response();
        } else if (type === 'clear_queue')
          response(runtime.harness.clearQueue());
        else if (type === 'new_session') {
          wake.snooze();
          await runtime.newSession();
          lastAnswer = '';
          response({ cancelled: false, sessionId: runtime.session.id });
        } else if (type === 'get_state')
          response({
            model: runtime.harness.model.model,
            thinkingLevel: runtime.thinkingLevel,
            isStreaming: runtime.busy,
            sessionId: runtime.session.id,
            sessionName: runtime.store.get(runtime.session.id)?.title,
            messageCount: runtime.harness.messages.length,
            pendingMessageCount: runtime.harness.pendingMessageCount,
          });
        else if (type === 'get_messages')
          response({ messages: runtime.harness.messages.map(rpcMessage) });
        else if (type === 'get_native_messages')
          response({ messages: runtime.harness.messages });
        else if (['list_jobs', 'get_jobs'].includes(type))
          response({ jobs: runtime.jobs.list().map(rpcJob) });
        else if (type === 'stop_job') {
          const id = String(command.jobId ?? command.job_id ?? '').trim();
          if (!id) throw new Error('jobId is required');
          if (runtime.jobs.get(id)?.status !== 'running')
            throw new Error(`No running job ${id}`);
          await runtime.jobs.stop(id, 'user');
          response({ job: rpcJob(runtime.jobs.get(id)!) });
        } else if (type === 'background')
          response({ moved: runtime.jobs.backgroundForeground() });
        else if (type === 'get_last_assistant_text')
          response({
            text:
              lastAnswer ||
              runtime.harness.messages
                .filter(
                  (message) =>
                    message.role === 'assistant' && message.content.trim(),
                )
                .at(-1)
                ?.content.trim() ||
              '',
          });
        else if (type === 'get_session_stats') {
          const stats = runtime.stats();
          const messages = runtime.harness.messages;
          response({
            sessionId: runtime.session.id,
            userMessages: messages.filter(
              (message) => message.role === 'user' && !message.internal,
            ).length,
            assistantMessages: messages.filter(
              (message) => message.role === 'assistant',
            ).length,
            toolCalls: stats.toolCalls,
            toolResults: messages.filter((message) => message.role === 'tool')
              .length,
            totalMessages: stats.messages,
            tokens: {
              input: stats.usage.input_tokens,
              output: stats.usage.output_tokens,
              total: stats.usage.input_tokens + stats.usage.output_tokens,
            },
            costs: stats.costs,
          });
        } else if (type === 'get_available_models') {
          const settings = runtime.options.settings;
          const discovered = await resolveEndpoint(
            settings.auth.base_url,
            await connectionKey(settings, runtime.options.home),
            { protocol: settings.auth.protocol },
          );
          if (discovered.status === 'failed')
            throw new Error(discovered.detail);
          response({ models: discovered.models });
        } else if (type === 'set_model') {
          runtime.setModel(
            String(command.modelId || command.model || '').trim(),
          );
          response({ model: runtime.harness.model.model });
        } else if (type === 'set_thinking_level') {
          runtime.setThinkingLevel(
            String(command.level || '')
              .trim()
              .toLowerCase(),
          );
          response({ thinkingLevel: runtime.thinkingLevel });
        } else if (type === 'export_html') {
          const session = runtime.store.get(runtime.session.id)!;
          const path = resolve(
            runtime.options.workspace,
            String(command.outputPath || session.id + '.html'),
          );
          writeFileSync(
            path,
            toHtml(runtime.harness.messages, {
              thread_id: session.id,
              title: session.title,
              workspace: session.workspace,
              model: runtime.harness.model.model,
            }),
          );
          response({ path });
        } else if (type === 'set_session_name') {
          const name = String(command.name || '')
            .trim()
            .replace(/\s+/g, ' ');
          if (!name) throw new Error('name is required');
          runtime.store.rename(runtime.session.id, name, true);
          response();
        } else throw new Error(`Unknown command: ${type || '(none)'}`);
      } catch (error) {
        send({
          type: 'response',
          command: type,
          success: false,
          ...(command.id != null ? { id: command.id } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // EOF has print-mode semantics: finish the visible turn, deliver completed
    // model-owned job notices, then stop remaining work before returning.
    ended = true;
    await running;
    await answerJobsBeforeLeaving(runtime, {
      delay,
      carryOn: () => !wake.snoozed && code === 0,
      wakesSoFar: wake.wakesInARow,
      wake: async () => {
        await runtime.runJobNotices().catch(() => {
          wake.snooze();
        });
        send({ type: 'agent_settled' });
      },
    });
    const stopped = await runtime.jobs.close();
    for (const sessionId of new Set(
      runtime.jobs.list().map((job) => job.sessionId),
    )) {
      const notices = runtime.jobs.takeNotices(sessionId);
      if (notices.length && runtime.store.get(sessionId))
        runtime.store.append(sessionId, notices);
    }
    send({ type: 'jobs_stopped', count: stopped.length });
  } finally {
    ended = true;
    io.input.off('close', inputClosed);
    input.close();
    process.off('SIGINT', interrupt);
    off();
  }
  return code;
}
