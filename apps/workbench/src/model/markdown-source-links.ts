import { inlineSourceLocation } from './source-navigation';
type Node = { type: string; value?: string; url?: string; children?: Node[] };
/** Inline references use the existing link renderer. Fences and existing links
 * are left untouched, so a code-formatted link label never nests anchors. */
export function remarkSourceLinks() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      if (node.type === 'link' || node.type === 'linkReference') return;
      node.children = node.children?.map((child) => {
        if (
          child.type === 'inlineCode' &&
          child.value &&
          inlineSourceLocation(child.value)
        )
          return {
            type: 'link',
            url: child.value.trim().replace(/^\((.*)\)$/, '$1'),
            children: [child],
          };
        walk(child);
        return child;
      });
    };
    walk(tree);
  };
}
