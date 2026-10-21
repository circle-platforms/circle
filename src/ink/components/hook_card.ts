import type { HookChange, HookPreview } from '../../hooks.js';
import type {
  Card,
  CardLine,
  CardResult,
  CardTone,
  DialogState,
} from './dialog_card.js';

export type HookAnswer = 'approve' | 'skip';

const MARKS: Record<HookPreview['mark'], [string, CardTone]> = {
  new: ['new hook', 'added'],
  changed: ['changed hook', 'warn'],
  removed: ['removed hook', 'removed'],
  unchanged: ['unchanged hook', 'dim'],
};
// keys that are not the card's business and must reach the session (interrupt, scroll)
const PASS = new Set(['pageup', 'pagedown', 'home', 'end']);

/**
 * A project hooks file that waits for approval, as a card: the file, then each hook in
 * the version that was read (name, event and command, marked new, changed or removed
 * against the version approved last; unchanged ones share a line). The options are
 * `skip` and `approve these hooks`, and focus starts on `skip`: enter, `1` and esc leave
 * the hooks off, so a key meant for something else cannot approve them. `2`, or down and
 * enter, approves. There is no y / n, and every other printable is swallowed.
 */
export class HookApprovalCard implements Card<HookAnswer> {
  focus = 0;
  readonly options: [HookAnswer, string][] = [
    ['skip', 'skip'],
    ['approve', 'approve these hooks'],
  ];
  constructor(readonly change: HookChange) {}
  state(): DialogState {
    const lines: CardLine[] = [{ text: this.change.file, tone: 'em' }];
    const same: string[] = [];
    for (const hook of this.change.hooks) {
      if (hook.mark === 'unchanged') {
        same.push(hook.name);
        continue;
      }
      const [word, tone] = MARKS[hook.mark];
      lines.push({
        text: `${word} · ${hook.name} · ${hook.event} · ${hook.command}`,
        tone,
      });
    }
    if (same.length)
      lines.push({
        text: `${MARKS.unchanged[0]} · ${same.join(', ')}`,
        tone: 'dim',
      });
    const anchor = lines.length;
    lines.push({
      text: 'These hooks run shell commands. They stay off until you approve this version of the file.',
      tone: 'dim',
    });
    return {
      title: 'project hooks need approval',
      body: '',
      lines,
      anchor,
      options: this.options.map(([, label]) => label),
      focus: this.focus,
    };
  }
  handle(key: string, _char: string): CardResult<HookAnswer> {
    const count = this.options.length;
    if (['up', 'left', 'ctrl+p'].includes(key)) {
      this.focus = (this.focus - 1 + count) % count;
      return undefined;
    }
    if (['down', 'right', 'tab', 'ctrl+n'].includes(key)) {
      this.focus = (this.focus + 1) % count;
      return undefined;
    }
    if (key === 'enter') return { answer: this.options[this.focus]![0] };
    if (key === 'escape') return { answer: 'skip' };
    if (/^[1-9]$/.test(key))
      return Number(key) <= count
        ? { answer: this.options[Number(key) - 1]![0] }
        : undefined;
    if (key.startsWith('ctrl+') || PASS.has(key)) return 'pass';
    return undefined; // printable and everything else: swallowed
  }
  paste(): void {}
}
