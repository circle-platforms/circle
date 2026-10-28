import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { treeWindow, type FileTreeRow } from '../model/virtual-file-tree';
import { useOwnerState } from '../model/owner-state';
import './virtual-file-tree.css';
const ROW_HEIGHT = 30;
/** One keyboard focus target and bounded row DOM, even for an expanded large repository. */
export function VirtualFileTree({
  rows,
  selectedPath,
  ownerKey,
  filterKey = '',
  ariaLabel,
  onSelect,
  onToggle,
  renderLeading,
  renderIcon,
  renderTrailing,
  renderLabel,
  rowClassName,
}: {
  rows: readonly FileTreeRow[];
  selectedPath?: string;
  ownerKey: string;
  filterKey?: string;
  ariaLabel: string;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  renderLeading?: (row: FileTreeRow) => ReactNode;
  renderIcon?: (row: FileTreeRow) => ReactNode;
  renderTrailing?: (row: FileTreeRow) => ReactNode;
  renderLabel?: (row: FileTreeRow) => ReactNode;
  rowClassName?: (row: FileTreeRow) => string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const [activePath, setActivePath] = useOwnerState(ownerKey, '');
  const positions = useMemo(
    () => new Map(rows.map((row, index) => [row.path, index])),
    [rows],
  );
  const activeIndex =
    positions.get(activePath) ?? positions.get(selectedPath ?? '') ?? 0;
  const [viewport, setViewport] = useState({ top: 0, height: 300 });
  const scrollPositions = useRef(new Map<string, number>());
  const revealReceipt = useRef(new Map<string, string>());
  const ensureVisible = (index: number) => {
    const element = root.current;
    if (!element) return;
    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = Math.max(0, top + ROW_HEIGHT - element.clientHeight);
    setViewport({
      top: element.scrollTop,
      height: element.clientHeight || 300,
    });
  };
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    element.scrollTop =
      scrollPositions.current.get(ownerKey + ':' + filterKey) ?? 0;
    setViewport({
      top: element.scrollTop,
      height: element.clientHeight || 300,
    });
  }, [ownerKey, filterKey]);
  useLayoutEffect(() => {
    const receipt = JSON.stringify([ownerKey, selectedPath, filterKey]);
    if (receipt === revealReceipt.current.get(ownerKey)) return;
    const target = positions.get(selectedPath ?? '');
    if (target === undefined) {
      if (!selectedPath) revealReceipt.current.set(ownerKey, receipt);
      if (rows.length) setActivePath(rows[0].path);
      return;
    }
    revealReceipt.current.set(ownerKey, receipt);
    setActivePath(rows[target].path);
    ensureVisible(target);
  }, [ownerKey, selectedPath, filterKey, positions]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport({
        top: element.scrollTop,
        height: element.clientHeight || 300,
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const range = treeWindow(rows.length, viewport.top, viewport.height);
  const visible = new Set(
    Array.from(
      { length: Math.max(0, range.end - range.start) },
      (_, index) => range.start + index,
    ),
  );
  if (rows.length) visible.add(activeIndex);
  const move = (index: number) => {
    index = Math.max(0, Math.min(rows.length - 1, index));
    if (!rows[index]) return;
    setActivePath(rows[index].path);
    ensureVisible(index);
  };
  return (
    <div
      className="virtual-file-tree"
      ref={root}
      role="tree"
      aria-label={ariaLabel}
      tabIndex={0}
      aria-activedescendant={
        rows[activeIndex] ? `${prefix}-${activeIndex}` : undefined
      }
      onScroll={(event) => {
        const element = event.currentTarget;
        scrollPositions.current.set(
          ownerKey + ':' + filterKey,
          element.scrollTop,
        );
        setViewport({ top: element.scrollTop, height: element.clientHeight });
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !rows.length) return;
        const row = rows[activeIndex];
        if (event.key === 'ArrowDown') move(activeIndex + 1);
        else if (event.key === 'ArrowUp') move(activeIndex - 1);
        else if (event.key === 'Home') move(0);
        else if (event.key === 'End') move(rows.length - 1);
        else if (event.key === 'PageDown')
          move(
            activeIndex + Math.max(1, Math.floor(viewport.height / ROW_HEIGHT)),
          );
        else if (event.key === 'PageUp')
          move(
            activeIndex - Math.max(1, Math.floor(viewport.height / ROW_HEIGHT)),
          );
        else if (event.key === 'ArrowRight') {
          if (row.folder && !row.expanded) onToggle(row.path);
          else if (row.folder && rows[activeIndex + 1]?.parentPath === row.path)
            move(activeIndex + 1);
        } else if (event.key === 'ArrowLeft') {
          if (row.folder && row.expanded) onToggle(row.path);
          else if (row.parentPath)
            move(positions.get(row.parentPath) ?? activeIndex);
        } else if (event.key === 'Enter' || event.key === ' ') {
          if (row.folder) onToggle(row.path);
          else onSelect(row.path);
        } else if (
          event.key.length === 1 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          const next = [
            ...rows.slice(activeIndex + 1),
            ...rows.slice(0, activeIndex + 1),
          ].find((item) =>
            item.name
              .toLocaleLowerCase()
              .startsWith(event.key.toLocaleLowerCase()),
          );
          if (next) move(positions.get(next.path)!);
        } else return;
        event.preventDefault();
      }}
    >
      <div
        className="virtual-file-tree-space"
        role="none"
        style={{ height: rows.length * ROW_HEIGHT }}
      >
        {[...visible]
          .sort((a, b) => a - b)
          .map((index) => {
            const row = rows[index];
            return (
              <div
                key={row.path}
                id={`${prefix}-${index}`}
                role="treeitem"
                data-path={row.path}
                className={`virtual-file-tree-row ${row.folder ? 'tree-folder' : 'tree-file'} ${row.path === selectedPath ? 'active' : ''} ${index === activeIndex ? 'tree-focused' : ''} ${rowClassName?.(row) ?? ''}`}
                title={row.path}
                aria-label={row.path}
                aria-level={row.depth + 1}
                aria-posinset={row.posInSet}
                aria-setsize={row.setSize}
                aria-selected={!row.folder && row.path === selectedPath}
                aria-expanded={row.folder ? row.expanded : undefined}
                style={{
                  top: index * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                  paddingInlineStart: 10 + row.depth * 14,
                }}
                onClick={() => {
                  root.current?.focus({ preventScroll: true });
                  setActivePath(row.path);
                  if (row.folder) onToggle(row.path);
                  else onSelect(row.path);
                }}
              >
                {renderLeading?.(row)}
                {row.folder ? (
                  row.expanded ? (
                    <ChevronDown size={13} aria-hidden />
                  ) : (
                    <ChevronRight size={13} aria-hidden />
                  )
                ) : (
                  (renderIcon?.(row) ?? <FileText size={14} aria-hidden />)
                )}
                <span className="virtual-file-tree-label">
                  {renderLabel?.(row) ?? row.name}
                </span>
                {renderTrailing?.(row)}
              </div>
            );
          })}
      </div>
    </div>
  );
}
