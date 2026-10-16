import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  initialAnchor,
}: {
  items: readonly T[];
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  scrollRef: RefObject<HTMLElement | null>;
  estimate?: number;
  overscan?: number;
  revealIndex?: number;
  initialAnchor?: { index: number; offset: number };
}) {
  const root = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const measurementAnchor = useRef<{ key: string; offset: number } | undefined>(
    undefined,
  );
  const [revision, measure] = useState(0);
  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const initialMeasurement = useRef(
    initialAnchor
      ? { key: keys[initialAnchor.index], offset: initialAnchor.offset }
      : undefined,
  );
  const offsets = useMemo(() => {
    const values = [0];
    for (const key of keys)
      values.push(values.at(-1)! + (heights.current.get(key) ?? estimate));
    return values;
  }, [keys, estimate, revision]);
  // Mount the saved row before the parent restores its exact DOM-relative offset.
  // Starting at zero would measure unrelated rows and lose the reading identity.
  const [viewport, setViewport] = useState(() => ({
    top: initialAnchor
      ? Math.max(0, (offsets[initialAnchor.index] ?? 0) - initialAnchor.offset)
      : 0,
    height: 800,
  }));
  // A parent's host ref attaches after child layout effects. Subscribe after
  // the full commit, then read the parent's already-restored scroll position.
  useEffect(() => {
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
    const interrupt = () => {
      initialMeasurement.current = undefined;
      measurementAnchor.current = undefined;
    };
    for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown'])
      scroller.addEventListener(event, interrupt, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    scroller.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener('scroll', update);
      for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown'])
        scroller.removeEventListener(event, interrupt);
    };
  }, [scrollRef]);
  useEffect(() => {
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
  useLayoutEffect(() => {
    const anchor = measurementAnchor.current;
    measurementAnchor.current = undefined;
    if (anchor) initialMeasurement.current = undefined;
    const box = scrollRef.current;
    if (!anchor || !box || !root.current) return;
    const row = [
      ...root.current.querySelectorAll<HTMLElement>('[data-windowed-key]'),
    ].find((row) => row.dataset.windowedKey === anchor.key);
    if (row)
      box.scrollTop +=
        row.getBoundingClientRect().top -
        box.getBoundingClientRect().top -
        anchor.offset;
  }, [revision, scrollRef]);
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
            rowKey={key}
            onHeight={(height) => {
              const previous = heights.current.get(key) ?? estimate;
              if (Math.abs(previous - height) < 1) return;
              // Keep the real visible row fixed across the next measured commit.
              // Summing estimated deltas before that commit can overshoot and emit
              // a scroll event that replaces the conversation's reading anchor.
              const box = scrollRef.current;
              if (initialMeasurement.current)
                measurementAnchor.current = initialMeasurement.current;
              if (!measurementAnchor.current && box && root.current) {
                const frame = box.getBoundingClientRect();
                const row = [
                  ...root.current.querySelectorAll<HTMLElement>(
                    '[data-windowed-key]',
                  ),
                ].find((row) => {
                  const rect = row.getBoundingClientRect();
                  return (
                    rect.height > 0 &&
                    rect.bottom > frame.top &&
                    rect.top < frame.bottom
                  );
                });
                if (row)
                  measurementAnchor.current = {
                    key: row.dataset.windowedKey!,
                    offset: row.getBoundingClientRect().top - frame.top,
                  };
              }
              heights.current.set(key, height);
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
  rowKey,
  children,
  onHeight,
}: {
  rowKey: string;
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
    <div ref={ref} data-windowed-key={rowKey} style={{ display: 'flow-root' }}>
      {children}
    </div>
  );
}
