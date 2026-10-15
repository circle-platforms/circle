import { palette, sgrJoin } from '../theme.js';
import { pad, stringWidth, truncate } from '../string_width.js';
import { printable } from './dialog_card.js';
export interface PickerItem {
  key: string;
  label: string;
  meta?: string;
  search?: string;
  current?: boolean;
}
export interface PickerOptions {
  keys?: Record<string, (item: PickerItem | undefined) => void | Promise<void>>;
  hint?: string;
  /** Shown when the filter matches nothing. A function can tell a search miss from an empty list. */
  empty?: string | ((query: string, total: number) => string);
  focusKey?: string;
  /** false: typing does not search. The keys the list does not use go on to the input box,
   * and ctrl+c closes the list before the session takes it (`/approvals`, as 0.5.0's). */
  search?: boolean;
  /** enter on a search nothing matches: what was typed (a model id the endpoint does not list). */
  freeText?: (text: string) => void | Promise<void>;
}
interface Asked {
  label: string;
  text: string;
  done: (text: string) => void | Promise<void>;
  mask: boolean;
  keys: string;
  cancel?: () => void;
  /** The next typed character replaces `text` (a rename starts with the old name selected). */
  replace: boolean;
}
function dropLast(text: string): string {
  return Array.from(text).slice(0, -1).join('');
}
/**
 * A searchable list above the frame (0.5.0's picker.py). Type to narrow it (every word must
 * appear), ↑ ↓ move (wrapping), pageup pagedown jump, enter picks, esc clears the search or
 * closes. A list can bind keys of its own and can ask, in place of the search, for a line of
 * text (a new name, a key shown as dots) or for a confirmation; esc there cancels and leaves
 * everything as it was.
 */
export class Picker {
  query = '';
  focus = 0;
  // The rows the last paint showed: pageup and pagedown move by that many.
  private window = 10;
  private asked?: Asked;
  private confirming?: { question: string; done: () => void | Promise<void> };
  /** Runs what an answer does; the session puts its own here to repaint and report errors. */
  settle: (work: () => void | Promise<void>) => void = (work) => {
    void Promise.resolve().then(work);
  };
  constructor(
    public title: string,
    public items: PickerItem[],
    readonly pick: (item: PickerItem) => void,
    readonly close: () => void,
    readonly options: PickerOptions = {},
  ) {
    this.focus = Math.max(
      0,
      items.findIndex((item) =>
        options.focusKey ? item.key === options.focusKey : item.current,
      ),
    );
  }
  setItems(items: PickerItem[]): void {
    const key = this.matches()[this.focus]?.key;
    this.items = items;
    this.focus = Math.max(
      0,
      this.matches().findIndex((item) => item.key === key),
    );
  }
  matches(): PickerItem[] {
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.items.filter((item) =>
      words.every((word) =>
        `${item.label} ${item.meta || ''} ${item.search || ''}`
          .toLowerCase()
          .includes(word),
      ),
    );
  }
  /** A line of text in place of the search: enter hands it to `done`, esc cancels. `mask`
   * shows what is typed or pasted as dots, as setup shows a key. `cancel` runs after esc, in
   * place of going back to the list (/login's URL leaves, its key goes back to the URL). */
  ask(
    label: string,
    text: string,
    done: (text: string) => void | Promise<void>,
    options: {
      mask?: boolean;
      keys?: string;
      cancel?: () => void;
      replace?: boolean;
    } = {},
  ): void {
    this.confirming = undefined;
    this.asked = {
      label,
      text,
      done,
      mask: Boolean(options.mask),
      keys: options.keys ?? 'enter saves · esc cancels',
      cancel: options.cancel,
      replace: Boolean(options.replace),
    };
  }
  /** A yes or no in place of the search: enter runs `done`, esc cancels. */
  confirm(question: string, done: () => void | Promise<void>): void {
    this.asked = undefined;
    this.confirming = { question, done };
  }
  /** It is asking for a line of text or a confirmation. */
  get asking(): boolean {
    return Boolean(this.asked || this.confirming);
  }
  /** Every key goes to the list while it is open; false for the keys it leaves to the
   * session: ctrl+c and ctrl+d, and in a list without a search the keys it does not use. */
  handle(key: string, char: string): boolean {
    if (this.confirming) {
      const { done } = this.confirming;
      if (key === 'enter') {
        this.confirming = undefined;
        this.settle(done);
      } else if (key === 'escape' || key === 'ctrl+c')
        this.confirming = undefined;
      return true;
    }
    if (this.asked) {
      const asked = this.asked;
      if (key === 'enter') {
        this.asked = undefined;
        this.settle(() => asked.done(asked.text));
      } else if (key === 'escape' || key === 'ctrl+c') {
        this.asked = undefined;
        asked.cancel?.();
      } else if (key === 'backspace') {
        asked.text = asked.replace ? '' : dropLast(asked.text);
        asked.replace = false;
      } else if (key === 'ctrl+u') {
        asked.text = '';
        asked.replace = false;
      } else {
        const typed = printable(key, char);
        if (!typed) return true;
        asked.text = asked.replace ? typed : asked.text + typed;
        asked.replace = false;
      }
      return true;
    }
    const shown = this.matches();
    if (this.options.keys?.[key]) {
      this.options.keys[key](shown[this.focus]);
      return true;
    }
    if (['up', 'ctrl+p'].includes(key)) {
      if (shown.length)
        this.focus = (this.focus - 1 + shown.length) % shown.length;
    } else if (['down', 'ctrl+n'].includes(key)) {
      if (shown.length) this.focus = (this.focus + 1) % shown.length;
    } else if (key === 'pageup')
      this.focus = Math.max(0, this.focus - this.window);
    else if (key === 'pagedown')
      this.focus = Math.max(
        0,
        Math.min(shown.length - 1, this.focus + this.window),
      );
    else if (key === 'enter') {
      const item = shown[this.focus];
      if (item) this.pick(item);
      else if (this.options.freeText && this.query.trim()) {
        const typed = this.query.trim();
        this.settle(() => this.options.freeText!(typed));
      }
    } else if (key === 'escape') {
      if (this.query) {
        this.query = '';
        this.focus = 0;
      } else this.close();
    } else if (this.options.search === false) {
      if (key === 'ctrl+c') this.close();
      return false;
    } else if (key === 'ctrl+c' || key === 'ctrl+d') return false;
    else if (key === 'backspace') {
      this.query = dropLast(this.query);
      this.focus = 0;
    } else if (key === 'ctrl+u') {
      this.query = '';
      this.focus = 0;
    } else {
      const typed = printable(key, char);
      if (typed) {
        this.query += typed;
        this.focus = 0;
      }
    }
    return true;
  }
  /** A paste goes where typing goes: the line it asks for, or the search. One line only. */
  paste(text: string): void {
    const line = printable('', text.replace(/[\r\n]/g, ''));
    if (this.confirming || !line) return;
    if (this.asked) {
      this.asked.text = this.asked.replace ? line : this.asked.text + line;
      this.asked.replace = false;
    } else {
      this.query += line;
      this.focus = 0;
    }
  }
  rows(width: number, maximum = 10): string[] {
    const p = palette();
    this.window = Math.max(1, maximum);
    const shown = this.matches();
    const top = Math.max(0, this.focus - maximum + 1);
    const info = (text: string, tone: string): string =>
      sgrJoin(p.panel_bg, tone) + pad(truncate(text, width), width) + p.reset;
    const rows = [info(`   ${this.title}`, p.faint)];
    if (this.asked) {
      const typed = this.asked.mask
        ? '•'.repeat(Array.from(this.asked.text).length)
        : this.asked.text;
      rows.push(
        info(`   ${this.asked.label}: ${typed}▏  ${this.asked.keys}`, p.dim),
      );
    } else if (this.confirming)
      rows.push(
        info(
          `   ${this.confirming.question}  enter confirms · esc cancels`,
          p.dim,
        ),
      );
    else {
      if (this.options.hint)
        rows.push(info(`   ${this.options.hint}`, p.faint));
      if (this.options.search !== false)
        rows.push(
          info(
            `   ${this.query ? 'search: ' + this.query : 'type to search'}`,
            p.faint,
          ),
        );
    }
    const headOf = (item: PickerItem): string =>
      `${item.current ? '● ' : ''}${item.label}${item.current ? ' · current' : ''}`;
    // The time (or any meta) starts in one column. CJK titles are wider than
    // their character count, so the pad uses display width.
    const metas = shown.some((item) => item.meta);
    const widest = Math.max(
      0,
      ...shown.map((item) => stringWidth(headOf(item))),
    );
    const column = metas ? Math.min(widest, Math.max(8, width - 3 - 8)) : 0;
    shown.slice(top, top + maximum).forEach((item, index) => {
      const marked = index + top === this.focus;
      const head = headOf(item);
      const body = metas ? pad(truncate(head, column), column) : head;
      const meta = item.meta ? `  ${item.meta}` : '';
      rows.push(
        sgrJoin(marked ? p.sel_bg : p.panel_bg, p.text) +
          pad(truncate(` ${marked ? '>' : ' '} ${body}${meta}`, width), width) +
          p.reset,
      );
    });
    if (!shown.length) {
      const empty =
        typeof this.options.empty === 'function'
          ? this.options.empty(this.query, this.items.length)
          : (this.options.empty ?? 'Nothing to show');
      rows.push(p.faint + '   ' + empty + p.reset);
    }
    return rows;
  }
}
