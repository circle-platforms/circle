import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAction, DesktopBridge } from './contracts';
const actions = new Set<DesktopAction>([
  'new',
  'tree',
  'import',
  'export',
  'settings',
  'open-folder',
  'help',
]);
// Electron turns a rejected invoke into `Error invoking remote method
// '<channel>': Error: <message>`, which the address bar could not match
// against the main process's own sentence; raise that message instead.
const raiseBrowserError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  const inner =
    /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s.exec(
      message,
    );
  throw Error(inner?.[1] ? inner[1] : message);
};
const bridge: DesktopBridge = {
  apiVersion: 1,
  nativeAccessibility: () => ipcRenderer.invoke('circle:native-accessibility'),
  onNativeAccessibility: (listener) => {
    const handler = (_event: unknown, state: Parameters<typeof listener>[0]) =>
      listener(state);
    ipcRenderer.on('circle:native-accessibility-changed', handler);
    return () =>
      ipcRenderer.removeListener(
        'circle:native-accessibility-changed',
        handler,
      );
  },
  info: () => ipcRenderer.invoke('circle:info'),
  runtimeState: () => ipcRenderer.invoke('circle:runtime-state'),
  runtimeCommand: (command) =>
    ipcRenderer.invoke('circle:runtime-command', command),
  restartRuntime: () => ipcRenderer.invoke('circle:runtime-restart'),
  onRuntime: (listener) => {
    const handler = (_event: unknown, value: Parameters<typeof listener>[0]) =>
      listener(value);
    ipcRenderer.on('circle:runtime-update', handler);
    return () => ipcRenderer.removeListener('circle:runtime-update', handler);
  },
  onRuntimeDelta: (listener) => {
    const handler = (_event: unknown, value: Parameters<typeof listener>[0]) =>
      listener(value);
    ipcRenderer.on('circle:runtime-token-delta', handler);
    return () =>
      ipcRenderer.removeListener('circle:runtime-token-delta', handler);
  },
  onWorkspaceEvent: (listener) => {
    const handler = (_event: unknown, value: Parameters<typeof listener>[0]) =>
      listener(value);
    ipcRenderer.on('circle:workspace-event', handler);
    return () => ipcRenderer.removeListener('circle:workspace-event', handler);
  },
  chooseFiles: (purpose) => ipcRenderer.invoke('circle:choose-files', purpose),
  requestExternalFileGrant: (sessionId, access) =>
    ipcRenderer.invoke('circle:request-external-file-grant', sessionId, access),
  chooseWorkspace: () => ipcRenderer.invoke('circle:choose-workspace'),
  revealWorkspace: (workspaceId) =>
    ipcRenderer.invoke('circle:reveal-workspace', workspaceId),
  readWorkspaceFile: (workspaceId, fileId) =>
    ipcRenderer.invoke('circle:read-workspace-file', workspaceId, fileId),
  listWorkspace: (workspaceId, cursor) =>
    ipcRenderer.invoke('circle:list-workspace', workspaceId, cursor),
  setLanguage: (locale) => ipcRenderer.invoke('circle:set-language', locale),
  saveFile: (options) => ipcRenderer.invoke('circle:save-file', options),
  copyText: (text) => ipcRenderer.invoke('circle:copy-text', text),
  copyImage: (dataUrl) => ipcRenderer.invoke('circle:copy-image', dataUrl),
  saveImage: (options) => ipcRenderer.invoke('circle:save-image', options),
  windowControl: (action) =>
    ipcRenderer.invoke('circle:window-control', action),
  openExternal: (url) => ipcRenderer.invoke('circle:open-external', url),
  browserState: (id) => ipcRenderer.invoke('circle:browser-state', id),
  browserNavigate: (id, url) =>
    ipcRenderer
      .invoke('circle:browser-navigate', id, url)
      .catch(raiseBrowserError),
  browserBounds: (id, bounds, visible) =>
    ipcRenderer.invoke('circle:browser-bounds', id, bounds, visible),
  browserHide: (id) => ipcRenderer.invoke('circle:browser-hide', id),
  browserCapture: (id) => ipcRenderer.invoke('circle:browser-capture', id),
  setTheme: (dark) => ipcRenderer.invoke('circle:set-theme', dark),
  browserTabs: (id, action, tab) =>
    ipcRenderer.invoke('circle:browser-tabs', id, action, tab),
  browserDialog: (id, dialog, accept, text, password) =>
    ipcRenderer.invoke(
      'circle:browser-dialog',
      id,
      dialog,
      accept,
      text,
      password,
    ),
  browserDialogScreen: (id, dialog) =>
    ipcRenderer.invoke('circle:browser-dialog-screen', id, dialog),
  browserChoose: (id, chooser) =>
    ipcRenderer.invoke('circle:browser-choose', id, chooser),
  browserKeepDownload: (id, download, keep) =>
    ipcRenderer.invoke('circle:browser-keep-download', id, download, keep),
  browserCertificate: (id, choice, index) =>
    ipcRenderer.invoke('circle:browser-certificate', id, choice, index),
  browserPermission: (id, request, allow) =>
    ipcRenderer.invoke('circle:browser-permission', id, request, allow),
  browserReveal: (id, download) =>
    ipcRenderer.invoke('circle:browser-reveal', id, download),
  browserControl: (id, action) =>
    ipcRenderer.invoke('circle:browser-control', id, action),
  browserPage: (id, action, value) =>
    ipcRenderer.invoke('circle:browser-page', id, action, value),
  browserKeys: (id, focused) => {
    ipcRenderer.sendSync('circle:browser-keys', id, focused);
  },
  onBrowserKey: (listener) => {
    const handler = (_event: unknown, value: Parameters<typeof listener>[0]) =>
      listener(value);
    ipcRenderer.on('circle:browser-key', handler);
    return () => ipcRenderer.removeListener('circle:browser-key', handler);
  },
  onBrowserEvent: (listener) => {
    const handler = (_event: unknown, state: Parameters<typeof listener>[0]) =>
      listener(state);
    ipcRenderer.on('circle:browser-event', handler);
    return () => ipcRenderer.removeListener('circle:browser-event', handler);
  },
  terminalState: (id) => ipcRenderer.invoke('circle:terminal-state', id),
  terminalProfiles: () => ipcRenderer.invoke('circle:terminal-profiles'),
  terminalSnapshot: (id, session) =>
    ipcRenderer.invoke('circle:terminal-snapshot', id, session),
  terminalConnect: (id, profile) =>
    ipcRenderer.invoke('circle:terminal-connect', id, profile),
  terminalConnectTarget: (id, target) =>
    ipcRenderer.invoke('circle:terminal-connect-target', id, target),
  terminalHostKey: (id, decision) =>
    ipcRenderer.invoke('circle:terminal-host-key', id, decision),
  terminalDisconnect: (id, session) =>
    ipcRenderer.invoke('circle:terminal-disconnect', id, session),
  terminalAttach: (id, session) =>
    ipcRenderer.invoke('circle:terminal-attach', id, session),
  terminalDetach: (id, session) =>
    ipcRenderer.invoke('circle:terminal-detach', id, session),
  terminalStop: (id, session) =>
    ipcRenderer.invoke('circle:terminal-stop', id, session),
  terminalInput: (id, session, text) =>
    ipcRenderer.invoke('circle:terminal-input', id, session, text),
  terminalResize: (id, session, cols, rows) =>
    ipcRenderer.invoke('circle:terminal-resize', id, session, cols, rows),
  popoutOpen: (kind, id, title) =>
    ipcRenderer.invoke('circle:popout-open', kind, id, title),
  popoutDock: (kind, id) => ipcRenderer.invoke('circle:popout-dock', kind, id),
  popoutDockAll: () => ipcRenderer.invoke('circle:popout-dock-all'),
  popouts: () => ipcRenderer.invoke('circle:popouts'),
  onPopoutEvent: (listener) => {
    const handler = (_event: unknown, value: Parameters<typeof listener>[0]) =>
      listener(value);
    ipcRenderer.on('circle:popout-event', handler);
    return () => ipcRenderer.removeListener('circle:popout-event', handler);
  },
  onTerminalEvent: (listener) => {
    const handler = (_event: unknown, value: Parameters<typeof listener>[0]) =>
      listener(value);
    ipcRenderer.on('circle:terminal-event', handler);
    return () => ipcRenderer.removeListener('circle:terminal-event', handler);
  },
  updateState: () => ipcRenderer.invoke('circle:update-state'),
  update: (action) => ipcRenderer.invoke('circle:update', action),
  onUpdate: (listener) => {
    const handler = (_event: unknown, value: Parameters<typeof listener>[0]) =>
      listener(value);
    ipcRenderer.on('circle:update', handler);
    return () => ipcRenderer.removeListener('circle:update', handler);
  },
  onAction: (listener) => {
    const handler = (_event: unknown, value: DesktopAction) => {
      if (actions.has(value)) listener(value);
    };
    ipcRenderer.on('circle:action', handler);
    return () => ipcRenderer.removeListener('circle:action', handler);
  },
};
contextBridge.exposeInMainWorld('circleDesktop', Object.freeze(bridge));
