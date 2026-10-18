export type FileTreeRow = {
  path: string;
  name: string;
  depth: number;
  folder: boolean;
  expanded: boolean;
  parentPath?: string;
  posInSet: number;
  setSize: number;
};
type Node = {
  path: string;
  name: string;
  folder: boolean;
  children: Map<string, Node>;
};
const names = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});
/** Flatten only visible folders; filtering exposes matching ancestors without mutating expansion. */
export function buildFileTreeRows(
  paths: readonly string[],
  expanded: ReadonlySet<string> | ((path: string) => boolean),
  query = '',
) {
  const root: Node = { path: '', name: '', folder: true, children: new Map() };
  const needle = query.trim().toLocaleLowerCase();
  let matchedCount = 0;
  for (const path of new Set(paths)) {
    if (needle && !path.toLocaleLowerCase().includes(needle)) continue;
    matchedCount++;
    let node = root;
    const parts = path.split('/');
    parts.forEach((name, index) => {
      const local = parts.slice(0, index + 1).join('/');
      let next = node.children.get(name);
      if (!next) {
        next = {
          path: local,
          name,
          folder: index < parts.length - 1,
          children: new Map(),
        };
        node.children.set(name, next);
      }
      node = next;
    });
  }
  const rows: FileTreeRow[] = [];
  const visit = (node: Node, depth: number) => {
    const children = [...node.children.values()].sort(
      (a, b) =>
        Number(b.folder) - Number(a.folder) || names.compare(a.name, b.name),
    );
    children.forEach((child, index) => {
      const open =
        child.folder &&
        (!!needle ||
          (typeof expanded === 'function'
            ? expanded(child.path)
            : expanded.has(child.path)));
      rows.push({
        path: child.path,
        name: child.name,
        depth,
        folder: child.folder,
        expanded: open,
        parentPath: node.path || undefined,
        posInSet: index + 1,
        setSize: children.length,
      });
      if (open) visit(child, depth + 1);
    });
  };
  visit(root, 0);
  return { rows, matchedCount };
}
export function treeWindow(
  count: number,
  top: number,
  height: number,
  rowHeight = 30,
  overscan = 6,
) {
  return {
    start: Math.max(0, Math.floor(top / rowHeight) - overscan),
    end: Math.min(count, Math.ceil((top + height) / rowHeight) + overscan),
  };
}
