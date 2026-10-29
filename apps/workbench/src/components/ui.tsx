import { Search, ShieldAlert, X } from 'lucide-react';
import { Dialog, Tooltip } from 'radix-ui';
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { runControlAction } from '../model/session-row';
import { focusMarkedField } from '../model/dialog-focus';
import { t } from '../i18n';
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
function placeFocus(node: HTMLElement) {
  node.focus({ focusVisible: true });
}
function focusDialogField(content: HTMLElement) {
  // A dialog can name the field that starts with the keyboard (search).
  const marked = content.querySelector('[data-initial-focus]');
  if (marked instanceof HTMLElement) {
    placeFocus(marked);
    return;
  }
  const field = content.querySelector(
    'input:not([type="hidden"]), textarea, select',
  );
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement
  ) {
    placeFocus(field);
    // A rename box should start with the current name selected.
    if (field instanceof HTMLInputElement) field.select();
    return;
  }
  if (field instanceof HTMLSelectElement) {
    placeFocus(field);
    return;
  }
  const primary = content.querySelector('button.primary');
  if (primary instanceof HTMLButtonElement && !primary.disabled) {
    placeFocus(primary);
    return;
  }
  const button = [...content.querySelectorAll('button')].find(
    (item) =>
      item instanceof HTMLButtonElement &&
      !item.disabled &&
      item.getAttribute('aria-label') !== 'close dialog',
  );
  if (button instanceof HTMLButtonElement) placeFocus(button);
  else content.focus();
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
  onCloseAutoFocus?: (event: Event) => void;
  /** Called before `esc` closes the dialog; `preventDefault` keeps it open. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
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
    if (!open) return;
    // A menu that opened the dialog restores its trigger in a timeout. A nested
    // timeout runs after that, so the field keeps the focus and the keystrokes.
    let nested = 0;
    const timer = window.setTimeout(() => {
      nested = window.setTimeout(() => {
        if (content.current) focusDialogField(content.current);
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
export function DataBlock({
  title,
  value,
  tabIndex,
  wrap,
}: {
  title: string;
  value: unknown;
  tabIndex?: number;
  wrap?: boolean;
}) {
  return (
    <div className="data-block">
      <h4>{title}</h4>
      <pre
        tabIndex={tabIndex}
        style={wrap === false ? { whiteSpace: 'pre' } : undefined}
      >
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
