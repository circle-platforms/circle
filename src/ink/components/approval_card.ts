import {
  printable,
  type Card,
  type CardLine,
  type CardResult,
  type CardTint,
  type DialogState,
} from './dialog_card.js';
/** What the card answers; the harness turns a reason into the tool result the model reads. */
export type ApprovalAnswer =
  | 'approve'
  | 'always'
  | 'prefix'
  | 'reject'
  | { decision: 'reject'; message: string };
export interface ApprovalRequest {
  tool: string;
  /** A background agent asks: its job and name, which come first in the title. */
  origin?: string;
  /** The command, the file or the patch's files, or the arguments. */
  body: string;
  /** For a file change: the summary row, then the diff. */
  preview?: CardLine[];
  /** Why it asks, from the policy. */
  policy?: string;
  /** The "for this session" option, with what it covers (empty: not offered). */
  scope?: string;
  /** The "commands starting with these words" option (empty: not offered). */
  prefixScope?: string;
  warnDelete?: boolean;
}
const SHORT_NAMES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  apply_patch: 'Patch',
  delete: 'Delete',
  ls: 'Ls',
  glob: 'Glob',
  grep: 'Grep',
  execute: 'Bash',
  task: 'Agent',
  write_todos: 'TodoWrite',
  webfetch: 'Fetch',
  websearch: 'Search',
  question: 'Question',
  skill: 'Skill',
  lsp: 'Lsp',
  compact_conversation: 'Compact',
  list_jobs: 'Jobs',
  stop_job: 'StopJob',
  wait_jobs: 'WaitJobs',
};
const READ_TOOLS = new Set(
  'read_file ls glob grep lsp skill webfetch websearch'.split(' '),
);
const WRITE_TOOLS = new Set(
  'write_file edit_file apply_patch delete execute'.split(' '),
);
/** The tint of the tool's type, as its row in the conversation carries it. */
export function toolTint(name: string): CardTint | undefined {
  if (READ_TOOLS.has(name)) return 'read_bg';
  if (WRITE_TOOLS.has(name)) return 'write_bg';
  if (name === 'task') return 'agent_bg';
  if (name === 'question') return 'think_bg';
  return undefined;
}
type Kind = 'approve' | 'always' | 'prefix' | 'explain';
// keys that are not the card's business and must reach the session (interrupt, scroll)
const PASS = new Set(['pageup', 'pagedown', 'home', 'end']);
/**
 * A tool approval as a card. Options, in order: `Allow once`, `Allow <scope> for this
 * session` (when the policy lets the call be remembered), `Allow "<words> …" for this
 * session` (a simple command) and `Reject and explain`. Digits pick and confirm; `y` / `a` /
 * `n` do the same without being shown; arrows, tab and `hjkl` move; `enter` confirms;
 * `esc` and `n` reject at once. `Reject and explain` turns the last row into an input.
 * The session routes that row through the composer: `enter` sends the text with the
 * rejection (empty is a plain rejection), a `/command` runs and the card stays, and
 * `esc` goes back to the options and keeps what was typed. Every other printable key
 * is swallowed while the options are up, so a key typed for the draft cannot answer.
 */
export class ApprovalCard implements Card<ApprovalAnswer> {
  focus = 0;
  /** The reason row is open. The session owns its keys; this only remembers the mode. */
  explaining = false;
  /** What was typed in the reason row. `esc` leaves the row and keeps this. */
  draft = '';
  readonly options: [Kind, string][];
  constructor(readonly request: ApprovalRequest) {
    this.options = [['approve', 'Allow once']];
    if (request.scope)
      this.options.push(['always', `Allow ${request.scope} for this session`]);
    if (request.prefixScope)
      this.options.push([
        'prefix',
        `Allow ${request.prefixScope} for this session`,
      ]);
    this.options.push(['explain', 'Reject and explain']);
  }
  state(): DialogState {
    const request = this.request;
    const name = SHORT_NAMES[request.tool] ?? request.tool;
    const title = `${name} needs your permission`;
    const lines: CardLine[] = (request.body || '')
      .split('\n')
      .map((text, index) => ({ text, tone: index ? 'text' : 'em' }));
    const anchor = lines.length;
    // a file change: what it adds and removes, coloured like the diff after the edit
    for (const row of request.preview ?? [])
      lines.push({
        text: row.text,
        tone:
          row.tone === 'added' || row.tone === 'removed' ? row.tone : 'faint',
      });
    if (request.warnDelete)
      lines.push({ text: 'This deletes or overwrites data.', tone: 'warn' });
    if (request.policy) lines.push({ text: request.policy, tone: 'dim' });
    const tint = toolTint(request.tool);
    return {
      title: request.origin ? `${request.origin} · ${title}` : title,
      body: '',
      lines,
      anchor,
      options: this.options.map(([, label]) => label),
      focus: this.focus,
      ...(tint ? { tint } : {}),
      ...(this.explaining
        ? {
            input: this.draft,
            placeholder: 'empty enter rejects · esc returns',
          }
        : {}),
    };
  }
  private submit(index: number): CardResult<ApprovalAnswer> {
    const kind = this.options[index]![0];
    if (kind !== 'explain') return { answer: kind };
    this.focus = index;
    this.explaining = true;
    return undefined;
  }
  handle(key: string, char: string): CardResult<ApprovalAnswer> {
    // The reason row is the composer. SessionApp reads these keys; a second pass here
    // would approve, reject, or throw away the draft.
    if (this.explaining) return undefined;
    const count = this.options.length;
    if (['up', 'left', 'ctrl+p', 'k', 'h'].includes(key)) {
      this.focus = (this.focus - 1 + count) % count;
      return undefined;
    }
    if (['down', 'right', 'tab', 'ctrl+n', 'j', 'l'].includes(key)) {
      this.focus = (this.focus + 1) % count;
      return undefined;
    }
    if (key === 'enter') return this.submit(this.focus);
    if (key === 'escape' || key === 'n' || key === 'N')
      return { answer: 'reject' };
    if (/^[1-9]$/.test(key))
      return Number(key) <= count ? this.submit(Number(key) - 1) : undefined;
    if (key === 'y' || key === 'Y') return this.submit(0);
    if (key === 'a' || key === 'A') {
      const index = this.options.findIndex(([kind]) => kind === 'always');
      return index >= 0 ? this.submit(index) : undefined;
    }
    if (key.startsWith('ctrl+') || PASS.has(key)) return 'pass';
    return undefined; // printable and everything else: swallowed
  }
  paste(text: string): void {
    if (this.explaining)
      this.draft += printable('paste', text.replace(/\s*\n\s*/g, ' '));
  }
}
