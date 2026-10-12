export interface NativeFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  content: string;
  kind: 'file' | 'image' | 'document';
  truncated: boolean;
}
export interface NativeWorkspace {
  id: string;
  name: string;
  path: string;
  files: { id: string; path: string; language: string }[];
  truncated: boolean;
}
export interface DesktopInfo {
  kind: 'desktop';
  name: string;
  version: string;
  platform: string;
  packaged: boolean;
  dataPath: string;
  runtimeConnected: boolean;
  frontendOnly: boolean;
  /** A language set for this run (checks, CIRCLE_WORKBENCH_LANGUAGE); not saved. */
  language?: 'en' | 'zh-CN';
}
export type DesktopAction =
  'new' | 'tree' | 'import' | 'export' | 'settings' | 'open-folder' | 'help';
/**
 * Where the application's own update is. `page` is the release page, given when this copy
 * cannot replace itself (or failed to) and the new version is downloaded by hand.
 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current'; updated?: string }
  | { phase: 'available'; version: string; page?: string }
  | { phase: 'downloading'; version: string; received: number; total: number }
  | { phase: 'ready'; version: string }
  | { phase: 'installing'; version: string }
  | { phase: 'failed'; version?: string; error: string; page?: string };
export type UpdateAction = 'check' | 'download' | 'install';
export interface DesktopBridge {
  apiVersion: 1;
  info: () => Promise<DesktopInfo>;
  runtimeState: () => Promise<RuntimeUpdate>;
  runtimeCommand: (command: RuntimeCommand) => Promise<RuntimeReply>;
  onRuntime: (listener: (update: RuntimeUpdate) => void) => () => void;
  chooseFiles: (
    purpose: 'attach' | 'import' | 'source',
  ) => Promise<NativeFile[]>;
  chooseWorkspace: () => Promise<NativeWorkspace | null>;
  readWorkspaceFile: (
    workspaceId: string,
    fileId: string,
  ) => Promise<NativeFile>;
  /** The files of the active, trusted workspace; null for any other. */
  listWorkspace: (workspaceId: string) => Promise<NativeWorkspace | null>;
  /** The window's language, for menus, system dialogs and notifications. */
  setLanguage: (locale: 'en' | 'zh-CN') => Promise<void>;
  saveFile: (options: {
    name: string;
    content: string;
    mime?: string;
  }) => Promise<{ saved: boolean; name?: string }>;
  copyText: (text: string) => Promise<void>;
  windowControl: (
    action: 'minimize' | 'maximize' | 'close' | 'quit',
  ) => Promise<void>;
  browserState: (sessionId: string) => Promise<BrowserState>;
  browserNavigate: (sessionId: string, url: string) => Promise<BrowserState>;
  browserBounds: (
    sessionId: string,
    bounds: BrowserBounds,
    visible: boolean,
  ) => Promise<BrowserState>;
  browserHide: (sessionId: string) => Promise<void>;
  browserCapture: (sessionId: string) => Promise<BrowserCapture>;
  /** Open, show or close a tab of the conversation's browser. */
  browserTabs: (
    sessionId: string,
    action: 'new' | 'select' | 'close',
    tab?: string,
  ) => Promise<BrowserState>;
  /** The person answers a page's dialog (alert, confirm, prompt, leave page). */
  browserDialog: (
    sessionId: string,
    dialog: string,
    accept: boolean,
    text?: string,
  ) => Promise<BrowserState>;
  /** The page as it was when its dialog opened: the page itself is stopped meanwhile. */
  browserDialogScreen: (
    sessionId: string,
    dialog: string,
  ) => Promise<string | null>;
  onBrowserEvent: (listener: (state: BrowserState) => void) => () => void;
  /** Whether the window shows dark or light: the browser's own pages follow it. */
  setTheme: (dark: boolean) => Promise<void>;
  onAction: (listener: (action: DesktopAction) => void) => () => void;
  updateState: () => Promise<UpdateState>;
  update: (action: UpdateAction) => Promise<UpdateState>;
  onUpdate: (listener: (state: UpdateState) => void) => () => void;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BrowserState {
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  failure?: { url: string; error: string };
  /** The tab shows Circle's certificate warning for this host instead of the site. */
  warning?: { host: string; error: string };
  insecure?: boolean;
  operating?: boolean;
  tab?: string;
  tabs?: BrowserTab[];
  /** Dialogs pages are waiting on, in every tab, oldest first. */
  dialogs?: BrowserDialog[];
}
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  active: boolean;
}
export interface BrowserDialog {
  id: string;
  tab: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt: string;
  origin: string;
  /** Circle is answering it: the panel shows the pointer pressing the button first. */
  answering?: { accept: boolean };
}
export interface BrowserCertificate {
  url: string;
  host: string;
  error: string;
  subject: string;
  issuer: string;
  /** Certificate validity, in Unix seconds as returned by Electron. */
  validStart: number;
  validExpiry: number;
  fingerprint: string;
}
export interface BrowserCapture extends BrowserState {
  dataUrl: string;
  sha256: string;
  observedAt: string;
  attempts: number;
  retryErrors: string[];
}
import type {
  RuntimeCommand,
  RuntimeReply,
  RuntimeUpdate,
} from './runtime-protocol';
