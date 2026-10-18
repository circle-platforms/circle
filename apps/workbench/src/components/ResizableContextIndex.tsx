import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { t } from '../i18n';
import './resizable-context-index.css';

const STORAGE_KEY = 'circle.workbench.context-index-widths.v1';
const widths = new Map<string, number>();
const preferenceKey = (owner: string, resource: string) =>
  JSON.stringify([owner, resource]);
function readWidth(key: string, fallback: number) {
  if (widths.has(key)) return widths.get(key)!;
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '{}',
    );
    if (saved && typeof saved === 'object') {
      const value = (saved as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        return value;
    }
  } catch {
    /* A denied storage area must not block the resource. */
  }
  return fallback;
}
function rememberWidth(key: string, width: number) {
  widths.delete(key);
  widths.set(key, width);
  while (widths.size > 128) widths.delete(widths.keys().next().value!);
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '{}',
    );
    const entries =
      saved && typeof saved === 'object' && !Array.isArray(saved)
        ? Object.entries(saved)
        : [];
    const next = new Map(
      entries.filter(
        ([name, value]) =>
          name !== key && typeof value === 'number' && Number.isFinite(value),
      ),
    );
    next.set(key, width);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries([...next].slice(-128))),
    );
  } catch {
    /* The mounted owner's in-memory preference remains available. */
  }
}
const clamp = (width: number, min: number, max: number) =>
  Math.min(max, Math.max(min, width));

/** Right-side resource index. Its separator never resizes the containing work drawer. */
export function ResizableContextIndex({
  ownerKey,
  resourceKey,
  open,
  children,
  className = '',
  defaultWidth = 240,
  minWidth = 180,
  maxWidth = 420,
  label = t('resize context index'),
}: {
  ownerKey: string;
  resourceKey: string;
  open: boolean;
  children: ReactNode;
  className?: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  label?: string;
}) {
  const key = preferenceKey(ownerKey, resourceKey);
  const [preference, setPreference] = useState(() => ({
    key,
    width: readWidth(key, defaultWidth),
  }));
  const preferred =
    preference.key === key ? preference.width : readWidth(key, defaultWidth);
  const box = useRef<HTMLElement>(null);
  const [available, setAvailable] = useState(0);
  const narrow = available > 0 && available < 620;
  const limit =
    available > 0 ? (narrow ? available - 32 : available - 240) : maxWidth;
  const max = Math.max(1, Math.min(maxWidth, limit));
  const min = Math.min(minWidth, max);
  const width = clamp(preferred, min, max);
  const drag = useRef<
    | {
        pointer: number;
        x: number;
        start: number;
        key: string;
        handle: HTMLElement;
        restore: () => void;
      }
    | undefined
  >(undefined);
  const current = useRef({ key, min, max, width });
  current.current = { key, min, max, width };
  const finish = (commit: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = undefined;
    active.restore();
    if (commit && active.key === current.current.key)
      rememberWidth(active.key, current.current.width);
    else setPreference({ key: active.key, width: active.start });
    if (active.handle.hasPointerCapture(active.pointer))
      active.handle.releasePointerCapture(active.pointer);
  };
  useLayoutEffect(() => {
    const parent = box.current?.parentElement;
    if (!parent) return;
    const update = () => setAvailable(parent.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open) finish(false);
  }, [open]);
  useEffect(
    () => () => {
      const active = drag.current;
      if (!active) return;
      drag.current = undefined;
      active.restore();
      if (active.key !== current.current.key)
        setPreference({ key: active.key, width: active.start });
      if (active.handle.hasPointerCapture(active.pointer))
        active.handle.releasePointerCapture(active.pointer);
    },
    [key],
  );
  const resize = (value: number, persist = true) => {
    const next = clamp(value, min, max);
    setPreference({ key, width: next });
    current.current = { key, min, max, width: next };
    if (persist) rememberWidth(key, next);
  };
  return (
    <aside
      ref={box}
      hidden={!open}
      className={`resizable-context-index ${className}`}
      data-context-index-resource={resourceKey}
      data-context-index-owner={ownerKey}
      data-index-overlay={narrow ? '' : undefined}
      style={{ width, flexBasis: width }}
    >
      <div
        role="separator"
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemin={Math.round(min)}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(width)}
        tabIndex={open ? 0 : -1}
        className="context-index-resizer"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            return;
          event.preventDefault();
          event.stopPropagation();
          const step = event.shiftKey ? 48 : 16;
          resize(
            event.key === 'Home'
              ? min
              : event.key === 'End'
                ? max
                : width + (event.key === 'ArrowLeft' ? step : -step),
          );
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary || drag.current) return;
          event.preventDefault();
          event.stopPropagation();
          const handle = event.currentTarget;
          handle.focus({ preventScroll: true });
          const previousSelect = document.body.style.userSelect,
            previousCursor = document.body.style.cursor;
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'col-resize';
          drag.current = {
            pointer: event.pointerId,
            x: event.clientX,
            start: width,
            key,
            handle,
            restore: () => {
              document.body.style.userSelect = previousSelect;
              document.body.style.cursor = previousCursor;
            },
          };
          handle.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (active?.pointer === event.pointerId && active.key === key)
            resize(active.start + active.x - event.clientX, false);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointer === event.pointerId) finish(true);
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointer === event.pointerId) finish(false);
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointer === event.pointerId) finish(false);
        }}
      />
      <div className="context-index-content">{children}</div>
    </aside>
  );
}
