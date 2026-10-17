/** Keep Linux's standard editor format key (Ctrl+Shift+I) in the renderer.
 * Electron 44's toggleDevTools role otherwise registers that same accelerator. */
export function devToolsMenuShortcut(platform: NodeJS.Platform): {
  accelerator?: string;
} {
  return platform === 'linux' ? { accelerator: 'Control+Alt+Shift+I' } : {};
}
