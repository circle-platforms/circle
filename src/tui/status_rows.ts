// The rows that say what is true now: the header, the busy word on the frame, the footer's
// meters, the line under each turn, and the window title. Colours come from the palette
// each time a row is drawn.
import { homedir } from 'node:os';
import { basename, sep } from 'node:path';
import { palette, statusLight, type LampState } from '../ink/theme.js';
import { stringWidth, truncate } from '../ink/string_width.js';
import { EFFORT_LEVELS } from '../model.js';
import { cacheRateLabel } from '../pricing.js';
import type { Usage } from '../types.js';
import type { CompactionProgress } from '../compaction.js';

// What the frame's top edge says while the model works, one word picked per turn.
export const BUSY_VERBS = [
  'Thinking',
  'Considering',
  'Analyzing',
  'Brewing',
  'Pondering',
  'Cogitating',
  'Reflecting',
  'Processing',
  'Evaluating',
  'Examining',
] as const;
export function pickBusyVerb(random = Math.random): string {
  return BUSY_VERBS[Math.floor(random() * BUSY_VERBS.length)] ?? 'Brewing';
}

// A thought's clock, in tenths under a minute: `6.3s`, `3m 5s`, `1h 2m`. The desktop
// application's turn clock keeps it.
export function formatBusyElapsed(seconds: number): string {
  const value = Math.max(0, seconds);
  if (value < 60) return `${value.toFixed(1)}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(value) % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
// The clock of the busy word, the strip and the turn line: `12s`, `3m 5s`, `1h 2m`.
export function formatElapsed(seconds: number): string {
  const value = Math.max(0, seconds);
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(value) % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
/** How long passed between two messages, or blank when that would read as `0s`. */
export function gapElapsed(
  previousMs: number | undefined,
  created: number | string,
): string {
  if (previousMs === undefined) return '';
  const at = new Date(created).getTime();
  if (!Number.isFinite(at)) return '';
  const text = formatElapsed((at - previousMs) / 1000);
  return text === '0s' ? '' : text;
}
// `840`, `12.3k`, `7.8M`: past a million the k would grow to `7824.0k`.
export function formatTokens(value: number): string {
  const count = Math.max(0, Math.floor(value || 0));
  return count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 1000
      ? `${(count / 1000).toFixed(1)}k`
      : String(count);
}
function formatWindow(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : formatTokens(value);
}

// `Brewing… · 12s · ↓ 1.9k`: the turn's word, its time and the tokens it has written.
export function busyLabel(
  verb: string,
  seconds: number,
  tokens: number,
  detail?: string,
): string {
  return `${verb}… · ${detail ? detail + ' · ' : ''}${formatElapsed(seconds)} · ↓ ${formatTokens(tokens)}`;
}

// A folder as people write it: the home folder is `~`.
export function displayPath(path: string, home = homedir()): string {
  if (home && (path === home || path.startsWith(home + sep)))
    return '~' + path.slice(home.length);
  return path;
}

export interface HeaderInfo {
  version: string;
  model: string;
  depth?: string;
  workspace: string;
  branch?: string;
  // Setup or trust is asking: the welcome says who and where, the row stays empty.
  gate?: boolean;
  // The session is up: only then is there a key to hint at.
  connected?: boolean;
  // The welcome block is on screen and already says who and where.
  welcomeInView?: boolean;
}
// ` circle <version> · <model • depth> · <folder> (<branch>)`, the one key hint on the right
// when it fits, and a blank row under it. What gives way first: the hint, then the folder
// (cut from the left, its tail tells folders apart), then the model name.
export function headerRows(info: HeaderInfo, width: number): string[] {
  const p = palette();
  if (info.gate) return ['', ''];
  const model =
    info.depth && (EFFORT_LEVELS as readonly string[]).includes(info.depth)
      ? `${info.model} • ${info.depth}`
      : info.model;
  const head = ` circle ${info.version} · `;
  const path =
    displayPath(info.workspace) + (info.branch ? ` (${info.branch})` : '');
  const hint = '? for shortcuts';
  let room = width - 1;
  const showHint =
    info.connected !== false &&
    width >= 60 &&
    stringWidth(head + model) + 12 + stringWidth(hint) + 2 <= width;
  if (showHint) room -= stringWidth(hint) + 2;
  const leftRoom = room - stringWidth(head);
  let text: string;
  if (leftRoom < 1) text = truncate(head + model, Math.max(1, room));
  else {
    const shown = truncate(model, leftRoom);
    const pathRoom = leftRoom - stringWidth(shown) - 3;
    text =
      pathRoom >= 4
        ? `${head}${shown} · ${truncate(path, pathRoom, true)}`
        : `${head}${shown}`;
  }
  if (info.welcomeInView) text = '';
  const gap = showHint
    ? Math.max(1, width - stringWidth(text) - stringWidth(hint) - 1)
    : 0;
  return [
    p.dim +
      text +
      p.reset +
      (showHint ? ' '.repeat(gap) + p.faint + hint + p.reset + ' ' : ''),
    '',
  ];
}

/** Input tokens for the context meter. A partial saved on interrupt has neither a
 * request model nor a measured input; `0/N/A` would disagree with the turn line. */
export function contextInputOf(
  message: { request_model?: string; usage?: Usage } | undefined,
  model: string,
): number | undefined {
  const usage = message?.usage;
  if (!usage) return undefined;
  if (message?.request_model && message.request_model !== model)
    return undefined;
  if (!message?.request_model && !usage.input_tokens) return undefined;
  return usage.input_tokens;
}
export interface Meters {
  usage: Usage;
  costText?: string;
  contextInput?: number;
  contextEstimated?: boolean;
  contextWindow?: number;
  /** A turn is in flight and the endpoint has not reported usage yet. */
  unreported?: boolean;
}
// `↑ 36.6k · ↓ 560 · $0.0145 · cache 63.7% · ctx 12.5k/1.0M (1%)`, and how full the context
// is: past 70% yellow, past 90% red.
function meterParts(meters: Meters): {
  head: string;
  context: string;
  percent: number;
  /** Pieces dropped from the right until the footer fits: context, cache, then cost. */
  lines: string[];
} {
  const usage = meters.usage;
  // Zero tokens before the endpoint answers is not a measured empty call.
  const unknown = meters.unreported === true;
  const tokens = `↑ ${unknown ? 'N/A' : formatTokens(usage.input_tokens)} · ↓ ${formatTokens(usage.output_tokens)}`;
  const cache = `cache ${unknown ? 'N/A' : cacheRateLabel(usage)}`;
  const cost = meters.costText ?? '';
  const head = [tokens, ...(cost ? [cost] : []), cache].join(' · ');
  let context = '';
  const estimateMark = meters.contextEstimated ? '~' : '';
  let percent = 0;
  if (meters.contextInput !== undefined && !meters.contextWindow)
    context = `ctx ${estimateMark}${formatTokens(meters.contextInput)}/N/A`;
  else if (meters.contextInput !== undefined && meters.contextWindow) {
    percent = Math.min(999, (meters.contextInput / meters.contextWindow) * 100);
    context = `ctx ${estimateMark}${formatTokens(meters.contextInput)}/${formatWindow(meters.contextWindow)} (${Math.round(percent)}%)`;
  }
  const lines = [
    [tokens, cost, cache, context],
    [tokens, cost, cache],
    [tokens, cost],
    [tokens],
  ].map((parts) => parts.filter(Boolean).join(' · '));
  return {
    head,
    context,
    percent,
    lines,
  };
}
// Shorten on a separator, then on a space, and only then mid-token with an ellipsis.
function fitSegment(text: string, width: number): string {
  const source = text.trimEnd();
  if (width <= 0) return '';
  if (stringWidth(source) <= width) return source;
  let rest = source;
  while (stringWidth(rest) > width) {
    const at = rest.lastIndexOf(' · ');
    if (at <= 0) break;
    rest = rest.slice(0, at);
  }
  if (stringWidth(rest) <= width) return rest;
  const space = rest.lastIndexOf(' ');
  if (space > 0) {
    const word = rest.slice(0, space).trimEnd();
    if (word && stringWidth(word) <= width) return fitSegment(word, width);
  }
  return truncate(rest, width).trimEnd();
}
// The footer: the meters, and a flash at the right for a second or two. While a flash shows,
// the meters' tail gives way and they are not coloured. Without a flash, extensions' status
// lines sit at the right; when they do not all fit beside the meters, none is shown.
export function footerRow(
  meters: Meters,
  flash: string,
  width: number,
  status: { text: string; lamp: LampState }[] = [],
): string {
  const p = palette();
  const parts = meterParts(meters);
  const { context, percent } = parts;
  const room = Math.max(1, width - 1);
  const fitted =
    parts.lines.find((line) => stringWidth(line) <= room) ??
    parts.lines[parts.lines.length - 1]!;
  const plain = stringWidth(fitted) <= room ? fitted : truncate(fitted, room);
  const showsContext = Boolean(context) && plain.includes(context);
  if (flash) {
    // The flash is its own segment. Meters give way on a ` · ` boundary, so a
    // narrow row does not become `cach  cleared`.
    const shown = fitSegment(flash, Math.max(1, width - 2));
    const room = width - 1 - stringWidth(shown) - 3;
    if (room < 12) return p.faint + ' ' + shown + p.reset;
    const left = fitSegment(fitted, room);
    const gap = Math.max(
      1,
      width - 1 - stringWidth(left) - stringWidth(shown) - 1,
    );
    return p.faint + ' ' + left + ' '.repeat(gap) + shown + ' ' + p.reset;
  }
  const left =
    !showsContext || percent < 70
      ? p.faint + ' ' + plain + p.reset
      : p.faint +
        ' ' +
        plain.slice(0, plain.length - context.length) +
        p.reset +
        (percent >= 90 ? p.red : p.yellow) +
        context +
        p.reset;
  if (!status.length) return left;
  const lit = (lamp: LampState): boolean => lamp !== 'none';
  const rightWidth =
    status.reduce(
      (sum, item) => sum + (lit(item.lamp) ? 2 : 0) + stringWidth(item.text),
      0,
    ) +
    2 * (status.length - 1);
  // The right edge stops at the second-to-last column, as the flash does.
  const gap = width - 2 - stringWidth(plain) - rightWidth;
  if (gap < 3) return left;
  return (
    left +
    ' '.repeat(gap) +
    status
      .map(
        (item) =>
          (lit(item.lamp) ? statusLight(item.lamp) + ' ' : '') +
          p.faint +
          item.text +
          p.reset,
      )
      .join('  ') +
    ' '
  );
}

// Under a turn: its time (without waits on you) and the tokens it sent and received,
// subagents' included: `12s · ↑ 1.2k · ↓ 340`.
export interface TurnUsage {
  seconds: number;
  input: number;
  output: number;
  unreported?: boolean;
  /** In US dollars; null when a request's price is not known in dollars. */
  cost?: number | null;
}
export function turnUsageRow(usage: TurnUsage): string {
  const p = palette();
  const show = (n: number) =>
    usage.unreported ? (n ? formatTokens(n) + '+' : 'N/A') : formatTokens(n);
  return `   ${p.dim}${formatElapsed(usage.seconds)} · ↑ ${show(usage.input)} · ↓ ${show(usage.output)}${p.reset}`;
}

// Above the input box while a compaction runs: `auto-compacting · ████░░░░ summarizing · 12s`
// (`compacting` for /compact and the model's own call). The bar is full only once the
// summary is in; a narrow screen drops the stage and the clock before the bar.
const BAR_CELLS = 16;
export function compactionRow(
  progress: CompactionProgress,
  width: number,
  now = Date.now(),
): string {
  const p = palette();
  const fraction = progress.fraction();
  let filled = Math.round(fraction * BAR_CELLS);
  if (fraction < 1) filled = Math.min(filled, BAR_CELLS - 1);
  const head = `${progress.label} · `;
  const parts = progress.snapshot
    ? ` ${progress.snapshot.completed}/${Math.max(progress.snapshot.completed, progress.snapshot.total)}`
    : '';
  let tail = ` ${progress.stage}${parts} · ${Math.round(progress.elapsed(now))}s`;
  const room = Math.max(8, width - 2);
  if (stringWidth(head) + BAR_CELLS + stringWidth(tail) > room) tail = '';
  if (stringWidth(head) + BAR_CELLS > room)
    return ' ' + p.faint + truncate((head + tail).trimEnd(), room) + p.reset;
  return (
    ` ${p.faint}${head}${p.text}${'█'.repeat(filled)}` +
    `${p.faint}${'░'.repeat(BAR_CELLS - filled)}${p.reset}${p.faint}${tail}${p.reset}`
  );
}

// The terminal window's title, as pi sets it: `circle - <title> - <folder>`.
export function windowTitle(sessionTitle: string, workspace: string): string {
  const title = sessionTitle === 'new' ? '' : sessionTitle.split('\n')[0]!;
  return [
    'circle',
    Array.from(title).slice(0, 40).join(''),
    basename(workspace),
  ]
    .filter(Boolean)
    .join(' - ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .slice(0, 120);
}
