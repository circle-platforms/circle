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
/** One command the runtime is still holding without answering, as the windows are told it. */
export interface RuntimeCommandWait {
  id: string;
  name: string;
  waitedMs: number;
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
  /** Start the runtime process again after it stopped; nothing while it runs. */
  restartRuntime?: () => Promise<void>;
  onRuntime: (listener: (update: RuntimeUpdate) => void) => () => void;
  onRuntimeDelta?: (
    listener: (delta: import('./runtime-protocol').RuntimeTokenDelta) => void,
  ) => () => void;
  /** A command the runtime has kept for seconds, and nothing once it answers. */
  onRuntimeWait?: (
    listener: (wait: RuntimeCommandWait | null) => void,
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
  /** A picture to the system clipboard, from a data URL of a picture type. */
  copyImage: (dataUrl: string) => Promise<void>;
  /** A picture to a file the person chooses, from a data URL of a picture type. */
  saveImage: (options: {
    name: string;
    dataUrl: string;
  }) => Promise<{ saved: boolean; name?: string }>;
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
    /** The `BrowserState.host` this measurement was taken for. */
    host?: number,
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
  /** The conversation's device consoles, its saved profiles, and who holds each. */
  terminalState: (sessionId: string) => Promise<TerminalState>;
  terminalProfiles: () => Promise<TerminalProfileRow[]>;
  /** The recent raw bytes of a console, so a newly opened view can paint it at once. */
  terminalSnapshot: (sessionId: string, session: string) => Promise<string>;
  /** The person connects a saved profile from the panel. */
  terminalConnect: (
    sessionId: string,
    profile: string,
  ) => Promise<TerminalState>;
  /** The person connects a device by address, with no saved profile. */
  terminalConnectTarget: (
    sessionId: string,
    target: TerminalTargetRow,
  ) => Promise<TerminalState>;
  /** The person answers a device's unknown host key for that panel connect. */
  terminalHostKey: (
    sessionId: string,
    decision: 'once' | 'always' | 'reject',
  ) => Promise<TerminalState>;
  terminalDisconnect: (
    sessionId: string,
    session: string,
  ) => Promise<TerminalState>;
  /**
   * The person takes a console's keys, or gives them back to Circle. For one of their
   * own terminal tabs (`local:<id>`, a LocalTerminalRow's `id`) taking it means Circle's
   * read or wait on it ends at once and its typing is refused until it is given back.
   */
  terminalAttach: (
    sessionId: string,
    session: string,
  ) => Promise<TerminalState>;
  terminalDetach: (
    sessionId: string,
    session: string,
  ) => Promise<TerminalState>;
  /**
   * The person stops what Circle is doing on one of their terminal tabs (`local:<id>`)
   * without taking it: the action under way, and any waiting behind it, ends with an
   * error the model reads. Nothing is typed into the tab by stopping.
   */
  terminalStop?: (sessionId: string, session: string) => Promise<TerminalState>;
  /**
   * The person dragged a tab: the tab row's new order, as tab keys (`local:<id>`,
   * `dev:<id>`), kept for every window of the conversation.
   */
  terminalArrange?: (
    sessionId: string,
    order: string[],
  ) => Promise<TerminalState>;
  /** What the person types while they hold the console. */
  terminalInput: (
    sessionId: string,
    session: string,
    text: string,
  ) => Promise<boolean>;
  terminalResize: (
    sessionId: string,
    session: string,
    cols: number,
    rows: number,
  ) => Promise<void>;
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => () => void;
  /**
   * Take a mode of the drawer out into a window of its own, or bring that window to the
   * front when it is already open. The title is the window's. An `address` for the
   * browser opens there, as it would in the drawer. Only the main window asks.
   */
  popoutOpen: (
    kind: PopoutKind,
    sessionId: string,
    title: string,
    address?: string,
  ) => Promise<void>;
  /** Close a mode's window: the mode is in the drawer again. */
  popoutDock: (kind: PopoutKind, sessionId: string) => Promise<void>;
  /** Close every such window, as when another conversation is shown. */
  popoutDockAll: () => Promise<void>;
  /** The modes that are in windows of their own now. */
  popouts: () => Promise<PopoutState[]>;
  onPopoutEvent: (listener: (event: PopoutEvent) => void) => () => void;
  /**
   * In the browser's window: the address the main window last asked it to open, once; null
   * when there is none. `onPopoutAddress` says when there is one to take.
   */
  popoutAddress?: () => Promise<string | null>;
  onPopoutAddress?: (listener: () => void) => () => void;
  /**
   * In a window of its own: an attachment for its conversation's message box, which is in
   * the main window. Resolves once the main window has it, with whether it could also be
   * saved with the draft.
   */
  popoutAttach?: (
    sessionId: string,
    attachment: PopoutAttachment,
  ) => Promise<boolean>;
  /**
   * In the main window: an attachment a window of its own puts into a conversation's
   * message box. What the listener returns (saved or not), or the error it throws, goes
   * back to that window.
   */
  onPopoutAttach?: (
    listener: (
      sessionId: string,
      attachment: PopoutAttachment,
    ) => boolean | Promise<boolean>,
  ) => () => void;
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
  /**
   * Which move of the pages this state belongs to. A bounds update names the
   * value it measured, and one from an older move is dropped.
   */
  host?: number;
  /** Set on the reply when that bounds update was applied. */
  applied?: boolean;
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
// The device terminals of one conversation: its consoles, the person's saved profiles, and
// who holds each. Raw device bytes come as a separate event, in coalesced batches, so the
// panel's own emulator paints what the device sent.
export interface TerminalSessionRow {
  id: string;
  name: string;
  target: string;
  transport: 'ssh' | 'telnet';
  state: 'connecting' | 'ready' | 'closed' | 'error';
  detail: string;
  /** '', 'handoff' (the model offered it) or 'attach' (the person took it). */
  held: string;
  quiet: number;
  cols: number;
  rows: number;
}
/** A device reached by address from the panel: a telnet console answers its own
 * login; ssh signs in only where a saved profile says how. */
export interface TerminalTargetRow {
  transport: 'ssh' | 'telnet';
  host: string;
  port?: number;
  user?: string;
  /** A one-time SSH password: held in memory for this connection, never saved. */
  password?: string;
}
export interface TerminalProfileRow {
  name: string;
  transport: 'ssh' | 'telnet';
  target: string;
  user: string;
}
/** A host key the person must answer before a panel connect can go through. */
export interface TerminalHostKeyAsk {
  token: string;
  host: string;
  keyType: string;
  fingerprint: string;
  privateHost: boolean;
}
/**
 * What Circle is doing with one of the person's own terminal tabs: `waiting` while an
 * approval for it is open, `operating` while one of its tool actions runs on it, `held`
 * while the person has it (taken, or handed over by Circle), and `idle` otherwise.
 */
export type LocalTerminalState = 'idle' | 'waiting' | 'operating' | 'held';
/** One running shell of the conversation's terminal tabs, as Circle sees it. */
export interface LocalTerminalRow {
  /** How the model's terminal tools name it, and the `session` the commands take. */
  id: string;
  /** The terminal service's id: the `id` of its TerminalSnapshot. */
  terminal: string;
  /** Its tab is named "terminal N" by this, as terminalTabNumbers numbers it. */
  ordinal: number;
  /** The name the person gave the tab, which the tab shows instead of its number. */
  name?: string;
  state: LocalTerminalState;
  /** The person allowed Circle's first command here in this conversation. */
  allowed: boolean;
  /** Who has it while `held`: the person took it, or Circle handed it over. */
  held?: 'attach' | 'handoff';
  /** Why Circle handed it over, in Circle's words. */
  reason?: string;
}
export interface TerminalState {
  /** `terminal:`+conversation, the way the browser routes its events. */
  sessionId: string;
  conversation: string;
  sessions: TerminalSessionRow[];
  profiles: TerminalProfileRow[];
  pendingKey?: TerminalHostKeyAsk & { profile: string };
  handoff?: { session: string; reason: string };
  /** The conversation's running terminal tabs (shells, no background commands). */
  local?: LocalTerminalRow[];
  /**
   * The order the person dragged the tab row into, as its tabs' keys (`local:<id>` for a
   * terminal, `dev:<id>` for a device console). A tab it does not name goes at the end.
   */
  order?: string[];
  /** In the answer to a person's connect only: the console that connect opened. */
  opened?: string;
}
/** The parts of the drawer that can live in a window of their own. */
export type PopoutKind = 'browser' | 'terminal';
export interface PopoutState {
  kind: PopoutKind;
  sessionId: string;
}
export interface PopoutEvent extends PopoutState {
  open: boolean;
}
/**
 * What a window of its own puts into its conversation's message box: a page screenshot
 * (`image`, a PNG data URL) from the browser's window, a terminal selection (`file`, plain
 * text) from the terminal's. `size` is its bytes.
 */
export interface PopoutAttachment {
  id: string;
  name: string;
  kind: 'image' | 'file';
  mime: string;
  size: number;
  content: string;
}
export type TerminalEvent =
  | { kind: 'state'; state: TerminalState }
  | { kind: 'data'; conversation: string; session: string; bytes: string };
import type {
  RuntimeCommand,
  RuntimeReply,
  RuntimeUpdate,
} from './runtime-protocol';
