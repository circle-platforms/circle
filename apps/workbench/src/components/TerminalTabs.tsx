import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import '../styles/terminal-tabs.css';

/** What a tab's dot says: Circle works in it, it waits for you, it failed, it is over. */
export type TabState = 'run' | 'wait' | 'fail' | 'done';

export interface TerminalTab {
  key: string;
  label: string;
  title?: string;
  state?: TabState;
  /** The id of the surface the tab shows, for assistive technology. */
  controls?: string;
  /** Present when the tab can be closed; its name says what closing does. */
  closeLabel?: string;
  onClose?: () => void;
}

/**
 * The terminals of one conversation in a single row, whatever they are: a shell of
 * yours, a command Circle runs in the background, a device console. One tab is
 * selected; the row scrolls sideways when there are more than fit, and keeps the
 * selected one in view. What the selected tab can be told to do (stop, take over)
 * stands at the end of the row, beside what the drawer offers.
 */
export function TerminalTabs({
  leading,
  tabs,
  selected,
  active,
  onSelect,
  menu,
  actions,
  end,
}: {
  /** Before the tabs: the way back out of a view of one command. */
  leading?: ReactNode;
  tabs: TerminalTab[];
  selected: string;
  /** The drawer is showing this mode. */
  active: boolean;
  onSelect: (key: string) => void;
  /** The button that makes a terminal or reaches a device. */
  menu?: ReactNode;
  /** Buttons for the selected tab: shown only when there is something to press. */
  actions?: ReactNode;
  /** Buttons the drawer adds: more actions, a window of its own, the full view. */
  end?: ReactNode;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const order = tabs.map((tab) => tab.key).join('\n');
  useLayoutEffect(() => {
    const node = strip.current;
    if (!active || !node) return;
    const reveal = () => {
      if (!node.clientWidth) return;
      const tab = node.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!tab) return;
      const view = node.getBoundingClientRect();
      const item = (tab.parentElement ?? tab).getBoundingClientRect();
      const left = view.left + node.clientLeft;
      const right = left + node.clientWidth;
      // Only this scroller moves: scrollIntoView could shift the drawer or the
      // conversation the person is reading.
      if (item.width > node.clientWidth || item.left < left)
        node.scrollLeft += item.left - left;
      else if (item.right > right) node.scrollLeft += item.right - right;
    };
    reveal();
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      reveal();
    });
    observer.observe(node);
    return () => observer.disconnect();
    // Output and status changes keep the order, and must not undo a hand-scrolled row.
  }, [active, selected, order]);
  return (
    <div className="term-tabbar">
      {leading}
      <div
        className="term-tabs"
        ref={strip}
        role="tablist"
        aria-label={t('terminal tabs')}
      >
        {tabs.map((tab) => {
          const on = tab.key === selected;
          return (
            <div
              key={tab.key}
              className={`term-tab${on ? ' on' : ''}${tab.onClose ? ' closable' : ''}`}
            >
              <button
                type="button"
                role="tab"
                className="term-tab-main"
                aria-selected={on}
                aria-controls={tab.controls}
                tabIndex={on ? 0 : -1}
                title={tab.title ?? tab.label}
                onClick={() => onSelect(tab.key)}
                onKeyDown={(event) => {
                  const index = tabs.findIndex((one) => one.key === tab.key);
                  const to =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : event.key === 'ArrowLeft'
                          ? (index + tabs.length - 1) % tabs.length
                          : event.key === 'ArrowRight'
                            ? (index + 1) % tabs.length
                            : -1;
                  const next = tabs[to];
                  if (!next) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(next.key);
                  requestAnimationFrame(() =>
                    strip.current
                      ?.querySelectorAll<HTMLElement>('[role="tab"]')
                      [to]?.focus(),
                  );
                }}
              >
                {tab.state && (
                  <i className="term-dot" data-state={tab.state} aria-hidden />
                )}
                <span className="term-tab-label">{tab.label}</span>
              </button>
              {tab.onClose && (
                <button
                  type="button"
                  className="term-tab-x"
                  aria-label={tab.closeLabel}
                  title={tab.closeLabel}
                  onClick={() => tab.onClose?.()}
                >
                  <X size={12} aria-hidden />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {menu}
      <span className="term-tabbar-end">
        {actions}
        {end}
      </span>
    </div>
  );
}
