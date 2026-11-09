import {
  Check,
  Copy,
  Search,
  ShieldAlert,
  SquareTerminal,
  X,
} from 'lucide-react';
import { Dialog, Tooltip } from 'radix-ui';
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentType,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { runControlAction } from '../model/session-row';
import { focusDialogField, focusMarkedField } from '../model/dialog-focus';
import { t } from '../i18n';
import { useNotify } from '../app/context';
import { copyText } from '../host';
/** Handlers for a button that acts as soon as it is pressed and must not act
 * again on that press's click. A press whose click never comes, because the
 * pointer left before the release or the press was cancelled, must not swallow
 * the next activation, and keyboard activation (`detail` 0) is its own action. */
export function usePressAction(action: () => void) {
  const actedOnPress = useRef(false);
  return {
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (
        !runControlAction({
          kind: 'press',
          button: event.button,
          actedOnPress: false,
        })
      )
        return;
      actedOnPress.current = true;
      action();
    },
    onPointerCancel: () => {
      actedOnPress.current = false;
    },
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      const again =
        event.detail === 0 ||
        runControlAction({
          kind: 'click',
          button: 0,
          actedOnPress: actedOnPress.current,
        });
      actedOnPress.current = false;
      if (again) action();
    },
  };
}

export function Button({
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <button className={`button ${className}`} {...props}>
      {children}
    </button>
  );
}
export function IconButton({
  label,
  tipOpen,
  children,
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  /** Set to force the tip open or closed. Omit it to follow hover and focus. */
  tipOpen?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const [hovered, setHovered] = useState(false);
  const actedOnPress = useRef(false);
  useEffect(() => {
    if (tipOpen === false) setHovered(false);
  }, [tipOpen]);
  // `tipOpen` forces the tip. Otherwise hover and focus decide, including after a
  // forced close, so the same button can show a tip again.
  const shown = tipOpen === true ? true : tipOpen === false ? false : hovered;
  return (
    <Tooltip.Root
      open={shown}
      onOpenChange={(next) => {
        if (tipOpen === undefined) setHovered(next);
      }}
    >
      <Tooltip.Trigger asChild>
        <button
          ref={ref}
          className="icon-button"
          aria-label={label}
          {...props}
          onPointerDown={(event) => {
            // A press can hide this still-mounted button before its click arrives.
            // A later press is a new action, even when the old click never came.
            if (event.button === 0) actedOnPress.current = false;
            props.onPointerDown?.(event);
            if (!shown) return;
            if (
              !runControlAction({
                kind: 'press',
                button: event.button,
                actedOnPress: false,
              })
            )
              return;
            actedOnPress.current = true;
            props.onClick?.(event as unknown as MouseEvent<HTMLButtonElement>);
          }}
          onPointerCancel={(event) => {
            actedOnPress.current = false;
            props.onPointerCancel?.(event);
          }}
          onClick={(event) => {
            const again =
              event.detail === 0 ||
              runControlAction({
                kind: 'click',
                button: 0,
                actedOnPress: actedOnPress.current,
              });
            actedOnPress.current = false;
            if (again) props.onClick?.(event);
          }}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={7}>
          {label}
          <Tooltip.Arrow />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  className = '',
  restoreFocus = false,
  dismissOutside = true,
  onCloseAutoFocus,
  onEscapeKeyDown,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  /** Restore the focused control when this dialog closes, even outside another dialog. */
  restoreFocus?: boolean;
  dismissOutside?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
  /** Called before `esc` closes the dialog; `preventDefault` keeps it open. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const interactedField = useRef<HTMLElement | null>(null);
  const rememberField = (target: EventTarget | null) => {
    if (
      target instanceof HTMLElement &&
      target.matches('input, textarea, select, [contenteditable="true"]')
    )
      interactedField.current = target;
  };

  // A nested dialog, or one that opts in, returns the keyboard to its opener.
  const opener = useRef<HTMLElement | null>(null);
  // An autofocus field can take focus during mounting, before Radix reports that the
  // dialog opened. Remember the last outside focus while the dialog is closed.
  const lastOutsideFocus = useRef<HTMLElement | null>(null);
  // A temporary search dialog can open this one and then disappear. Keep the last
  // control in the window as a fallback when that dialog's opener is gone.
  const lastWindowFocus = useRef<HTMLElement | null>(null);
  const openNow = useRef(open);
  openNow.current = open;
  useEffect(() => {
    if (!restoreFocus) return;
    const remember = (target: EventTarget | null) => {
      if (
        !openNow.current &&
        target instanceof HTMLElement &&
        target !== document.body &&
        !content.current?.contains(target)
      ) {
        lastOutsideFocus.current = target;
        if (!target.closest('[role="dialog"]'))
          lastWindowFocus.current = target;
      }
    };
    const onFocus = (event: FocusEvent) => remember(event.target);
    remember(document.activeElement);
    document.addEventListener('focusin', onFocus, true);
    return () => document.removeEventListener('focusin', onFocus, true);
  }, [restoreFocus]);
  useEffect(() => {
    if (!open) {
      interactedField.current = null;
      return;
    }
    // A menu that opened the dialog restores its trigger in a timeout. A nested
    // timeout runs after that, so the field keeps the focus and the keystrokes.
    let nested = 0;
    const timer = window.setTimeout(() => {
      nested = window.setTimeout(() => {
        if (content.current)
          focusDialogField(content.current, interactedField.current);
      }, 0);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(nested);
    };
  }, [open, title]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          ref={content}
          onPointerDownOutside={(event) => {
            if (!dismissOutside) event.preventDefault();
          }}
          className={`dialog-content ${wide ? 'wide' : ''} ${className}`}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) {
              opener.current = null;
              return;
            }
            // React's autofocus can skip Radix's open event entirely.
            const original =
              opener.current ??
              (restoreFocus ? lastOutsideFocus.current : null);
            opener.current = null;
            const target = original?.isConnected
              ? original
              : restoreFocus
                ? lastWindowFocus.current
                : null;
            // A dialog that was already open can still be underneath this one even
            // when it had not yet focused a control when the settings menu was used.
            // Keep the keyboard in that dialog rather than trying to focus the
            // now-inert window behind it.
            const underneath = restoreFocus
              ? [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
                  .filter((dialog) => dialog !== content.current)
                  .at(-1)
              : undefined;
            if (
              underneath &&
              (!target?.isConnected || !underneath.contains(target))
            ) {
              event.preventDefault();
              if (!underneath.contains(document.activeElement))
                underneath.focus({ preventScroll: true });
              return;
            }
            if (!target?.isConnected) return;
            // Return the keyboard to the control that opened this dialog.
            event.preventDefault();
            target.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={onEscapeKeyDown}
          aria-describedby={description ? 'dialog-description' : undefined}
          onOpenAutoFocus={(event) => {
            const active = document.activeElement;
            if (
              active instanceof HTMLElement &&
              active !== document.body &&
              !content.current?.contains(active) &&
              (restoreFocus || active.closest('[role="dialog"]'))
            )
              opener.current = active;
            else
              opener.current = restoreFocus ? lastOutsideFocus.current : null;
            // The close button is the first tab stop. Leaving focus there drops
            // keystrokes, and the composer behind the dialog receives them.
            event.preventDefault();
            if (event.currentTarget instanceof Element)
              focusMarkedField(event.currentTarget, event);
          }}
          onInputCapture={(event) => rememberField(event.target)}
          onPointerDownCapture={(event) => rememberField(event.target)}
          onKeyDownCapture={(event) => rememberField(event.target)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') event.stopPropagation();
          }}
        >
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description id="dialog-description">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button className="icon-button" aria-label={t('close dialog')}>
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'blue';
}) {
  return (
    <span className={`badge ${tone}`}>
      <span />
      {children}
    </span>
  );
}
/**
 * What a drawer mode shows while it has nothing yet: its icon and one line in the middle,
 * as the browser shows before a page is opened, so every mode starts the same way.
 */
export function PaneEmpty({
  icon: Icon,
  title,
  className,
  children,
}: {
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  title?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`pane-empty${className ? ` ${className}` : ''}`}
      role="status"
    >
      <Icon size={22} strokeWidth={1.5} />
      {title && <h3>{title}</h3>}
      {children}
    </div>
  );
}
export function EmptyState({
  title,
  children,
  icon,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ?? <Search size={25} />}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
export function PermissionState() {
  return (
    <div className="permission-state">
      <ShieldAlert size={28} />
      <h2>{t('permission required')}</h2>
      <p>{t('This view requires access from a connected runtime.')}</p>
    </div>
  );
}
/**
 * The one copy button: the same icon everywhere, a check for a moment once the text is
 * copied, and the notice line where a runtime shows one. A copy button sits on the text it
 * copies (CopyableText), or at the right end of a row's head when that text is folded.
 */
export function CopyButton({
  text,
  label = t('copy'),
  size = 13,
}: {
  text: string | (() => string);
  label?: string;
  size?: number;
}) {
  const notify = useNotify();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <IconButton
      className="icon-button copy-button"
      label={label}
      onClick={() =>
        copyText(typeof text === 'function' ? text() : text).then(
          () => {
            notify?.(t('copied'));
            setDone(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setDone(false), 1200);
          },
          () => notify?.(t('clipboard unavailable')),
        )
      }
    >
      {done ? <Check size={size} /> : <Copy size={size} />}
    </IconButton>
  );
}

/** Text that copies itself: its copy button in its top right corner, the text clear of it. */
export function CopyableText({
  text,
  copy,
  label,
  className,
  tabIndex,
  wrap,
}: {
  text: string;
  /** What the button copies when it is not the text shown, such as a command without its `$`. */
  copy?: string;
  label?: string;
  className?: string;
  tabIndex?: number;
  wrap?: boolean;
}) {
  return (
    <div className="copyable">
      <pre
        className={className}
        tabIndex={tabIndex}
        style={wrap === false ? { whiteSpace: 'pre' } : undefined}
      >
        {text}
      </pre>
      <CopyButton text={copy ?? text} label={label} />
    </div>
  );
}

/**
 * A one-time code a person types on another site, as the GitHub and Hub cards show one:
 * the words that say where, the code, and its copy button beside it.
 */
export function DeviceCode({ prompt, code }: { prompt: string; code: string }) {
  return (
    <div className="device-code">
      <p>{prompt}</p>
      <span className="device-code-row">
        <code>{code}</code>
        <CopyButton text={code} label={t('copy code')} />
      </span>
    </div>
  );
}

/** A row's actions: icons at the right end of its head, never a row of buttons of their own. */
export function RowActions({ children }: { children: ReactNode }) {
  return <span className="row-actions">{children}</span>;
}

/**
 * A file named where it is shown, opened by its own name: a call's path, an approval's
 * target, a change, a plan. Nothing beside it opens it. Its name is what it shows, the
 * whole path its title.
 */
export function PathLink({
  path,
  onOpen,
  className,
  children,
}: {
  path: string;
  onOpen: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className ? `path-link ${className}` : 'path-link'}
      title={path}
      onClick={(event) => {
        // A row that opens or folds on a click leaves this one to the link
        event.stopPropagation();
        onOpen();
      }}
    >
      {children ?? path}
    </button>
  );
}

/**
 * Opens a command in a terminal tab, from a tool call or a background job: busy while it
 * opens, and what went wrong handed to the row, which says it under itself.
 */
export function OpenInTerminalButton({
  open,
  onError,
}: {
  open: (trigger: HTMLElement) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <IconButton
      label={t('open in terminal')}
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={async (event) => {
        const trigger = event.currentTarget;
        setBusy(true);
        onError('');
        try {
          await open(trigger);
        } catch (failure) {
          onError(
            failure instanceof Error
              ? failure.message
              : t('command terminal could not be opened; try again'),
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <SquareTerminal size={13} />
    </IconButton>
  );
}

/** A titled block of text that copies itself, as tool calls, approvals and pages show one. */
export function DataBlock({
  title,
  value,
  tabIndex,
  wrap,
  copy,
  copyLabel,
}: {
  title: string;
  value: unknown;
  tabIndex?: number;
  wrap?: boolean;
  /** What the button copies when it is not the text shown. */
  copy?: string;
  /** The button's name; `copy` when not given. */
  copyLabel?: string;
}) {
  return (
    <div className="data-block">
      <h4>{title}</h4>
      <CopyableText
        text={
          typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        }
        copy={copy}
        label={copyLabel}
        tabIndex={tabIndex}
        wrap={wrap}
      />
    </div>
  );
}
