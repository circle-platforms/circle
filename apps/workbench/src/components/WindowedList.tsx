import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

/** Return the visible interval in a monotone cumulative-height table. */
export function windowedRange(
  offsets: readonly number[],
  top: number,
  height: number,
  overscan = 800,
) {
  const find = (target: number) => {
    let lo = 0,
      hi = Math.max(0, offsets.length - 1);
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (offsets[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return {
    start: find(Math.max(0, top - overscan)),
    end: Math.min(offsets.length - 1, find(top + height + overscan) + 1),
  };
}

/** Uses the existing transcript scroller; no nested scroll container. Callers own
 * durable row state. Stable keys and measured heights survive row remounts.
 * Set revealIndex for search/navigation before asking a child to focus itself.
 */
export function WindowedList<T>({
  items,
  itemKey,
  renderItem,
  scrollRef,
  estimate = 180,
  overscan = 800,
  revealIndex,
}: {
  items: readonly T[];
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  scrollRef: RefObject<HTMLElement | null>;
  estimate?: number;
  overscan?: number;
  revealIndex?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [revision, measure] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const offsets = useMemo(() => {
    const values = [0];
    for (const key of keys)
      values.push(values.at(-1)! + (heights.current.get(key) ?? estimate));
    return values;
  }, [keys, estimate, revision]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current,
      element = root.current;
    if (!scroller || !element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setViewport({
          top:
            scroller.scrollTop -
            (element.getBoundingClientRect().top -
              scroller.getBoundingClientRect().top +
              scroller.scrollTop),
          height: scroller.clientHeight,
        }),
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    scroller.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener('scroll', update);
    };
  }, [scrollRef]);
  useLayoutEffect(() => {
    if (
      revealIndex === undefined ||
      !scrollRef.current ||
      !root.current ||
      !items.length
    )
      return;
    const index = Math.max(0, Math.min(items.length - 1, revealIndex));
    const scroller = scrollRef.current;
    const rootTop =
      root.current.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    scroller.scrollTop = rootTop + offsets[index];
    setViewport({ top: offsets[index], height: scroller.clientHeight });
  }, [revealIndex, items.length, scrollRef]);
  useLayoutEffect(() => {
    const valid = new Set(keys);
    for (const key of heights.current.keys())
      if (!valid.has(key)) heights.current.delete(key);
  }, [keys]);
  const range = windowedRange(offsets, viewport.top, viewport.height, overscan);
  return (
    <div ref={root} data-windowed-count={items.length}>
      <div aria-hidden="true" style={{ height: offsets[range.start] ?? 0 }} />
      {items.slice(range.start, range.end).map((item, relative) => {
        const index = range.start + relative,
          key = keys[index];
        return (
          <MeasuredRow
            key={key}
            onHeight={(height) => {
              const previous = heights.current.get(key) ?? estimate;
              if (Math.abs(previous - height) < 1) return;
              heights.current.set(key, height);
              // Changes above the visible anchor must not move the text being read.
              if (offsets[index + 1] < viewport.top && scrollRef.current)
                scrollRef.current.scrollTop += height - previous;
              measure((value) => value + 1);
            }}
          >
            {renderItem(item, index)}
          </MeasuredRow>
        );
      })}
      <div
        aria-hidden="true"
        style={{
          height: Math.max(
            0,
            (offsets.at(-1) ?? 0) - (offsets[range.end] ?? 0),
          ),
        }}
      />
    </div>
  );
}

function MeasuredRow({
  children,
  onHeight,
}: {
  children: ReactNode;
  onHeight: (height: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onHeight);
  callback.current = onHeight;
  useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) =>
      callback.current(
        entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height,
      ),
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ display: 'flow-root' }}>
      {children}
    </div>
  );
}
