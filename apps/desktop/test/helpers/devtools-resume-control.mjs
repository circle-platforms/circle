/** Runs only inside the actual owned DevTools frontend, never in the debugged page. */
export function clickReadyDevToolsResume() {
  const roots = [document];
  const labels = [];
  for (let index = 0; index < roots.length; index++) {
    for (const node of roots[index].querySelectorAll('*')) {
      if (node.shadowRoot) roots.push(node.shadowRoot);
      const label =
        node.getAttribute('aria-label') ?? node.getAttribute('title') ?? '';
      if (!/^(Resume|Pause) script execution\b/.test(label)) continue;
      const rect = node.getBoundingClientRect();
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        getComputedStyle(node).visibility !== 'hidden';
      const enabled =
        !node.disabled && node.getAttribute('aria-disabled') !== 'true';
      labels.push({ label, visible, enabled });
      if (/^Resume script execution\b/.test(label) && visible && enabled) {
        node.click();
        return { clicked: true, label, readyState: document.readyState };
      }
    }
  }
  return { clicked: false, labels, readyState: document.readyState };
}
