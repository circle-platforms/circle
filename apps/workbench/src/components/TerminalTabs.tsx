import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ContextMenu, DropdownMenu } from 'radix-ui';
import { Check, ChevronDown, X } from 'lucide-react';
import { t } from '../i18n';
import { terminalKeyboardClaimed } from '../model/terminal-keyboard';
import '../styles/terminal-tabs.css';

function keepSurfaceFocus(event: Event): void {
  if (
    terminalKeyboardClaimed() ||
    document.activeElement?.closest(
      '.native-terminal-surface, .device-screen, [role="dialog"]:not([data-state="closed"])',
    )
  )
    event.preventDefault();
}

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
  /** What right-clicking the tab offers: rename it, close it, make another. */
  menu?: TerminalTabMenuItem[];
  /** This tab was dropped onto another: the row follows the person's order. */
  onMove?: (from: string, to: string) => void;
}

/** One entry of a tab's right-click menu; a separator is an entry of its own. */
export interface TerminalTabMenuItem {
  label?: string;
  onSelect?: () => void;
  disabled?: boolean;
  separator?: boolean;
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
  /** A tab chosen, by the keyboard on the row or otherwise. */
  onSelect: (key: string, fromKeyboard?: boolean) => void;
  /** The button that makes a terminal or reaches a device. */
  menu?: ReactNode;
  /** Buttons for the selected tab: shown only when there is something to press. */
  actions?: ReactNode;
  /** Buttons the drawer adds: more actions, a window of its own, the full view. */
  end?: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const pressed = useRef('');
  const menuPicked = useRef('');
  const [dragging, setDragging] = useState('');
  const [overflowing, setOverflowing] = useState(false);
  const order = tabs.map((tab) => tab.key).join('\n');
  const tabsSignature = tabs
    .map(
      (tab) =>
        `${tab.key}\t${tab.label}\t${tab.state ?? ''}\t${tab.onClose ? 1 : 0}`,
    )
    .join('\n');
  const measureOverflow = useCallback(() => {
    const node = strip.current;
    if (!active || !node || !node.clientWidth || tabs.length < 2) {
      setOverflowing(false);
      return;
    }
    const reserved = more.current ? more.current.offsetWidth + 2 : 0;
    setOverflowing(node.scrollWidth > node.clientWidth + reserved + 1);
  }, [active, tabs.length]);
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
  useLayoutEffect(() => {
    measureOverflow();
    if (!active) return;
    const observer = new ResizeObserver(() => measureOverflow());
    if (bar.current) observer.observe(bar.current);
    if (strip.current) observer.observe(strip.current);
    return () => observer.disconnect();
  }, [active, measureOverflow, tabsSignature, overflowing]);
  return (
    <div className="term-tabbar" ref={bar}>
      {leading}
      <div
        className="term-tabs"
        ref={strip}
        role="tablist"
        aria-label={t('terminal tabs')}
        onWheel={(event) => {
          const node = strip.current;
          if (
            !node ||
            node.scrollWidth <= node.clientWidth + 1 ||
            event.deltaY === 0 ||
            event.deltaX !== 0
          )
            return;
          const previous = node.scrollLeft;
          node.scrollLeft += event.deltaY;
          if (node.scrollLeft !== previous) event.preventDefault();
        }}
      >
        {tabs.map((tab) => {
          const on = tab.key === selected;
          const body = (
            <div
              key={tab.key}
              className={`term-tab${on ? ' on' : ''}${tab.onClose ? ' closable' : ''}`}
              draggable={!!tab.onMove}
              onPointerDown={() => {
                pressed.current = tab.key;
              }}
              onPointerUp={() => {
                pressed.current = '';
              }}
              onClick={(event) => {
                if (
                  !(event.target instanceof Element) ||
                  !event.target.closest('button')
                )
                  onSelect(tab.key);
              }}
              onDragStart={(event) => {
                const source = pressed.current || tab.key;
                const sourceTab = tabs.find((one) => one.key === source) ?? tab;
                if (!sourceTab.onMove) {
                  event.preventDefault();
                  return;
                }
                setDragging(source);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', source);
              }}
              onDragEnd={() => {
                pressed.current = '';
                setDragging('');
              }}
              onDragOver={(event) => {
                if (!dragging || dragging === tab.key) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                const from = dragging;
                pressed.current = '';
                setDragging('');
                if (!from || from === tab.key || !tab.onMove) return;
                event.preventDefault();
                tab.onMove(from, tab.key);
              }}
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
                  onSelect(next.key, true);
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
          if (!tab.menu?.length) return body;
          return (
            <ContextMenu.Root key={tab.key}>
              <ContextMenu.Trigger asChild>{body}</ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content
                  className="dropdown session-menu"
                  onCloseAutoFocus={keepSurfaceFocus}
                >
                  {tab.menu.map((item, place) =>
                    item.separator ? (
                      <ContextMenu.Separator
                        key={`sep-${tab.key}-${place}`}
                        className="dropdown-separator"
                      />
                    ) : (
                      <ContextMenu.Item
                        key={item.label}
                        disabled={item.disabled}
                        onSelect={() => item.onSelect?.()}
                      >
                        {item.label}
                      </ContextMenu.Item>
                    ),
                  )}
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          );
        })}
      </div>
      {overflowing && (
        <DropdownMenu.Root
          modal={false}
          onOpenChange={(open) => {
            if (open) menuPicked.current = '';
          }}
        >
          <DropdownMenu.Trigger asChild>
            <button
              ref={more}
              type="button"
              className="icon-button term-tabs-more"
              aria-label={t('all terminals')}
              title={t('all terminals')}
            >
              <ChevronDown size={14} aria-hidden />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="dropdown term-tabs-menu"
              align="start"
              sideOffset={6}
              onCloseAutoFocus={(event) => {
                if (menuPicked.current) {
                  menuPicked.current = '';
                  if (
                    terminalKeyboardClaimed() ||
                    document.activeElement !== document.body
                  ) {
                    event.preventDefault();
                    return;
                  }
                }
                keepSurfaceFocus(event);
              }}
            >
              {tabs.map((tab) => {
                const on = tab.key === selected;
                return (
                  <DropdownMenu.Item
                    key={tab.key}
                    className={`term-tabs-menu-item${on ? ' on' : ''}`}
                    onSelect={() => {
                      menuPicked.current = tab.key;
                      onSelect(tab.key);
                    }}
                  >
                    <span className="term-tabs-menu-mark" aria-hidden>
                      {tab.state && (
                        <i className="term-dot" data-state={tab.state} />
                      )}
                    </span>
                    <span
                      className="term-tabs-menu-label"
                      title={tab.title ?? tab.label}
                    >
                      {tab.label}
                    </span>
                    {on && (
                      <Check
                        size={13}
                        className="term-tabs-menu-check"
                        aria-hidden
                      />
                    )}
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      {menu}
      <span className="term-tabbar-end">
        {actions}
        {end}
      </span>
    </div>
  );
}
