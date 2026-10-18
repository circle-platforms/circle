import type { InputHTMLAttributes, ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileText, Search, X } from 'lucide-react';
import { Button, IconButton } from './ui';
import { t } from '../i18n';
export { Button, IconButton, Modal, Badge, DataBlock, EmptyState } from './ui';
export function Page({
  title,
  description,
  action,
  className = '',
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`page ${className}`.trim()}>
      <header className="page-heading">
        <div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
export function SearchInput({
  value,
  onChange,
  label = t('search'),
  placeholder = t('search…'),
  autoFocus = false,
  inputProps,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  // The dialog close button is the first tab stop, so this marks the field.
  autoFocus?: boolean;
  // keys, focus and the list it controls, for a search over a list of choices
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
}) {
  const focus = autoFocus || Boolean(inputProps?.autoFocus);
  return (
    <div className="search-field">
      <Search size={15} />
      <input
        {...inputProps}
        aria-label={label}
        value={value}
        placeholder={placeholder}
        autoFocus={focus}
        data-initial-focus={focus ? '' : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <IconButton
          type="button"
          label={t('clear search')}
          onClick={() => onChange('')}
        >
          <X size={13} />
        </IconButton>
      )}
    </div>
  );
}
export function Facts({
  values,
  notes = [],
}: {
  values: Record<string, ReactNode>;
  notes?: readonly string[];
}) {
  return (
    <dl className="facts">
      {Object.entries(values).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
      {notes.map((note) => (
        <div key={note} className="facts-note">
          <dd>{note}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input
        aria-label={label}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i />
    </label>
  );
}
export function Fold({
  title,
  open,
  onToggle,
  children,
}: {
  title: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fold">
      <button className="fold-title" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{title}</span>
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}
// The states records and cards show; a state not listed is shown as it is.
const STATES: Record<string, () => string> = {
  waiting: () => t('waiting'),
  running: () => t('running'),
  success: () => t('done'),
  completed: () => t('completed'),
  error: () => t('error'),
  failed: () => t('failed'),
  unknown: () => t('result unavailable'),
  queued: () => t('queued'),
  preparing: () => t('preparing workspace'),
  cancelling: () => t('stopping…'),
  stopping: () => t('stopping…'),
  succeeded: () => t('completed'),
  blocked: () => t('blocked'),
  interrupted: () => t('interrupted'),
  needs_review: () => t('needs review'),
  cancelled: () => t('cancelled'),
  rejected: () => t('rejected'),
  pending: () => t('pending'),
  recorded: () => t('answered'),
  idle: () => t('idle'),
  'not debugging': () => t('not debugging'),
  active: () => t('active'),
  trusted: () => t('trusted'),
  'not trusted': () => t('not trusted'),
  configured: () => t('configured'),
  'not configured': () => t('not configured'),
  connected: () => t('connected'),
  'not connected': () => t('not connected'),
  'reload required': () => t('reload required'),
  added: () => t('added'),
  modified: () => t('modified'),
  'native browser': () => t('native browser'),
  'not opened': () => t('not opened'),
  'signed in': () => t('signed in'),
  'signed out': () => t('signed out'),
};
export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value.replaceAll(' ', '-')}`}>
      <i />
      {STATES[value]?.() ?? value}
    </span>
  );
}
export function FileChip({
  name,
  onClick,
  onRemove,
}: {
  name: string;
  onClick?: () => void;
  onRemove?: () => void;
}) {
  return (
    <span className="file-chip">
      <button onClick={onClick}>
        <FileText size={12} />
        {name}
      </button>
      {onRemove && (
        <button aria-label={t('remove {name}', { name })} onClick={onRemove}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}
export function PreviewNotice() {
  return (
    <div className="preview-note">local preview · runtime not connected</div>
  );
}
export function RequestNotice() {
  return (
    <p className="muted small">
      Requests stay in this browser until a runtime is connected.
    </p>
  );
}
