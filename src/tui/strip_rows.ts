// The strip under the footer while subagents or background jobs run: a header naming only
// what is there, a row per subagent, then a row per job. Each row: its lamp in marker
// column 1, the name, what it is doing (the column that gives way first) and a meter that
// ends one column short of the edge.
import { lampSgr, palette, sgrJoin, type LampState } from '../ink/theme.js';
import { uiText } from '../locale.js';
import { stringWidth } from '../ink/string_width.js';
import {
  elapsed,
  outcomeWords,
  outputTail,
  plainJobOutput,
  type Job,
} from '../jobs.js';
import { formatElapsed, formatTokens } from './status_rows.js';
import type { SubagentView } from './subagents.js';
import type { TerminalBandView, TerminalView } from '../terminal/sessions.js';

export const AGENT_ROWS = 6;
export const JOB_ROWS = 4;
const AGENT_NAME_W = 24;
const JOB_NAME_W = 32;

function fit(text: string, width: number): string {
  let shown = String(text).replace(/\n/g, ' ');
  if (width <= 0) return '';
  if (stringWidth(shown) <= width) return shown;
  while (shown && stringWidth(shown) > width - 1)
    shown = Array.from(shown).slice(0, -1).join('');
  return shown + '…';
}
// Cut from the middle, so the id tail that tells parallel agents apart survives.
function fitMiddle(text: string, width: number): string {
  if (width <= 0 || stringWidth(text) <= width) return text;
  if (width <= 3) return fit(text, width);
  const chars = Array.from(text);
  const tail = chars.slice(-Math.floor(width / 2)).join('');
  const head = chars
    .slice(0, Math.max(1, width - Array.from(tail).length - 1))
    .join('');
  return `${head}…${tail}`;
}
function padTo(text: string, width: number): string {
  const shown = fit(text, width);
  return shown + ' '.repeat(Math.max(0, width - stringWidth(shown)));
}
function rightTo(text: string, width: number): string {
  const shown = fit(text, width);
  return ' '.repeat(Math.max(0, width - stringWidth(shown))) + shown;
}
function row(
  bg: string,
  fg: string,
  lamp: LampState,
  body: string,
  meta: string,
  now: number,
  metaFg = palette().dim,
): string {
  const p = palette();
  const light = lampSgr(lamp, now);
  return (
    sgrJoin(bg) +
    ' ' +
    p.reset +
    sgrJoin(bg, light) +
    (light ? '●' : ' ') +
    p.reset +
    sgrJoin(bg, fg) +
    ' ' +
    body +
    p.reset +
    sgrJoin(bg, metaFg) +
    meta +
    ' ' +
    p.reset
  );
}

// ` Agents · 2 · Jobs · 3`, naming only what is there.
export function stripHeader(
  agents: number,
  jobs: number,
  width: number,
  terminals = 0,
): string {
  const p = palette();
  const parts = [
    ...(agents ? [`Agents · ${agents}`] : []),
    ...(jobs ? [`Jobs · ${jobs}`] : []),
    ...(terminals ? [`Terminals · ${terminals}`] : []),
  ];
  return (
    sgrJoin(p.panel_bg, p.faint) +
    padTo(' ' + parts.join(' · '), width) +
    p.reset
  );
}

// `general-purpose·1a2b3c4d`: parallel subagents of one type stay apart.
export function agentName(agent: Pick<SubagentView, 'id' | 'name'>): string {
  const tail = agent.id.replace(/[^0-9A-Za-z]/g, '').slice(-8);
  return tail ? `${agent.name}·${tail}` : agent.name;
}
// What it is doing now; old/restored records without activity keep their task label.
export function agentActivity(agent: SubagentView): string {
  if (agent.state === 'waiting') return uiText('waiting for you');
  if (agent.activity) return agent.activity;
  const prefix = `${agent.name}: `;
  const task = agent.description.startsWith(prefix)
    ? agent.description.slice(prefix.length)
    : agent.description;
  return task.split(/\s+/).filter(Boolean).join(' ') || '—';
}
export function agentSeconds(agent: SubagentView, now: number): number {
  const end = ['running', 'waiting'].includes(agent.state)
    ? now
    : (agent.updated ?? now);
  return Math.max(0, (end - agent.started) / 1000);
}

// The visible subagent rows, and `… +N more` for the ones folded away. A row has no
// background until you select it or point at it: then it sits on `sel_bg` in `em`.
export function agentRows(
  agents: SubagentView[],
  options: {
    width: number;
    selected?: string;
    hover?: string;
    hidden?: number;
    now?: number;
  },
): string[] {
  if (!agents.length) return [];
  const p = palette();
  const now = options.now ?? Date.now();
  const width = options.width;
  const names = agents.map(agentName);
  const doings = agents.map(agentActivity);
  let metas = agents.map(
    (agent) =>
      `${formatElapsed(agentSeconds(agent, now))} · ${formatTokens(agent.tokens)} tokens`,
  );
  let nameW = Math.min(
    AGENT_NAME_W,
    Math.max(...names.map((name) => stringWidth(name))),
  );
  let metaW = Math.max(...metas.map((meta) => stringWidth(meta)));
  const doingRoom = (): number => width - 3 - nameW - 2 - metaW - 2 - 1;
  if (doingRoom() < 8) {
    metas = metas.map((meta) => meta.replace(' tokens', ''));
    metaW = Math.max(...metas.map((meta) => stringWidth(meta)));
  }
  if (doingRoom() < 8)
    nameW = Math.max(8, Math.min(nameW, width - 3 - 2 - metaW - 2 - 1 - 8));
  const doingW = Math.max(0, doingRoom());
  // Narrower than the columns can go: the name gives way last.
  nameW = Math.max(1, Math.min(nameW, width - 3 - 2 - doingW - 2 - metaW - 1));
  const rows = agents.map((agent, index) => {
    const lit = agent.id === options.selected || agent.id === options.hover;
    const lamp: LampState =
      agent.state === 'waiting'
        ? 'wait'
        : agent.state === 'running'
          ? 'running'
          : agent.state === 'done'
            ? 'ok'
            : agent.state === 'error'
              ? 'error'
              : 'none';
    return row(
      lit ? p.sel_bg : '',
      lit ? p.em : p.text,
      lamp,
      `${padTo(fitMiddle(names[index]!, nameW), nameW)}  ${padTo(doings[index]!, doingW)}  `,
      rightTo(metas[index]!, metaW),
      now,
      // `dim` is held to its contrast floor on the background, not on the selection
      lit ? p.text : p.dim,
    );
  });
  if (options.hidden && options.hidden > 0)
    rows.push(
      sgrJoin(p.panel_bg, p.faint) +
        padTo(`  … +${options.hidden} more`, width) +
        p.reset,
    );
  return rows;
}

// What a job is doing: waiting on you, an agent's step, a command's last line.
export function jobActivity(job: Job): string {
  if (job.detail === 'waiting for you') return uiText('waiting for you');
  if (job.kind === 'agent' || job.kind === 'watch') return job.detail || '—';
  try {
    return plainJobOutput(outputTail(job.outputPath, 2048, 1)).trim() || '—';
  } catch {
    return '—';
  }
}

// One row per live job, `… +N more jobs` past `JOB_ROWS`. Commands carry the write tint,
// agents the agent tint.
export function jobRows(
  jobs: Job[],
  options: {
    width: number;
    now?: number;
    max?: number;
    // A background subagent's tokens, by its job: its meter reads like an agent row's.
    tokens?: Map<string, number>;
  },
): string[] {
  if (!jobs.length) return [];
  const p = palette();
  const now = options.now ?? Date.now();
  const width = options.width;
  const shown = jobs.slice(
    0,
    Math.max(1, Math.min(JOB_ROWS, options.max ?? JOB_ROWS)),
  );
  const names = shown.map(
    (job) => `${job.id} ${plainJobOutput(job.title).replace(/\s+/g, ' ')}`,
  );
  const doings = shown.map(jobActivity);
  const metas = shown.map((job) => {
    const tokens = options.tokens?.get(job.id);
    return tokens === undefined
      ? elapsed(job)
      : `${elapsed(job)} · ${formatTokens(tokens)} tokens`;
  });
  let nameW = Math.min(
    JOB_NAME_W,
    Math.max(...names.map((name) => stringWidth(name))),
  );
  const metaW = Math.max(...metas.map((meta) => stringWidth(meta)));
  let doingW = width - 3 - nameW - 2 - metaW - 2 - 1;
  if (doingW < 8) {
    nameW = Math.max(8, Math.min(nameW, width - 3 - 2 - metaW - 2 - 1 - 8));
    doingW = Math.max(0, width - 3 - nameW - 2 - metaW - 2 - 1);
  }
  nameW = Math.max(1, Math.min(nameW, width - 3 - 2 - doingW - 2 - metaW - 1));
  const rows = shown.map((job, index) =>
    row(
      job.kind === 'agent' ? p.agent_bg : p.write_bg,
      p.text,
      job.detail === 'waiting for you' ? 'wait' : 'running',
      `${padTo(names[index]!, nameW)}  ${padTo(doings[index]!, doingW)}  `,
      rightTo(metas[index]!, metaW),
      now,
    ),
  );
  if (jobs.length > shown.length)
    rows.push(
      sgrJoin(p.panel_bg, p.faint) +
        padTo(`  … +${jobs.length - shown.length} more jobs`, width) +
        p.reset,
    );
  return rows;
}

// A live device terminal's row, in the job row's shape: lamp, `t1 name`, the last line
// the device showed, and how long the screen has rested. Held consoles say waiting
// for you; their lamp is cyan, like a job's or a background agent's.
export const TERMINAL_ROWS = 4;

export function terminalLamp(session: TerminalBandView): LampState {
  if (session.held) return 'wait';
  if (session.state === 'connecting') return 'running';
  if (session.state === 'error') return 'error';
  if (session.state !== 'ready') return 'none';
  return session.quiet < 1500 ? 'running' : 'ok';
}

export function terminalRows(
  sessions: TerminalView[],
  options: { width: number; now?: number; max?: number },
): string[] {
  if (!sessions.length) return [];
  const p = palette();
  const now = options.now ?? Date.now();
  const width = options.width;
  const shown = sessions.slice(
    0,
    Math.max(1, Math.min(TERMINAL_ROWS, options.max ?? TERMINAL_ROWS)),
  );
  const names = shown.map((one) => `${one.id} ${one.name}`);
  const doings = shown.map((one) =>
    one.held
      ? uiText('waiting for you')
      : one.state === 'connecting'
        ? 'connecting'
        : one.state !== 'ready'
          ? one.detail || one.state
          : (one.last ?? '').replace(/\s+/g, ' ').trim() || '—',
  );
  const metas = shown.map((one) =>
    one.state === 'ready' && !one.held
      ? `${formatElapsed(Math.round(one.quiet / 1000))}`
      : '',
  );
  const nameW = Math.min(
    28,
    Math.max(...names.map((name) => stringWidth(name))),
  );
  const metaW = Math.max(0, ...metas.map((meta) => stringWidth(meta)));
  const doingW = Math.max(0, width - 3 - nameW - 2 - metaW - 2 - 1);
  const rows = shown.map((one, index) => {
    // A console at its prompt is not work in progress. Only a device that is
    // connecting, has just answered, or waits for the person takes the strip's
    // colour; the same 1.5 s the page's band calls "output".
    const busy =
      one.held !== undefined ||
      one.state === 'connecting' ||
      (one.state === 'ready' && one.quiet < 1500);
    return row(
      busy ? p.write_bg : '',
      p.text,
      terminalLamp(one),
      `${padTo(names[index]!, nameW)}  ${padTo(fit(doings[index]!, doingW), doingW)}  `,
      rightTo(metas[index]!, metaW),
      now,
    );
  });
  if (sessions.length > shown.length)
    rows.push(
      sgrJoin(p.panel_bg, p.faint) +
        padTo(`  … +${sessions.length - shown.length} more terminals`, width) +
        p.reset,
    );
  return rows;
}

// The terminal page's band, two rows on the panel background like the job's: its lamp,
// id and name, the device and state; the second row names the transport and address,
// or — while the person is attached — says how to leave, as every mode's line does.
export function terminalBand(
  session: TerminalBandView,
  width: number,
  attached: boolean,
  now = Date.now(),
): string[] {
  const p = palette();
  const w = Math.max(20, width);
  const lamp = terminalLamp(session);
  const state = session.held
    ? uiText('waiting for you')
    : session.state === 'ready'
      ? session.quiet < 1500
        ? 'output'
        : `quiet ${formatElapsed(Math.round(session.quiet / 1000))}`
      : session.detail || session.state;
  const meta = state;
  const light = lampSgr(lamp, now);
  const name = `${session.id} ${session.name}`;
  const first =
    sgrJoin(p.panel_bg) +
    ' ' +
    sgrJoin(p.panel_bg, light) +
    (light ? '●' : ' ') +
    sgrJoin(p.panel_bg, p.em) +
    ' ' +
    padTo(name, w - 3 - stringWidth(meta) - 2 - 1) +
    '  ' +
    sgrJoin(p.panel_bg, p.dim) +
    meta +
    ' ' +
    p.reset;
  // A bare host connect is named by its address, so the row above already shows it:
  // say the transport and the size the device lays out at, and name the address only
  // when the line above does not.
  const size = `${session.cols}×${session.rows}`;
  const second = attached
    ? 'typing goes to the device · ctrl+] detaches'
    : session.name === session.target
      ? `${session.transport} · ${size}`
      : `${session.transport} ${session.target} · ${size}`;
  return [
    first,
    sgrJoin(p.panel_bg, attached ? p.em : p.faint) +
      padTo('   ' + second, w) +
      p.reset,
  ];
}

// The job page's band, on the panel background: its lamp, id and
// The job page's band, on the panel background: its lamp, id and
// command, its state and time; under them the file its output goes to.
export function jobBand(job: Job, width: number, now = Date.now()): string[] {
  const p = palette();
  const w = Math.max(20, width);
  const running = job.status === 'running';
  const waiting = running && job.detail === 'waiting for you';
  const lamp: LampState = waiting
    ? 'wait'
    : running
      ? 'running'
      : job.status === 'done'
        ? 'ok'
        : job.status === 'failed'
          ? 'error'
          : 'none';
  const state = waiting ? 'waiting' : running ? 'running' : outcomeWords(job);
  const meta = `${state} · ${elapsed(job)}`;
  const where = job.virtualPath || job.outputPath || '';
  const light = lampSgr(lamp, now);
  const name = `${job.id} ${plainJobOutput(job.title).replace(/\s+/g, ' ')}`;
  const first =
    sgrJoin(p.panel_bg) +
    ' ' +
    sgrJoin(p.panel_bg, light) +
    (light ? '●' : ' ') +
    sgrJoin(p.panel_bg, p.em) +
    ' ' +
    padTo(name, w - 3 - stringWidth(meta) - 2 - 1) +
    '  ' +
    sgrJoin(p.panel_bg, p.dim) +
    meta +
    ' ' +
    p.reset;
  if (!where) return [first];
  return [
    first,
    sgrJoin(p.panel_bg, p.faint) + padTo('   ' + where, w) + p.reset,
  ];
}
