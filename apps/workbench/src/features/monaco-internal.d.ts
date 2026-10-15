/** Minimal contracts for the version-pinned Monaco 0.57 locale adapter. */
declare module 'monaco-editor/platform/actions/common/actions' {
  export const MenuId: Record<string, { id: string }>;
  export const MenuRegistry: {
    getCommands(): Map<string, Record<string, unknown>>;
    getMenuItems(menu: { id?: string }): Record<string, unknown>[];
  };
}
declare module 'monaco-editor/editor/browser/editorExtensions' {
  export const EditorExtensionsRegistry: {
    getEditorActions(): { id: string; label: string; alias: string }[];
  };
}
