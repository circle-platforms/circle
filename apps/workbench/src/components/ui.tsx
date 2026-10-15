import { Search, ShieldAlert, X } from 'lucide-react';
import { Dialog, Tooltip } from 'radix-ui';
import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { t } from '../i18n';
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
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className="icon-button" aria-label={label} {...props}>
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
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
          className={`dialog-content ${wide ? 'wide' : ''}`}
          aria-describedby={description ? 'dialog-description' : undefined}
          onOpenAutoFocus={(event) => {
            // The close button is the first tab stop. Leaving focus there drops
            // keystrokes, and the composer behind the dialog receives them.
            event.preventDefault();
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
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Search size={25} />
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
export function DataBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="data-block">
      <h4>{title}</h4>
      <pre>
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
