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
const bridge: DesktopBridge = {
  apiVersion: 1,
  info: () => ipcRenderer.invoke('circle:info'),
  runtimeState: () => ipcRenderer.invoke('circle:runtime-state'),
  runtimeCommand: (command) =>
    ipcRenderer.invoke('circle:runtime-command', command),
  onRuntime: (listener) => {
    const handler = (_event: unknown, value: Parameters<typeof listener>[0]) =>
      listener(value);
    ipcRenderer.on('circle:runtime-update', handler);
    return () => ipcRenderer.removeListener('circle:runtime-update', handler);
  },
  chooseFiles: (purpose) => ipcRenderer.invoke('circle:choose-files', purpose),
  chooseWorkspace: () => ipcRenderer.invoke('circle:choose-workspace'),
  readWorkspaceFile: (workspaceId, fileId) =>
    ipcRenderer.invoke('circle:read-workspace-file', workspaceId, fileId),
  listWorkspace: (workspaceId) =>
    ipcRenderer.invoke('circle:list-workspace', workspaceId),
  setLanguage: (locale) => ipcRenderer.invoke('circle:set-language', locale),
  saveFile: (options) => ipcRenderer.invoke('circle:save-file', options),
  copyText: (text) => ipcRenderer.invoke('circle:copy-text', text),
  windowControl: (action) =>
    ipcRenderer.invoke('circle:window-control', action),
  browserState: (id) => ipcRenderer.invoke('circle:browser-state', id),
  browserNavigate: (id, url) =>
    ipcRenderer.invoke('circle:browser-navigate', id, url),
  browserBounds: (id, bounds, visible) =>
    ipcRenderer.invoke('circle:browser-bounds', id, bounds, visible),
  browserHide: (id) => ipcRenderer.invoke('circle:browser-hide', id),
  browserCapture: (id) => ipcRenderer.invoke('circle:browser-capture', id),
  setTheme: (dark) => ipcRenderer.invoke('circle:set-theme', dark),
  browserTabs: (id, action, tab) =>
    ipcRenderer.invoke('circle:browser-tabs', id, action, tab),
  browserDialog: (id, dialog, accept, text) =>
    ipcRenderer.invoke('circle:browser-dialog', id, dialog, accept, text),
  browserDialogScreen: (id, dialog) =>
    ipcRenderer.invoke('circle:browser-dialog-screen', id, dialog),
  browserChoose: (id, chooser) =>
    ipcRenderer.invoke('circle:browser-choose', id, chooser),
  browserReveal: (id, download) =>
    ipcRenderer.invoke('circle:browser-reveal', id, download),
  onBrowserEvent: (listener) => {
    const handler = (_event: unknown, state: Parameters<typeof listener>[0]) =>
      listener(state);
    ipcRenderer.on('circle:browser-event', handler);
    return () => ipcRenderer.removeListener('circle:browser-event', handler);
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
