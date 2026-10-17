import { X } from 'lucide-react';
import { Button, IconButton } from './common';
import { t } from '../i18n';

/**
 * A source as people read it: relative to the workspace when it is inside it, otherwise its
 * file name. A web address keeps the last part of its path. The full value goes in the tooltip.
 */
export function shortSource(path: string, root?: string): string {
  if (!path) return path;
  if (root) {
    const base = root.replace(/[\\/]+$/, '');
    for (const separator of ['/', '\\'])
      if (path.startsWith(base + separator)) return path.slice(base.length + 1);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path))
    try {
      const url = new URL(path);
      return url.pathname.split('/').filter(Boolean).at(-1) ?? url.host;
    } catch {
      return path;
    }
  if (path.startsWith('<')) return path;
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
/** Frames from the runtime itself, which people rarely want to step through. */
export function internalFrame(path: string): boolean {
  return /^<node_internals>|^node:|^internal\//.test(path);
}
export function DebugSourceLabel({
  name,
  path,
  line,
  root,
}: {
  name?: string;
  path: string;
  line: number;
  root?: string;
}) {
  return (
    <span
      className="debug-source-label"
      title={path ? `${path}:${line}` : undefined}
    >
      {name && (
        <>
          <strong>{name}</strong>{' '}
        </>
      )}
      <small>
        {shortSource(path, root)}:{line}
      </small>
    </span>
  );
}
export function DebugBreakpointRow({
  path,
  line,
  verified,
  root,
  onOpen,
  onRemove,
}: {
  path: string;
  line: number;
  verified: boolean;
  root?: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="debug-breakpoint" data-verified={verified}>
      <i className="debug-breakpoint-dot" aria-hidden="true" />
      <button
        type="button"
        className="debug-breakpoint-open"
        title={`${path}:${line}`}
        onClick={onOpen}
      >
        {shortSource(path, root)}:{line}
      </button>
      {!verified && <small>{t('inactive')}</small>}
      <IconButton label={t('remove breakpoint')} onClick={onRemove}>
        <X size={13} aria-hidden="true" />
      </IconButton>
    </div>
  );
}
export function DebugVariableRow({
  name,
  value,
  onExpand,
}: {
  name: string;
  value: string;
  onExpand?: () => void;
}) {
  return (
    <div className="debug-variable-row">
      <Button aria-label={name} disabled={!onExpand} onClick={onExpand}>
        <code>
          {name}: {value}
        </code>
      </Button>
    </div>
  );
}
