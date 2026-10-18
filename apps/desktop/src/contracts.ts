import type { WorkspaceServiceEvent } from './workspace-protocol';

/** One exact OS-selected file; runtime-memory-only and bound to this session. */
export type ExternalFileAccess = 'read' | 'readwrite';
export interface NativeExternalFileGrant {
  id: string;
  sessionId: string;
  path: string;
  access: ExternalFileAccess;
}
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
  complete?: boolean;
  nextCursor?: string;
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
 * Linux steps shown with an update. `sandbox` means the running chrome-sandbox is
 * setuid, so the new copy will not start until that helper belongs to root again.
 */
export interface LinuxUpdate {
  folder: string;
  sandbox: boolean;
}
/**
 * Where the application's own update is. `page` is the release page, given when this copy
 * cannot replace itself (or failed to) and the new version is downloaded by hand.
 * `linux` is set only for a Linux copy, and only while an update is in progress.
 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current'; updated?: string; linux?: LinuxUpdate }
  | { phase: 'available'; version: string; page?: string; linux?: LinuxUpdate }
  | { phase: 'downloading'; version: string; received: number; total: number }
  | { phase: 'ready'; version: string; linux?: LinuxUpdate }
  | { phase: 'installing'; version: string; linux?: LinuxUpdate }
  | {
      phase: 'failed';
      version?: string;
      error: string;
      page?: string;
      linux?: LinuxUpdate;
    };
export type UpdateAction = 'check' | 'download' | 'install';
export interface NativeAccessibilityState {
  supported: boolean;
  enabled: boolean;
  revision: number;
}
export interface DesktopBridge {
  nativeAccessibility?: () => Promise<NativeAccessibilityState>;
  onNativeAccessibility?: (
    listener: (state: NativeAccessibilityState) => void,
  ) => () => void;
  apiVersion: 1;
  info: () => Promise<DesktopInfo>;
  runtimeState: () => Promise<RuntimeUpdate>;
  runtimeCommand: (command: RuntimeCommand) => Promise<RuntimeReply>;
  onRuntime: (listener: (update: RuntimeUpdate) => void) => () => void;
  onRuntimeDelta?: (
    listener: (delta: import('./runtime-protocol').RuntimeTokenDelta) => void,
  ) => () => void;
  onWorkspaceEvent?: (
    listener: (event: WorkspaceServiceEvent) => void,
  ) => () => void;
  chooseFiles: (
    purpose: 'attach' | 'import' | 'source',
  ) => Promise<NativeFile[]>;
  /** The main-process OS picker chooses the path. Renderer supplies no path. */
  requestExternalFileGrant?: (
    sessionId: string,
    access: ExternalFileAccess,
  ) => Promise<NativeExternalFileGrant | null>;
  chooseWorkspace: () => Promise<NativeWorkspace | null>;
  /** Reveal only a workspace identity already known to the native runtime. */
  revealWorkspace: (workspaceId: string) => Promise<void>;
  readWorkspaceFile: (
    workspaceId: string,
    fileId: string,
  ) => Promise<NativeFile>;
  /** The files of the active, trusted workspace; null for any other. */
  listWorkspace: (
    workspaceId: string,
    cursor?: string,
  ) => Promise<NativeWorkspace | null>;
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
  /** Opens a human-requested HTTPS link; credentials are never accepted. */
  openExternal?: (url: string) => Promise<void>;
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
  /**
   * The person answers a page's dialog (alert, confirm, prompt, leave page), or a sign-in
   * with a user name (`text`) and password.
   */
  browserDialog: (
    sessionId: string,
    dialog: string,
    accept: boolean,
    text?: string,
    password?: string,
  ) => Promise<BrowserState>;
  /** The page as it was when its dialog opened: the page itself is stopped meanwhile. */
  browserDialogScreen: (
    sessionId: string,
    dialog: string,
  ) => Promise<string | null>;
  /** The person chooses the files for the file chooser a click of Circle's opened. */
  browserChoose: (sessionId: string, chooser: string) => Promise<BrowserState>;
  /** The person keeps or discards a download that waits for approval, with its site's others. */
  browserKeepDownload: (
    sessionId: string,
    download: string,
    keep: boolean,
  ) => Promise<BrowserState>;
  /** The person's client certificate for a site that asks (an index), or none (null). */
  browserCertificate: (
    sessionId: string,
    choice: string,
    index: number | null,
  ) => Promise<BrowserState>;
  /** The person allows or blocks what a page asked permission for. */
  browserPermission: (
    sessionId: string,
    request: string,
    allow: boolean,
  ) => Promise<BrowserState>;
  /** Shows a download in the system's file manager. */
  browserReveal: (sessionId: string, download: string) => Promise<void>;
  /** The person takes the browser from Circle, or hands it back. */
  browserControl: (
    sessionId: string,
    action: 'take' | 'return',
  ) => Promise<BrowserState>;
  onBrowserEvent: (listener: (state: BrowserState) => void) => () => void;
  /**
   * What the person does to the shown page from the panel: stop loading, zoom, find in
   * the page, switch to the next or previous tab, open or close Chromium's developer
   * tools, a still picture of the page to show while a menu covers it, and whether the
   * panel has the keyboard.
   */
  browserPage: (
    sessionId: string,
    action: BrowserPageAction,
    value?: unknown,
  ) => Promise<BrowserState | string | null>;
  /**
   * Whether the browser panel, not the page, has the keyboard. Synchronous so the
   * first key after a click is not lost to the page view.
   */
  browserKeys?: (sessionId: string, focused: boolean) => void;
  /** A browser shortcut pressed in the page, or in the panel when the system took it. */
  onBrowserKey: (listener: (event: BrowserKeyEvent) => void) => () => void;
  /** Whether the window shows dark or light: the browser's own pages follow it. */
  setTheme: (dark: boolean) => Promise<void>;
  onAction: (listener: (action: DesktopAction) => void) => () => void;
  updateState: () => Promise<UpdateState>;
  update: (action: UpdateAction) => Promise<UpdateState>;
  onUpdate: (listener: (state: UpdateState) => void) => () => void;
}

export type BrowserPageAction =
  | 'stop'
  | 'zoom'
  | 'find'
  | 'find-stop'
  | 'tab'
  | 'devtools'
  | 'inspect'
  | 'snapshot'
  | 'keys';
export interface BrowserKeyEvent {
  /** `browser:<session>`, as BrowserState names it. */
  sessionId: string;
  action: import('./browser-controls').BrowserKeyAction;
  /** The tab whose page had the keyboard, when the key was pressed in a page. */
  tab?: string;
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
  /** The shown tab's page asks for files: a click of Circle's opened its file chooser. */
  chooser?: { id: string; multiple: boolean };
  /** The conversation's latest downloads, newest last. */
  downloads?: BrowserDownload[];
  /** Sites in this conversation's tabs that wait for the person's client certificate. */
  certificateChoices?: BrowserCertificateChoice[];
  /** What the shown tab's page asks permission for, waiting for the person. */
  permissions?: BrowserPermission[];
  /**
   * Who has the browser: no one in particular (`shared`), Circle in the middle of an action
   * (`agent`), the person waiting for that action to end (`user_pending`), or the person
   * (`user`), with Circle paused until they hand it back.
   */
  control?: BrowserControl;
  /** Why Circle handed the person the browser, in its words. */
  handoff?: string;
  /** The person took the browser and an action of Circle's waits until they hand it back. */
  waiting?: boolean;
  /** The shown tab's page zoom, in percent. */
  zoom?: number;
  /** Find in the shown tab's page: what is sought, the current match and how many. */
  find?: { text: string; active: number; matches: number };
  /** Chromium's own developer tools are open on the shown tab. */
  devTools?: boolean;
}
export type BrowserControl = 'shared' | 'agent' | 'user_pending' | 'user';
/** A site asks for a client certificate: only the person chooses one, or none. */
export interface BrowserCertificateChoice {
  id: string;
  tab: string;
  origin: string;
  certificates: {
    subject: string;
    issuer: string;
    /** Seconds since 1970. */
    validExpiry: number;
    /** SHA-256, as the certificate warning shows it. */
    fingerprint: string;
  }[];
}
/** A page's request for a permission, which only the person answers. */
export interface BrowserPermission {
  id: string;
  origin: string;
  kinds: (
    | 'camera'
    | 'microphone'
    | 'location'
    | 'notifications'
    | 'clipboard'
    | 'midi'
    | 'idle'
    | 'windows'
  )[];
}
export interface BrowserDownload {
  id: string;
  name: string;
  state: 'progress' | 'waiting' | 'done' | 'failed';
  received: number;
  total: number;
}
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  active: boolean;
  /** The page's icon, as a data URL. */
  favicon?: string;
}
export interface BrowserDialog {
  id: string;
  tab: string;
  /** `auth`: the site, or a proxy, asks for a user name and password. */
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'auth';
  message: string;
  defaultPrompt: string;
  origin: string;
  /** A sign-in's realm, as the site names it. */
  realm?: string;
  /** A sign-in a proxy asks for, not the site. */
  proxy?: boolean;
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
  screenshot?: { id: string; width: number; height: number };
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
