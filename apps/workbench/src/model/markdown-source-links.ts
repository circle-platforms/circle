import { inlineSourceLocation } from './source-navigation';
type Node = { type: string; value?: string; url?: string; children?: Node[] };
/** Inline references use the existing link renderer. Fences and existing links
 * are left untouched, so a code-formatted link label never nests anchors. */
export function remarkSourceLinks() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      if (node.type === 'link' || node.type === 'linkReference') return;
      node.children = node.children?.flatMap((child): Node[] => {
        if (
          child.type === 'inlineCode' &&
          child.value &&
          inlineSourceLocation(child.value)
        )
          return [
            {
              type: 'link',
              url: child.value.trim().replace(/^\((.*)\)$/, '$1'),
              children: [child],
            },
          ];
        if (child.type === 'text' && child.value) {
          if (
            /^\s*(?:[$>]\s*|(?:node|npm|npx|pnpm|yarn|git|bun|deno|tsx|ts-node)\s+)/.test(
              child.value,
            )
          )
            return [child];
          const parts: Node[] = [];
          const reference =
            /(^|[\s(（])((?:(?:[A-Za-z]:)?[\\/]|\.{1,2}[\\/])?(?:[\p{L}\p{N}_@.-]+[\\/])+[\p{L}\p{N}_@.-]+\.[\p{L}\p{N}_-]+:\d+(?::\d+)?(?:[-–]\d+)?)(?=$|[\s),.;，）])/gu;
          let end = 0;
          for (const match of child.value.matchAll(reference)) {
            const start = match.index! + match[1]!.length;
            const target = match[2]!;
            if (!inlineSourceLocation(target)) continue;
            if (start > end)
              parts.push({
                type: 'text',
                value: child.value.slice(end, start),
              });
            parts.push({
              type: 'link',
              url: target,
              children: [{ type: 'text', value: target }],
            });
            end = start + target.length;
          }
          if (end) {
            if (end < child.value.length)
              parts.push({ type: 'text', value: child.value.slice(end) });
            return parts;
          }
        }
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}
