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

/** What a right-click in the window knows, from Electron's context-menu event. */
export interface WindowContextParams {
  isEditable: boolean;
  selectionText: string;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}
export type WindowContextItem =
  | {
      command: 'cut' | 'copy' | 'paste' | 'selectAll';
      label: string;
      enabled: boolean;
    }
  | 'separator';

/**
 * The window's own right-click menu: a text field's Cut, Copy, Paste and Select All,
 * or Copy over selected text. Anywhere else there is no menu. The labels are the Edit
 * menu's English words; the main process translates them.
 */
export function windowContextMenu(
  params: WindowContextParams,
): WindowContextItem[] {
  const flags = params.editFlags;
  if (params.isEditable)
    return [
      { command: 'cut', label: 'Cut', enabled: flags.canCut },
      { command: 'copy', label: 'Copy', enabled: flags.canCopy },
      { command: 'paste', label: 'Paste', enabled: flags.canPaste },
      'separator',
      {
        command: 'selectAll',
        label: 'Select All',
        enabled: flags.canSelectAll,
      },
    ];
  if (params.selectionText.trim())
    return [{ command: 'copy', label: 'Copy', enabled: true }];
  return [];
}
