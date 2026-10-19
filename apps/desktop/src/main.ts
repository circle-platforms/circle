import { NativeExternalFilePicker } from './external-file-picker';
import {
  EncryptedCredentialStore,
  nativeHttpsUrl,
} from './encrypted-credentials';
import { BrowserSessions } from './browser';
import {
  devToolsMenuShortcut,
  selectAllMenuItem,
  windowContextMenu,
} from './menu-shortcuts';
import { TerminalPanelHost } from './terminal';
import { loadSecrets } from '../../../src/secrets.js';
import { RuntimeSupervisor } from './runtime-supervisor';
import { validateRuntimeCommand } from './runtime-protocol';
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  protocol,
  shell,
  session,
  safeStorage,
} from 'electron';
import type {
  MenuItemConstructorOptions,
  WebContents,
  WebFrameMain,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import originalFs from 'original-fs';
import { join, dirname, basename } from 'node:path';
import { WorkspaceGrants, nativeFile } from './files';
import { WorkspaceListings } from './workspace-listings';
import { selectedFolder } from './folder-dialog';
import { attention } from './attention';
import {
  isNativeLocale,
  nativeText,
  systemNativeLocale,
  type NativeLocale,
} from './native-text';
import {
  windowFile,
  boundedText,
  MAX_EXPORT_BYTES,
  MAX_FILE_BYTES,
  safeExternalUrl,
  trustedAppUrl,
  parseImageDataUrl,
  validSaveName,
} from './policy';
import type {
  DesktopAction,
  DesktopInfo,
  TerminalEvent,
  UpdateAction,
} from './contracts';
import { installation, Updater } from './updater';
import { circleAppVersion } from './circle-version';
import { releaseTag, updateCheckEnabled } from '../../../src/update.js';
import { channelOf } from './channel';
import {
  Popouts,
  type PopoutHooks,
  validPopoutAddress,
  validPopoutKind,
  validPopoutSession,
  validPopoutTitle,
} from './popouts';
import { validPopoutAttachment } from './popout-attachment';
// A release, or a beta that package:beta wrote into the packaged package.json
const channel = channelOf(
  (() => {
    try {
      return JSON.parse(
        readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'),
      );
    } catch {
      return undefined;
    }
  })(),
);
app.setName(channel.name);
// Older XDG portals turn a directory chooser into a file chooser, or return no
// path when a folder is confirmed. GTK and KDE dialogs return the folder.
if (process.platform === 'linux')
  app.commandLine.appendSwitch('xdg-portal-required-version', '4');
// Windows shows notifications for the id the installer's Start menu shortcut carries.
if (process.platform === 'win32') app.setAppUserModelId(channel.id);
const dataPath =
  process.env.CIRCLE_WORKBENCH_DATA_DIR ??
  (channel.beta
    ? join(app.getPath('appData'), channel.folder)
    : existsSync(join(app.getPath('appData'), 'Circle Workbench'))
      ? join(app.getPath('appData'), 'Circle Workbench')
      : join(app.getPath('appData'), channel.folder));
app.setPath('userData', dataPath);
// --no-sandbox contradicts enableSandbox(): the main process then crashes
// with an access violation when the first child process starts
// (https://github.com/electron/electron/issues/54838).
if (app.commandLine.hasSwitch('no-sandbox')) {
  process.stderr.write(
    'circle: cannot start with --no-sandbox because the sandbox is required\n',
  );
  process.exit(1);
}
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'circle',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
const grants = new WorkspaceGrants();
let window: BrowserWindow | null = null;
// The browser and the terminal can leave the drawer for a window of their own.
let popouts: Popouts<BrowserWindow> | null = null;
// The address each browser window is to open next, until its page takes it.
const popoutAddresses = new Map<BrowserWindow, string>();
// What a window of its own put into a message box, waiting for the main window's answer
const attachmentAnswers = new Map<
  string,
  { to: WebContents; answer: (saved: boolean, error: string) => void }
>();
let browsers: BrowserSessions | null = null;
let browserClosePending: Promise<void> = Promise.resolve();
let terminals: TerminalPanelHost | null = null;
// Certificate exceptions live only in this application process, across window recreation.
const browserCertificates = new Map<string, Set<string>>();
let runtime: RuntimeSupervisor | undefined;
let runtimeSessions = new Set<string>();
const workspaceSelections = new Map<string, string>();
const externalFilePicker = new NativeExternalFilePicker();
let externalFixtureSelection = 0;
const previewMode = process.env.CIRCLE_WORKBENCH_MODE === 'preview';
const rendererRoot = join(__dirname, 'renderer');
const fixtureProfile = process.env.CIRCLE_WORKBENCH_TEST_PROFILE
  ? JSON.parse(process.env.CIRCLE_WORKBENCH_TEST_PROFILE)
  : undefined;
// The window follows the system language; checks read it in English on any machine.
// (Chromium's --lang does not change the languages a page sees on macOS.)
const forcedLanguage: NativeLocale | undefined = process.env
  .CIRCLE_WORKBENCH_LANGUAGE
  ? systemNativeLocale([process.env.CIRCLE_WORKBENCH_LANGUAGE])
  : fixtureProfile
    ? 'en'
    : undefined;
// GTK file dialogs take their button labels from the process locale at init, which is
// before the window can say which language it shows. A Chinese start asks for zh_CN now.
function startupLocale(): NativeLocale {
  if (forcedLanguage) return forcedLanguage;
  try {
    return systemNativeLocale(app.getPreferredSystemLanguages());
  } catch {
    return systemNativeLocale([
      Intl.DateTimeFormat().resolvedOptions().locale ?? '',
    ]);
  }
}
if (startupLocale() === 'zh-CN') {
  app.commandLine.appendSwitch('lang', 'zh-CN');
  if (!/^zh/i.test(process.env.LANG ?? '')) {
    process.env.LANG = 'zh_CN.UTF-8';
    process.env.LC_MESSAGES = 'zh_CN.UTF-8';
  }
  // gettext reads LANGUAGE when the dialog is built, including under the C locale.
  // It does not create the catalog: Recent and Home stay English until gtk30.mo exists.
  if (!process.env.LANGUAGE) process.env.LANGUAGE = 'zh_CN';
}
/** The window and the windows the drawer's modes were popped out into. */
function appWindows(): BrowserWindow[] {
  return [window, ...(popouts?.all() ?? [])].filter(
    (one): one is BrowserWindow => !!one && !one.isDestroyed(),
  );
}
/** What the runtime, the browser and the terminals tell the window, told to every window. */
function broadcast(channel: string, ...args: unknown[]) {
  for (const one of appWindows()) one.webContents.send(channel, ...args);
}
/** The application's window that sent a message, or a throw for anything else. */
function checkSender(event: {
  sender: WebContents;
  senderFrame: WebFrameMain | null;
}): BrowserWindow {
  const own = appWindows().find((one) => one.webContents === event.sender);
  if (
    !own ||
    event.senderFrame?.routingId !== own.webContents.mainFrame.routingId ||
    event.senderFrame?.processId !== own.webContents.mainFrame.processId ||
    !trustedAppUrl(event.senderFrame.url)
  )
    throw Error('untrusted IPC sender');
  return own;
}
function handle(channel: string, handler: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    checkSender(event);
    return handler(...args);
  });
}
/** Like `handle`, for a handler that has to know which window asked. */
function handleFrom(
  channel: string,
  handler: (from: BrowserWindow, ...args: unknown[]) => unknown,
) {
  ipcMain.handle(channel, (event, ...args) =>
    handler(checkSender(event), ...args),
  );
}
const sendAction = (action: DesktopAction) =>
  window?.webContents.send('circle:action', action);
// The window says which language it shows; until it does, the system's.
let interfaceLocale: NativeLocale = 'en';
const text = (value: string) => nativeText(interfaceLocale)(value);
// Electron names role items in English; in Chinese the menu names them itself.
const role = (
  name: NonNullable<MenuItemConstructorOptions['role']>,
  english: string,
): MenuItemConstructorOptions =>
  interfaceLocale === 'en'
    ? { role: name }
    : { role: name, label: text(english) };
function configureMenu() {
  const settingsItem = (): MenuItemConstructorOptions => ({
    label: text('settings'),
    accelerator: 'CmdOrCtrl+,',
    click: () => sendAction('settings'),
  });
  const menu: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin')
    menu.push({
      label: app.name,
      submenu: [
        role('about', 'About Circle'),
        { type: 'separator' },
        settingsItem(),
        { type: 'separator' },
        role('hide', 'Hide Circle'),
        role('hideOthers', 'Hide Others'),
        role('unhide', 'Show All'),
        { type: 'separator' },
        role('quit', 'Quit Circle'),
      ],
    });
  menu.push(
    {
      label: text('file'),
      submenu: [
        {
          label: text('new session'),
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            // The menu takes the key. Hand the window back before the
            // renderer focuses the composer, or the typed message is lost.
            window?.webContents.focus();
            sendAction('new');
          },
        },
        {
          label: text('open folder'),
          accelerator: 'CmdOrCtrl+O',
          click: () => sendAction('open-folder'),
        },
        { type: 'separator' },
        { label: text('import session'), click: () => sendAction('import') },
        { label: text('export session'), click: () => sendAction('export') },
        { type: 'separator' },
        // macOS already owns this accelerator on the app menu. One item per
        // platform, or Electron drops the chord.
        ...(process.platform === 'darwin'
          ? []
          : [settingsItem(), { type: 'separator' as const }]),
        process.platform === 'darwin'
          ? role('close', 'Close Window')
          : role('quit', 'Quit Circle'),
      ],
    },
    {
      label: text('edit'),
      submenu: [
        role('undo', 'Undo'),
        role('redo', 'Redo'),
        { type: 'separator' },
        role('cut', 'Cut'),
        role('copy', 'Copy'),
        role('paste', 'Paste'),
        // No accelerator: the selectAll role takes Ctrl/Cmd+A and selects the
        // page instead of the focused field.
        selectAllMenuItem(text('Select All')),
      ],
    },
    {
      label: text('view'),
      submenu: [
        { label: text('session tree'), click: () => sendAction('tree') },
        { type: 'separator' },
        {
          label: text('reload window'),
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => window?.webContents.reload(),
        },
        {
          ...role('toggleDevTools', 'Toggle Developer Tools'),
          ...devToolsMenuShortcut(process.platform),
        },
        { type: 'separator' },
        role('resetZoom', 'Actual Size'),
        role('zoomIn', 'Zoom In'),
        role('zoomOut', 'Zoom Out'),
        role('togglefullscreen', 'Toggle Full Screen'),
      ],
    },
    {
      label: text('window'),
      submenu: [
        role('minimize', 'Minimize'),
        role('zoom', 'Zoom'),
        ...(process.platform === 'darwin'
          ? [role('front', 'Bring All to Front')]
          : []),
      ],
    },
    {
      label: text('help'),
      submenu: [
        { label: text('Circle help'), click: () => sendAction('help') },
      ],
    },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}
// Outside the window: a dock badge for the requests that wait, a busy bar on Windows and
// Linux, and a notification for a new request or an ended turn while you are elsewhere.
const announced = new Set<string>();
// Where a release link leads. Chromium's network stack applies the system's proxy settings,
// and net.fetch does not report the address a redirect reached, so the redirect is read here.
function redirectTarget(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'HEAD', redirect: 'manual' });
    const timer = setTimeout(() => {
      request.abort();
      reject(Error('the release check timed out'));
    }, 15000);
    const done = (value: string) => {
      clearTimeout(timer);
      request.abort();
      resolve(value);
    };
    request.on('redirect', (_status, _method, location) =>
      done(new URL(location, url).href),
    );
    request.on('response', () => done(url));
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}
// The about page shows Circle's version. app.getVersion() is 0.1.0 in a
// checkout, which is older than every release, so a check would offer the
// version already installed. A packaged copy uses the version it was built as.
const circleVersion = circleAppVersion(app.isPackaged, app.getVersion());
const updater = new Updater({
  version: circleVersion,
  home: join(dataPath, 'runtime-home'),
  folder: join(dataPath, 'updates'),
  // A beta does not replace itself: the release would take its place
  installation:
    app.isPackaged && !channel.beta
      ? installation(
          process.platform,
          process.arch,
          process.execPath,
          process.env.ProgramFiles,
        )
      : undefined,
  platform: process.platform,
  request: (input, init) => net.fetch(input as string, init),
  latest: async (releases) =>
    releaseTag(await redirectTarget(`${releases}/latest`)),
  // On macOS the installer runs on its own at once. On Windows it starts itself again apart
  // from Circle and returns; Circle waits for that before it quits.
  launch: (command, args) =>
    new Promise<void>((resolve, reject) => {
      const windows = process.platform === 'win32';
      // In the data folder: a working folder inside the application would keep Windows from
      // moving it
      const installer = spawn(command, args, {
        cwd: dataPath,
        detached: !windows,
        stdio: 'ignore',
        windowsHide: true,
      });
      installer.once('error', reject);
      if (!windows) {
        installer.once('spawn', () => resolve());
        installer.unref();
        return;
      }
      const timer = setTimeout(() => {
        installer.kill();
        reject(Error('it did not answer within a minute'));
      }, 60000);
      installer.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(Error(`it exited with ${code}`));
      });
    }),
  quit: () => app.quit(),
  remove: (path) =>
    originalFs.promises.rm(path, {
      recursive: true,
      force: true,
      maxRetries: 3,
    }),
  args: process.argv.slice(1),
});
// The daily check, as the terminal's: the packaged application, unless it is turned off.
function dailyUpdateCheck() {
  if (!app.isPackaged || fixtureProfile || previewMode) return;
  let settings: { update_check?: unknown } = {};
  try {
    settings = JSON.parse(
      readFileSync(join(dataPath, 'runtime-home', 'settings.json'), 'utf8'),
    );
  } catch {
    /* no settings yet: the check is on */
  }
  if (updateCheckEnabled(settings)) void updater.check(false);
}
function showAttention(update: Parameters<typeof attention>[0]) {
  const state = attention(update, announced, text);
  if (process.platform !== 'win32') app.setBadgeCount(state.badge);
  if (process.platform !== 'darwin')
    window?.setProgressBar(state.busy && !state.badge ? 2 : -1);
  if (!window || window.isFocused() || fixtureProfile) return;
  if (state.badge && process.platform === 'darwin')
    app.dock?.bounce('informational');
  if (!Notification.isSupported()) return;
  for (const notice of state.notices) {
    const note = new Notification({ title: notice.title, body: notice.body });
    note.on('click', () => {
      window?.show();
      window?.focus();
    });
    note.show();
  }
}
/**
 * What every window of the application does with the right button, a link that wants a
 * window of its own, and a page address that is not the application's: the same for the
 * main window and for one a mode of the drawer was popped out into.
 */
function installWindowChrome(target: BrowserWindow) {
  // Electron gives the window no right-click menu of its own. A text field gets the
  // system's editing commands, selected text gets Copy; the page asks nothing of the
  // main process for it, so the preload bridge stays as it is.
  target.webContents.on('context-menu', (_event, params) => {
    const items = windowContextMenu(params);
    if (!items.length || target.isDestroyed()) return;
    Menu.buildFromTemplate(
      items.map((item): MenuItemConstructorOptions => {
        if (item === 'separator') return { type: 'separator' };
        if (item.command === 'selectAll')
          return {
            ...selectAllMenuItem(text(item.label)),
            enabled: item.enabled,
          };
        // A click of its own rather than a role: on macOS a role item only sends the
        // system's selector, so its click() does nothing and cannot be checked.
        const command = item.command;
        return {
          label: text(item.label),
          enabled: item.enabled,
          click: () => {
            if (!target.isDestroyed()) target.webContents[command]();
          },
        };
      }),
    ).popup({ window: target });
  });
  target.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = safeExternalUrl(url);
    if (allowed && !fixtureProfile) void shell.openExternal(allowed);
    return { action: 'deny' };
  });
  target.webContents.on(
    'did-start-navigation',
    (_event, _url, inPlace, mainFrame) => {
      if (mainFrame) externalFilePicker.invalidate();
      // A page that loads again has no browser panel with the keyboard, until it says so.
      if (mainFrame && !inPlace) browsers?.windowGone(target);
    },
  );
  target.webContents.on('will-navigate', (event, url) => {
    if (!trustedAppUrl(url)) event.preventDefault();
  });
  // The system's menu takes some of the browser's keys (⌘W closes the window) before
  // the window sees them: while this window's browser panel has the keyboard, they are
  // its. Keys typed in another window are that window's.
  target.webContents.on('before-input-event', (event, input) =>
    browsers?.windowKey(event, input, target),
  );
  target.once('closed', () => browsers?.windowGone(target));
}
/**
 * A window for one mode of the drawer: the browser or the terminal of a conversation, in
 * the same application page, which then shows only that mode. A browser brings its pages
 * along; closing the window sends them back to the main window first.
 */
async function createPopoutWindow(
  kind: 'browser' | 'terminal',
  sessionId: string,
  title: string,
  hooks: PopoutHooks<BrowserWindow>,
): Promise<BrowserWindow> {
  const popout = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 420,
    minHeight: 300,
    title,
    icon: join(
      __dirname,
      process.platform === 'darwin'
        ? 'assets/circle-macos.png'
        : 'assets/circle.png',
    ),
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  // The page asks the main process for what it starts with: from here it is answered.
  hooks.created(popout);
  // The title is the mode and the conversation, not the page's.
  popout.on('page-title-updated', (event) => event.preventDefault());
  installWindowChrome(popout);
  if (kind === 'browser') browsers?.moveToWindow(sessionId, popout);
  // Before it is gone, so its pages are not lost with it. From here the window is gone for
  // the application: pressing its mode again makes a new one.
  popout.on('close', () => {
    if (kind === 'browser') browsers?.moveToWindow(sessionId, null);
    popoutAddresses.delete(popout);
    hooks.closing();
  });
  popout.once('closed', () => {
    popoutAddresses.delete(popout);
    hooks.closed();
  });
  popout.once('ready-to-show', () => popout.show());
  await popout.loadURL(
    `circle://workbench/index.html#/popout/${kind}/${sessionId}`,
  );
  return popout;
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 560,
    title: app.name,
    icon: join(
      __dirname,
      process.platform === 'darwin'
        ? 'assets/circle-macos.png'
        : 'assets/circle.png',
    ),
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition:
      process.platform === 'darwin' ? { x: 16, y: 15 } : undefined,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  browsers = new BrowserSessions(
    window,
    (state) => broadcast('circle:browser-event', state),
    () => interfaceLocale,
    join(dataPath, 'browser-certificates.json'),
    browserCertificates,
    // A browser keeps downloads in the system's Downloads folder; an isolated data folder
    // (development, tests) keeps its own
    process.env.CIRCLE_WORKBENCH_DATA_DIR
      ? join(dataPath, 'downloads')
      : app.getPath('downloads'),
    // How the person handed over the browser: auto mode takes it back by itself
    (id) =>
      runtime?.state().snapshot.sessions.find((row) => row.id === id)?.mode,
  );
  // A browser shortcut goes to the window that has the page, wherever the panel is.
  browsers.sendKey = (event) => {
    const target = browsers?.windowOf(event.sessionId.replace(/^browser:/, ''));
    if (target && !target.isDestroyed())
      target.webContents.send('circle:browser-key', event);
  };
  runtime?.onSessionCleanup(async (id) => {
    await browsers?.deleteSession(id);
    browserCertificates.delete(id);
  });
  runtime?.onBrowser((request, signal) => {
    if (!browsers) throw Error('the browser is closed');
    return browsers.agent(request, signal);
  });
  terminals = new TerminalPanelHost(
    (event: TerminalEvent) => broadcast('circle:terminal-event', event),
    join(dataPath, 'runtime-home'),
    join(dataPath, 'terminal-host-keys.json'),
    (name) => loadSecrets(join(dataPath, 'runtime-home'))[name] ?? '',
    // Plan mode does not hand a console over, as it does not hand the browser over
    (id) =>
      runtime?.state().snapshot.sessions.find((row) => row.id === id)?.mode,
    // The person's own terminal tabs are the runtime's, where their shells are
    (conversation, session, action) =>
      runtime
        ? runtime.terminalTabControl(conversation, session, action)
        : Promise.reject(Error('the runtime is not connected')),
  );
  popouts = new Popouts<BrowserWindow>({
    create: createPopoutWindow,
    onChange: (event) => broadcast('circle:popout-event', event),
  });
  runtime?.onTerminalTabs((update) => {
    if (update === 'gone') terminals?.tabsGone();
    else terminals?.tabsChanged(update.conversation, update.rows);
  });
  runtime?.onTerminalCleanup(async (id) => terminals?.releaseSession(id));
  runtime?.onTerminal((request, signal) => {
    if (!terminals) throw Error('the terminal host is closed');
    return terminals.agent(request, signal);
  });
  installWindowChrome(window);
  window.once('ready-to-show', () => window?.show());
  window.on('close', () => {
    popouts?.dockAll();
    terminals?.close();
    if (!browsers) return;
    browserClosePending = Promise.all([
      browserClosePending,
      browsers.close(),
    ]).then(() => {});
    void browserClosePending.catch((error) => {
      void dialog.showMessageBox({
        type: 'error',
        message: text('Circle could not stop its runtime'),
        detail: String(error),
      });
    });
  });
  window.on('closed', () => {
    browsers = null;
    terminals = null;
    popouts = null;
    window = null;
  });
  await window.loadURL('circle://workbench/index.html');
}
app
  .whenReady()
  .then(async () => {
    await mkdir(dataPath, { recursive: true, mode: 0o700 });
    // The packaged app's icon is in its bundle; this one is for running from a build. A
    // missing picture must not keep the app from starting.
    if (process.platform === 'darwin')
      try {
        app.dock?.setIcon(join(__dirname, 'assets/circle-macos.png'));
      } catch (error) {
        process.stderr.write('circle: no dock icon: ' + String(error) + '\n');
      }
    // The window's own files, read whole by Node, which also reads them from the
    // application archive, rather than streamed through Chromium's file loader, and read
    // at once (see windowFile): the window's start must never wait on its files.
    protocol.handle('circle', (request) => {
      try {
        const file = windowFile(rendererRoot, request.url);
        if (!file) return new Response('not found', { status: 404 });
        return new Response(file.body, {
          status: 200,
          headers: {
            'Content-Type': file.type,
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
          },
        });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    handle('circle:info', (): DesktopInfo => ({
      kind: 'desktop',
      name: app.name,
      version: circleVersion,
      platform: process.platform,
      packaged: app.isPackaged,
      dataPath,
      runtimeConnected: runtime?.connected ?? false,
      frontendOnly: previewMode,
      language: forcedLanguage,
    }));
    if (!previewMode) {
      runtime = new RuntimeSupervisor(
        join(dataPath, 'runtime-home'),
        __dirname,
        (url) => {
          // The window opens the link in its browser panel. Without a window, the system
          // browser does, after the same check as links the window opens.
          if (window && !window.isDestroyed()) return;
          const allowed = safeExternalUrl(url);
          if (allowed && !fixtureProfile) void shell.openExternal(allowed);
        },
        {
          logFile: join(dataPath, 'logs', 'runtime.log'),
          version: circleVersion,
        },
      );
      runtime.onCredentials(
        new EncryptedCredentialStore(join(dataPath, 'private-credentials'), {
          isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
          encryptString: (value) => safeStorage.encryptString(value),
          decryptString: (value) => safeStorage.decryptString(value),
          ...(process.platform === 'linux'
            ? {
                getSelectedStorageBackend: () =>
                  safeStorage.getSelectedStorageBackend(),
              }
            : {}),
        }),
      );
      runtime.onWorkspaceEvent((event) =>
        broadcast('circle:workspace-event', event),
      );
      runtime.onTokenDelta((delta) =>
        broadcast('circle:runtime-token-delta', delta),
      );
      runtime.subscribe((update) => {
        externalFilePicker.observe({
          connected: update.connected,
          activeSessionId: update.snapshot.activeSessionId,
          sessions: update.snapshot.sessions,
        });
        const current = new Set(
          update.snapshot.sessions.map((session) => session.id),
        );
        for (const id of runtimeSessions)
          if (!current.has(id)) {
            void browsers?.deleteSession(id).catch(() => {});
            void terminals?.releaseSession(id);
            browserCertificates.delete(id);
          }
        runtimeSessions = current;
        broadcast('circle:runtime-update', update);
        showAttention(update);
      });
      await runtime.start();
    }
    handle('circle:runtime-state', () => {
      if (!runtime) throw Error('runtime not enabled');
      return runtime.state();
    });
    handle('circle:runtime-restart', async () => {
      if (!runtime) throw Error('runtime not enabled');
      await runtime.restart();
    });
    handle('circle:runtime-command', (value) => {
      if (!runtime) throw Error('runtime not enabled');
      const command = validateRuntimeCommand(value);
      if (
        command.name === 'open-workspace' ||
        command.name === 'set-default-workspace' ||
        command.name === 'set-task-folder'
      ) {
        const path = workspaceSelections.get(
          String(command.payload.workspaceGrant),
        );
        if (!path)
          throw Error('workspace was not selected through the native dialog');
        command.payload = { path };
      }
      if (command.name === 'close')
        throw Error('use the application quit action');
      // A message to Circle hands back the browser the person had
      if (command.name === 'prompt') browsers?.personWrote(command.sessionId);
      return runtime.command(command);
    });
    handle('circle:request-external-file-grant', async (sessionId, access) => {
      if (!runtime || !window) throw Error('runtime not enabled');
      const ownerWindow = window;
      const ownerRuntime = runtime;
      return externalFilePicker.request(sessionId, access, {
        refresh: () => {
          if (
            window !== ownerWindow ||
            ownerWindow.isDestroyed() ||
            runtime !== ownerRuntime
          )
            throw Error('external file permission selection is stale');
          const state = ownerRuntime.state();
          return {
            connected: state.connected,
            activeSessionId: state.snapshot.activeSessionId,
            sessions: state.snapshot.sessions,
          };
        },
        choose: async (scope) => {
          // The automation profile belongs to the native process and never
          // comes from renderer input. An exhausted fixture cancels, never opens
          // a real file dialog or reads files from the actual user profile.
          if (fixtureProfile) {
            const selected =
              fixtureProfile.externalFileSelections?.[
                externalFixtureSelection++
              ];
            if (selected?.delayMs)
              await new Promise((done) =>
                setTimeout(
                  done,
                  Math.min(10000, Math.max(0, Number(selected.delayMs))),
                ),
              );
            return selected
              ? {
                  canceled: selected.canceled === true,
                  filePaths: selected.filePaths ?? [],
                }
              : { canceled: true, filePaths: [] };
          }
          return dialog.showOpenDialog(ownerWindow, {
            title: text('allow one external file'),
            buttonLabel:
              scope === 'read'
                ? text('allow read')
                : text('allow read and write'),
            message:
              scope === 'read'
                ? text('choose one file for this session to read')
                : text('choose one file for this session to read and write'),
            properties: [
              'openFile',
              'dontAddToRecent',
              ...(process.platform === 'darwin'
                ? ['noResolveAliases' as const]
                : []),
            ],
          });
        },
        mint: (owner, path, scope) =>
          ownerRuntime.grantExternalFile(owner, path, scope),
        revoke: async (owner, id) => {
          await ownerRuntime.revokeExternalFileGrant(owner, id);
        },
      });
    });
    handle('circle:choose-files', async (purpose) => {
      if (!['attach', 'import', 'source'].includes(String(purpose)))
        throw Error('invalid file selection purpose');
      const paths: string[] =
        fixtureProfile?.files ??
        (
          await dialog.showOpenDialog(window!, {
            title:
              purpose === 'import'
                ? text('import a session')
                : text('choose files'),
            properties:
              purpose === 'attach'
                ? ['openFile', 'multiSelections']
                : ['openFile'],
            filters:
              purpose === 'import'
                ? [
                    {
                      name: text('session or text'),
                      extensions: ['json', 'jsonl', 'md', 'txt'],
                    },
                  ]
                : [
                    {
                      name: text('supported files'),
                      extensions: [
                        'txt',
                        'md',
                        'ts',
                        'tsx',
                        'js',
                        'json',
                        'jsonl',
                        'py',
                        'log',
                        'csv',
                        'yaml',
                        'yml',
                        'png',
                        'jpg',
                        'jpeg',
                        'gif',
                        'webp',
                        'pdf',
                      ],
                    },
                  ],
          })
        ).filePaths;
      return Promise.all(
        paths
          .slice(0, 16)
          .map((path) =>
            nativeFile(
              path,
              purpose === 'import'
                ? MAX_FILE_BYTES
                : purpose === 'source'
                  ? 1_000_000
                  : 256_000,
            ),
          ),
      );
    });
    handle('circle:choose-workspace', async () => {
      if (fixtureProfile?.workspace) {
        const selected = await grants.open(fixtureProfile.workspace);
        workspaceSelections.set(selected.id, selected.path);
        return selected;
      }
      // The click that opened the chooser is still in the GTK queue and would
      // cancel it before a folder can be confirmed.
      if (process.platform === 'linux')
        await new Promise((resolve) => setTimeout(resolve, 100));
      const path = selectedFolder(
        await dialog.showOpenDialog(window!, {
          title: text('open folder'),
          properties: ['openDirectory'],
        }),
      );
      if (!path) return null;
      const selected = await grants.open(path);
      workspaceSelections.set(selected.id, selected.path);
      return selected;
    });
    handle('circle:reveal-workspace', (workspaceId) => {
      if (!runtime || typeof workspaceId !== 'string')
        throw Error('invalid workspace');
      const workspace = runtime
        .state()
        .snapshot.workspaces.find((row) => row.id === workspaceId);
      if (!workspace) throw Error('workspace not found');
      if (!fixtureProfile) shell.showItemInFolder(workspace.path);
    });
    // The files of the folder the runtime works in, when it is trusted: the app's own
    // workspace, or one you opened and trusted. Reads still go through granted handles.
    const listings = new WorkspaceListings(grants);
    const listingWindows = new WeakSet<BrowserWindow>();
    handleFrom('circle:list-workspace', async (from, workspaceId, cursor) => {
      if (
        !runtime ||
        typeof workspaceId !== 'string' ||
        (cursor !== undefined && typeof cursor !== 'string')
      )
        throw Error('invalid workspace listing');
      const snapshot = runtime.state().snapshot;
      const sessionId = snapshot.activeSessionId;
      const workspace = snapshot.workspaces.find(
        (row) => row.id === workspaceId,
      );
      const assertActive = () => {
        const current = runtime!.state().snapshot;
        if (
          !runtime!.connected ||
          from.isDestroyed() ||
          current.activeSessionId !== sessionId ||
          current.sessions.find((row) => row.id === sessionId)?.workspaceId !==
            workspaceId ||
          !current.workspaces.find((row) => row.id === workspaceId)?.trusted
        )
          throw Error('file listing owner changed');
      };
      if (
        !workspace ||
        !workspace.trusted ||
        snapshot.sessions.find((row) => row.id === sessionId)?.workspaceId !==
          workspaceId
      )
        return null;
      if (!listingWindows.has(from)) {
        listingWindows.add(from);
        from.once('closed', () => {
          void listings.close(from).catch((error) => console.error(error));
        });
      }
      const listed = await listings.list(
        from,
        sessionId,
        workspaceId,
        workspace.path,
        cursor,
        assertActive,
      );
      workspaceSelections.set(listed.id, listed.path);
      return listed;
    });
    let accessibilityRevision = 0;
    const nativeAccessibility = () => ({
      supported: process.platform === 'darwin' || process.platform === 'win32',
      enabled:
        process.platform === 'darwin' || process.platform === 'win32'
          ? app.isAccessibilitySupportEnabled()
          : true,
      revision: accessibilityRevision,
    });
    handle('circle:native-accessibility', () => nativeAccessibility());
    app.on('accessibility-support-changed', () => {
      accessibilityRevision++;
      if (window && !window.isDestroyed())
        window.webContents.send(
          'circle:native-accessibility-changed',
          nativeAccessibility(),
        );
    });
    handle('circle:set-language', (value) => {
      if (!isNativeLocale(value)) throw Error('invalid language');
      interfaceLocale = value;
      configureMenu();
    });
    handle('circle:read-workspace-file', async (workspaceId, fileId) => {
      if (typeof workspaceId !== 'string' || typeof fileId !== 'string')
        throw Error('invalid workspace file handle');
      return grants.read(workspaceId, fileId);
    });
    handle('circle:save-file', async (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('invalid export');
      const options = value as Record<string, unknown>;
      const name = validSaveName(options.name);
      const content = boundedText(options.content, MAX_EXPORT_BYTES);
      const result = fixtureProfile?.exportPath
        ? { canceled: false, filePath: fixtureProfile.exportPath }
        : await dialog.showSaveDialog(window!, {
            title: text('export session'),
            defaultPath: name,
            properties: ['showOverwriteConfirmation'],
          });
      if (result.canceled || !result.filePath) return { saved: false };
      await writeFile(result.filePath, content, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return { saved: true, name: basename(result.filePath) };
    });
    handle('circle:copy-text', (value) => {
      return clipboard.writeText(boundedText(value, MAX_EXPORT_BYTES));
    });
    handle('circle:copy-image', async (value) => {
      const image = nativeImage.createFromBuffer(
        parseImageDataUrl(value).bytes,
      );
      if (image.isEmpty()) throw Error('invalid image');
      // The clipboard takes a picture as PNG, whatever type it came in.
      await clipboard.write([
        new ClipboardItem({
          'image/png': new Blob([new Uint8Array(image.toPNG())], {
            type: 'image/png',
          }),
        }),
      ]);
    });
    handle('circle:save-image', async (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('invalid export');
      const options = value as Record<string, unknown>;
      const name = validSaveName(options.name);
      const { bytes } = parseImageDataUrl(options.dataUrl);
      const result = fixtureProfile?.exportPath
        ? { canceled: false, filePath: fixtureProfile.exportPath }
        : await dialog.showSaveDialog(window!, {
            title: text('save image'),
            defaultPath: name,
            // Every screenshot has a name like the last one: asking before replacing a
            // file is the default on macOS and Windows, and asked for here on Linux
            properties: ['showOverwriteConfirmation'],
          });
      if (result.canceled || !result.filePath) return { saved: false };
      await writeFile(result.filePath, bytes, { mode: 0o600 });
      return { saved: true, name: basename(result.filePath) };
    });
    handle('circle:open-external', async (value) => {
      const url = nativeHttpsUrl(value);
      if (!fixtureProfile) await shell.openExternal(url);
    });
    handle('circle:browser-state', (id) => {
      if (!browsers) throw Error('window not ready');
      return browsers.state(id);
    });
    handle('circle:browser-navigate', (id, url) => {
      if (!browsers) throw Error('window not ready');
      return browsers.navigate(id, url);
    });
    // Only the window that has a conversation's pages places them: the drawer of the main
    // window keeps its hands off while the browser is in a window of its own.
    handleFrom('circle:browser-bounds', (from, id, bounds, visible) => {
      if (!browsers) throw Error('window not ready');
      if (browsers.windowOf(id) !== from) return browsers.state(id);
      return browsers.bounds(id, bounds, visible);
    });
    handleFrom('circle:browser-hide', (from, id) => {
      if (browsers && browsers.windowOf(id) === from) browsers.hide(id);
    });
    // The main window's drawer opens the windows, and may give the browser's an address.
    handleFrom('circle:popout-open', async (from, kind, id, title, address) => {
      if (!popouts) throw Error('window not ready');
      if (from !== window) throw Error('untrusted IPC sender');
      const mode = validPopoutKind(kind);
      const sessionId = validPopoutSession(id);
      const name = validPopoutTitle(title);
      if (address !== undefined && mode !== 'browser')
        throw Error('invalid address');
      const url =
        address === undefined ? undefined : validPopoutAddress(address);
      await popouts.open(mode, sessionId, name);
      const opened = popouts.window(mode, sessionId);
      if (!url || !opened || opened.isDestroyed()) return;
      // Its page takes it when it starts, or now when it is up.
      popoutAddresses.set(opened, url);
      opened.webContents.send('circle:popout-address');
    });
    handleFrom('circle:popout-address', (from) => {
      if (popouts?.owner(from)?.kind !== 'browser') return null;
      const url = popoutAddresses.get(from) ?? null;
      popoutAddresses.delete(from);
      return url;
    });
    handle('circle:popout-dock', (kind, id) => {
      popouts?.dock(validPopoutKind(kind), validPopoutSession(id));
    });
    handle('circle:popout-dock-all', () => popouts?.dockAll());
    handle('circle:popouts', () => popouts?.list() ?? []);
    // A window of its own puts a screenshot or a terminal selection into its conversation's
    // message box. That box is the main window's, which adds it as the drawer would and
    // answers whether it could save it with the draft.
    handleFrom('circle:popout-attach', (from, id, value) => {
      const owner = popouts?.owner(from);
      if (!owner) throw Error('untrusted IPC sender');
      const sessionId = validPopoutSession(id);
      if (sessionId !== owner.sessionId) throw Error('invalid conversation');
      const attachment = validPopoutAttachment(owner.kind, value);
      const target = window;
      if (!target || target.isDestroyed()) throw Error('window not ready');
      const request = randomUUID();
      return new Promise<boolean>((resolve, reject) => {
        const answer = (saved: boolean, error: string) => {
          clearTimeout(timer);
          attachmentAnswers.delete(request);
          if (error) reject(Error(error));
          else resolve(saved);
        };
        const timer = setTimeout(
          () => answer(false, 'the main window did not answer'),
          15_000,
        );
        attachmentAnswers.set(request, { to: target.webContents, answer });
        target.webContents.send('circle:popout-attachment', {
          request,
          sessionId,
          attachment,
        });
      });
    });
    ipcMain.on(
      'circle:popout-attachment-answer',
      (event, request, saved, error) => {
        try {
          checkSender(event);
        } catch {
          return;
        }
        const pending =
          typeof request === 'string'
            ? attachmentAnswers.get(request)
            : undefined;
        // Only the window the attachment was given to answers for it.
        if (!pending || pending.to !== event.sender) return;
        pending.answer(
          saved === true,
          typeof error === 'string' ? error.slice(0, 300) : '',
        );
      },
    );
    handle('circle:browser-capture', (id) => {
      if (!browsers) throw Error('window not ready');
      return browsers.capture(id);
    });
    handle('circle:set-theme', (dark) => browsers?.setDark(dark === true));
    handle('circle:browser-tabs', (id, action, tab) => {
      if (!browsers) throw Error('window not ready');
      return browsers.tabs(id, action, tab);
    });
    handle('circle:browser-dialog', (id, dialog, accept, text, password) => {
      if (!browsers) throw Error('window not ready');
      return browsers.dialog(id, dialog, accept, text, password);
    });
    handle('circle:browser-dialog-screen', (id, dialog) => {
      if (!browsers) throw Error('window not ready');
      return browsers.dialogScreen(id, dialog);
    });
    handle('circle:browser-choose', (id, chooser) => {
      if (!browsers) throw Error('window not ready');
      return browsers.choose(id, chooser);
    });
    handle('circle:browser-keep-download', (id, download, keep) => {
      if (!browsers) throw Error('window not ready');
      return browsers.keepDownload(id, download, keep);
    });
    handle('circle:browser-certificate', (id, choice, index) => {
      if (!browsers) throw Error('window not ready');
      return browsers.certificate(id, choice, index);
    });
    handle('circle:browser-permission', (id, request, allow) => {
      if (!browsers) throw Error('window not ready');
      return browsers.permission(id, request, allow);
    });
    handle('circle:browser-control', (id, action) => {
      if (!browsers) throw Error('window not ready');
      return browsers.control(id, action);
    });
    handleFrom('circle:browser-page', (from, id, action, value) => {
      if (!browsers) throw Error('window not ready');
      // Whether a panel has the keyboard is for the window it is in.
      if (action === 'keys') {
        browsers.keys(id, value, from);
        return null;
      }
      return browsers.page(id, action, value);
    });
    ipcMain.on('circle:browser-keys', (event, id, focused) => {
      // sendSync waits until returnValue is set. Set it before any throw.
      event.returnValue = null;
      try {
        const from = checkSender(event);
        // Set before the click returns, so the next key finds the panel focused.
        browsers?.keys(id, focused, from);
      } catch {
        // A sender or a conversation that is not one: nothing changes hands, and the
        // main process carries on.
      }
    });
    handle('circle:browser-reveal', (id, download) => {
      if (!browsers) throw Error('window not ready');
      shell.showItemInFolder(browsers.downloadPath(id, download));
    });
    handle('circle:terminal-state', (id) => {
      if (!terminals) throw Error('window not ready');
      return terminals.state(id);
    });
    handle('circle:terminal-profiles', () => terminals?.profiles() ?? []);
    handle('circle:terminal-snapshot', (id, session) => {
      if (!terminals) throw Error('window not ready');
      return terminals.snapshot(id, session);
    });
    handle('circle:terminal-connect', (id, profile) => {
      if (!terminals) throw Error('window not ready');
      return terminals.connect(id, profile);
    });
    handle('circle:terminal-connect-target', (id, target) => {
      if (!terminals) throw Error('window not ready');
      return terminals.connectTarget(id, target);
    });
    handle('circle:terminal-host-key', (id, decision) => {
      if (!terminals) throw Error('window not ready');
      if (!['once', 'always', 'reject'].includes(String(decision)))
        throw Error('invalid host key answer');
      return terminals.hostKey(
        id,
        String(decision) as 'once' | 'always' | 'reject',
      );
    });
    handle('circle:terminal-disconnect', (id, session) => {
      if (!terminals) throw Error('window not ready');
      return terminals.disconnect(id, session);
    });
    // A `local:` session is one of the person's own terminal tabs, held in the runtime
    handle('circle:terminal-attach', (id, session) => {
      if (!terminals) throw Error('window not ready');
      return terminals.isTab(session)
        ? terminals.tab(id, session, 'take')
        : terminals.attach(id, session);
    });
    handle('circle:terminal-detach', (id, session) => {
      if (!terminals) throw Error('window not ready');
      return terminals.isTab(session)
        ? terminals.tab(id, session, 'return')
        : terminals.detach(id, session);
    });
    handle('circle:terminal-stop', (id, session) => {
      if (!terminals) throw Error('window not ready');
      return terminals.tab(id, session, 'stop');
    });
    handle('circle:terminal-input', (id, session, text) => {
      if (!terminals) throw Error('window not ready');
      return terminals.input(id, session, text);
    });
    handle('circle:terminal-resize', (id, session, cols, rows) => {
      if (!terminals) throw Error('window not ready');
      terminals.resize(id, session, cols, rows);
    });
    updater.subscribe((state) =>
      window?.webContents.send('circle:update', state),
    );
    handle('circle:update-state', () => updater.state);
    handle('circle:update', (action) => {
      if (!['check', 'download', 'install'].includes(String(action)))
        throw Error('invalid update action');
      return updater.command(action as UpdateAction);
    });
    handle('circle:window-control', (action) => {
      if (!window) return;
      switch (action) {
        case 'minimize':
          window.minimize();
          break;
        case 'maximize':
          window.isMaximized() ? window.unmaximize() : window.maximize();
          break;
        case 'close':
          window.close();
          break;
        case 'quit':
          app.quit();
          break;
        default:
          throw Error('invalid window action');
      }
    });
    interfaceLocale = systemNativeLocale(app.getPreferredSystemLanguages());
    configureMenu();
    // An update folder it cannot read or clear never keeps the application from starting
    const updated = await updater.start().then(
      (state) => state.phase === 'current',
      () => false,
    );
    await createWindow();
    // Started by the installer, which macOS does not bring to the front by itself
    if (updated) app.focus({ steal: true });
    dailyUpdateCheck();
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) void createWindow();
    });
  })
  .catch(async (error) => {
    process.stderr.write('desktop startup failed: ' + String(error) + '\n');
    // A failed start exits with an error, after the runtime it may have started has stopped
    await runtime?.close().catch(() => {});
    app.exit(1);
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !runtime) return;
  event.preventDefault();
  void runtime
    .close()
    .then(async () => {
      await browsers?.close();
      await browserClosePending;
    })
    .then(() => {
      quitting = true;
      app.quit();
    })
    .catch((error) => {
      void dialog.showMessageBox({
        type: 'error',
        message: text('Circle could not stop its runtime'),
        detail: String(error),
      });
    });
});
