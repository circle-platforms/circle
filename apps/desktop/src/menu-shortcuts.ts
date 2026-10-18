/** Keep Linux's standard editor format key (Ctrl+Shift+I) in the renderer.
 * Electron 44's toggleDevTools role otherwise registers that same accelerator. */
export function devToolsMenuShortcut(platform: NodeJS.Platform): {
  accelerator?: string;
} {
  return platform === 'linux' ? { accelerator: 'Control+Alt+Shift+I' } : {};
}

type SelectAllTarget = {
  webContents?: {
    isDestroyed(): boolean;
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  };
};

/**
 * Select the focused field, or the page when focus is elsewhere.
 * Electron's `selectAll` role registers CmdOrCtrl+A. On macOS that menu
 * handles the chord before the page, and `webContents.selectAll()` does not
 * select a workbench input. The menu item stays; the chord does not.
 */
export function selectFocusedEditableScript(): string {
  return `(() => {
    const node = document.activeElement;
    if (
      (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) &&
      !node.disabled &&
      !node.readOnly
    ) {
      node.select();
      return 'field';
    }
    document.execCommand('selectAll');
    return 'page';
  })()`;
}

export function selectAllMenuItem(label: string): {
  label: string;
  click: (item: unknown, focusedWindow?: unknown) => void;
} {
  return {
    label,
    click: (_item, focusedWindow) => {
      const contents = (focusedWindow as SelectAllTarget | undefined)
        ?.webContents;
      if (!contents || contents.isDestroyed()) return;
      void contents
        .executeJavaScript(selectFocusedEditableScript(), true)
        .catch(() => {});
    },
  };
}
