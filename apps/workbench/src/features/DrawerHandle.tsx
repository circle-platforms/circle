import { useRef, useState } from 'react';
import { t } from '../i18n';

/**
 * The edge between the overview and the drawer beside it. The person drags it to
 * widen or narrow the drawer; the conversation gives or takes the room. With no
 * overview open, the drawer's own edge is the library's separator instead.
 */
export function DrawerHandle({
  width,
  min,
  max,
  onResize,
}: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
}) {
  const [active, setActive] = useState(false);
  const start = useRef({ x: 0, width: 0 });
  const clamp = (value: number) =>
    Math.round(Math.max(min, Math.min(Math.max(min, max), value)));
  return (
    <div
      className="resize-handle cluster-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('resize inspector')}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, max)}
      aria-valuenow={width}
      tabIndex={0}
      data-separator={active ? 'active' : 'inactive'}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width };
        setActive(true);
      }}
      onPointerMove={(event) => {
        if (!active) return;
        const next = clamp(
          start.current.width + start.current.x - event.clientX,
        );
        if (next !== width) onResize(next);
      }}
      onPointerUp={() => setActive(false)}
      onPointerCancel={() => setActive(false)}
      onLostPointerCapture={() => setActive(false)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        // The drawer is on the right, so an arrow towards the conversation widens it.
        if (event.key === 'ArrowLeft') onResize(clamp(width + step));
        else if (event.key === 'ArrowRight') onResize(clamp(width - step));
        else if (event.key === 'Home') onResize(clamp(min));
        else if (event.key === 'End') onResize(clamp(max));
        else return;
        event.preventDefault();
      }}
    />
  );
}
