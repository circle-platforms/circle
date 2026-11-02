// What the screen keeps about the turn in progress and the turns before it, from the event
// bus: the busy word and the tokens written so far, how long each answer thought, and the
// line under each finished turn (`12s · ↑ 1.2k · ↓ 340`). Time spent waiting on you (an
// approval, a question) does not count. Kept in memory only: a
// reopened session has no turn lines.
import type { CircleEvent } from '../events.js';
import type { Message, ToolModelCall } from '../types.js';
import { pickBusyVerb, type TurnUsage } from './status_rows.js';
import type { ScreenState } from './render.js';
import type { CompactionEvent } from '../compaction.js';

// What a retry follows, by the kind of error (`model_guard.ts`)
const RETRY_CAUSE: Record<string, string> = {
  timeout: 'timeout',
  network: 'network error',
  server: 'server error',
  rate_limit: 'rate limited',
  inband: 'endpoint error',
};

export class TurnStatus {
  verb = 'Brewing';
  // The output tokens of the turn's finished requests, as their usage gives them
  tokens = 0;
  // Characters of the reply still streaming: the busy word and the footer count them
  // before the request reports a usage.
  private liveChars = 0;
  private compactionTokens = 0;
  private countedCompactions = new Set<string>();
  private compactionOutput = new Map<string, number>();
  // The model request being tried again (`timeout 3/10`), until it answers or the turn ends
  retry?: string;
  readonly usage: Record<string, TurnUsage> = {};
  readonly thinking: Record<string, number> = {};
  private live?: number;
  private agents = new Map<string, { from?: number; live?: number }>();
  private thinkingFrom?: number;
  private turn?: {
    started: number;
    waited: number;
    waitingSince?: number;
    input: number;
    output: number;
    cost: number | null;
    unreported?: boolean;
  };
  constructor(private random = Math.random) {}

  // `lastMessage` names the message the turn's line goes under when the turn ends.
  apply(
    event: CircleEvent,
    lastMessage: () => string | undefined,
    now = Date.now(),
  ): void {
    const subagent = Boolean(event.tags.subagent);
    // A background agent's work is not this turn's.
    if (subagent && event.tags.job_id) return;
    const turn = this.turn;
    if (event.kind === 'compaction') {
      const progress = event.payload as unknown as CompactionEvent;
      if (progress.snapshot?.trigger !== 'tool' && !subagent) {
        this.verb = 'compacting';
      }
      const call = progress.attempt;
      if (
        call &&
        call.status !== 'running' &&
        !this.countedCompactions.has(call.id) &&
        progress.trigger !== 'tool'
      ) {
        this.countedCompactions.add(call.id);
        const output = call.usage?.output_tokens ?? 0;
        this.compactionOutput.set(
          call.operationId,
          (this.compactionOutput.get(call.operationId) ?? 0) + output,
        );
        this.tokens += output;
        if (turn) {
          if (!call.usageComplete) turn.unreported = true;
          turn.input += call.usage?.input_tokens ?? 0;
          turn.output += output;
          const cost = call.cost;
          turn.cost =
            turn.cost === null ||
            !cost ||
            cost.currency !== 'USD' ||
            cost.amount === null
              ? null
              : turn.cost + Math.max(0, cost.amount);
        }
      }
      if (progress.snapshot?.trigger !== 'tool' && !subagent) {
        const s = progress.snapshot;
        this.compactionTokens =
          s?.status === 'running'
            ? Math.max(
                0,
                s.usage.output_tokens -
                  (this.compactionOutput.get(s.operationId) ?? 0),
              ) + s.liveTokens
            : 0;
      }
    }
    if (event.kind === 'tool_waiting' && turn) turn.waitingSince ??= now;
    if (
      (event.kind === 'tool_start' || event.kind === 'tool_result') &&
      turn?.waitingSince !== undefined
    ) {
      turn.waited += now - turn.waitingSince;
      turn.waitingSince = undefined;
    }
    if (
      event.kind === 'llm_end' ||
      (event.kind === 'tool_result' && event.usage)
    ) {
      const output = event.usage?.output_tokens ?? 0;
      this.tokens += output;
      if (turn) {
        turn.input += event.usage?.input_tokens ?? 0;
        turn.output += output;
        const calls = event.payload.model_calls as ToolModelCall[] | undefined;
        const receipts =
          event.kind === 'llm_end'
            ? [(event.payload.message as Message | undefined)?.cost]
            : calls?.length
              ? calls.map((call) => call.cost)
              : [undefined];
        // Hosted tool charges can be unknown even when token prices are known.
        // A receipt is a price, never a credit: a negative amount is not
        // subtracted, so a stopped turn cannot show a minus before its estimate.
        for (const cost of receipts)
          turn.cost =
            turn.cost === null ||
            !cost ||
            cost.currency !== 'USD' ||
            cost.amount === null ||
            cost.tool_fee_unknown
              ? null
              : turn.cost +
                (typeof cost.amount === 'number' && cost.amount < 0
                  ? 0
                  : cost.amount);
      }
    }
    if (subagent) {
      this.agentThought(String(event.tags.subagent), event, now);
      return;
    }
    const notice = event.payload.model_notice as
      Record<string, unknown> | undefined;
    if (event.kind === 'info' && notice?.event === 'retry') {
      this.retry = `${RETRY_CAUSE[String(notice.kind)] ?? 'error'} ${notice.attempt}/${notice.max}`;
      // The failed try's text is dropped and sent again, so it is not counted.
      this.thinkingFrom = this.live = undefined;
      this.liveChars = 0;
    } else if (
      [
        'llm_start',
        'llm_token',
        'llm_end',
        'steer',
        'run_start',
        'run_end',
        'run_error',
      ].includes(event.kind)
    )
      this.retry = undefined;
    if (event.kind === 'run_start') {
      this.countedCompactions.clear();
      this.compactionOutput.clear();
      this.compactionTokens = 0;
      this.verb = pickBusyVerb(this.random);
      this.tokens = 0;
      this.liveChars = 0;
      this.turn = { started: now, waited: 0, input: 0, output: 0, cost: 0 };
      this.thinkingFrom = this.live = undefined;
    } else if (event.kind === 'llm_start') {
      this.thinkingFrom = this.live = undefined;
      this.liveChars = 0;
    } else if (event.kind === 'llm_token') {
      const token = String(event.payload.text ?? '');
      const visible = token.replace(
        /[\s\u200b\u200c\u200d\ufeff\u2060\u00ad]/g,
        '',
      );
      if (event.payload.thinking) {
        if (visible) this.thinkingFrom ??= now;
      } else {
        if (this.thinkingFrom !== undefined && this.live === undefined)
          this.live = (now - this.thinkingFrom) / 1000;
        this.liveChars += token.length;
      }
    } else if (event.kind === 'llm_end') {
      const message = event.payload.message as Message | undefined;
      if (message?.id && this.thinkingFrom !== undefined)
        this.thinking[message.id] =
          this.live ?? (now - this.thinkingFrom) / 1000;
      this.thinkingFrom = this.live = undefined;
      this.liveChars = 0;
    } else if (
      (event.kind === 'run_end' || event.kind === 'run_error') &&
      turn
    ) {
      if (turn.waitingSince !== undefined)
        turn.waited += now - turn.waitingSince;
      const id = lastMessage();
      if (id)
        this.usage[id] = {
          seconds: Math.max(0, (now - turn.started - turn.waited) / 1000),
          input: turn.input,
          output: turn.output + this.pendingOutput,
          cost: turn.cost,
          ...(turn.unreported ? { unreported: true } : {}),
        };
      this.liveChars = 0;
      this.turn = undefined;
    }
  }

  /** Output tokens of the reply still streaming, estimated from its text. */
  get pendingOutput(): number {
    return (
      (this.liveChars ? Math.max(1, Math.ceil(this.liveChars / 4)) : 0) +
      this.compactionTokens
    );
  }

  // A subagent's rounds think too: how long, by the id of the answer, for its page.
  private agentThought(agent: string, event: CircleEvent, now: number): void {
    if (event.kind === 'llm_start') this.agents.delete(agent);
    else if (event.kind === 'llm_token') {
      const round = this.agents.get(agent) ?? {};
      const visible = String(event.payload.text ?? '').replace(
        /[\s\u200b\u200c\u200d\ufeff\u2060\u00ad]/g,
        '',
      );
      if (event.payload.thinking) {
        if (visible) round.from ??= now;
      } else if (round.from !== undefined && round.live === undefined)
        round.live = (now - round.from) / 1000;
      this.agents.set(agent, round);
    } else if (event.kind === 'llm_end') {
      const round = this.agents.get(agent);
      const message = event.payload.message as Message | undefined;
      if (message?.id && round?.from !== undefined)
        this.thinking[message.id] = round.live ?? (now - round.from) / 1000;
      this.agents.delete(agent);
    }
  }

  // The thinking streaming now: how long it took, once the answer's text has begun.
  get liveSeconds(): number | undefined {
    return this.live;
  }

  fill(state: ScreenState): void {
    state.busyVerb = this.verb;
    state.busyTokens = this.tokens + this.pendingOutput;
    state.busyRetry = this.retry;
    state.turnUsage = this.usage;
    state.thinkingSeconds = this.thinking;
    state.liveThinkingSeconds = this.live;
  }
}
