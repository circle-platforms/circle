import { BrowserSessions } from './browser';
import { RuntimeSupervisor } from './runtime-supervisor';
import { validateRuntimeCommand } from './runtime-protocol';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  protocol,
  shell,
  session,
} from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceGrants, nativeFile } from './files';
import { attention } from './attention';
import {
  isNativeLocale,
  nativeText,
  systemNativeLocale,
  type NativeLocale,
} from './native-text';
import {
  assetPath,
  boundedText,
  MAX_EXPORT_BYTES,
  MAX_FILE_BYTES,
  safeExternalUrl,
  trustedAppUrl,
  validSaveName,
} from './policy';
import type { DesktopAction, DesktopInfo } from './contracts';
app.setName('Circle');
// Windows shows notifications for the id the installer's Start menu shortcut carries.
if (process.platform === 'win32')
  app.setAppUserModelId('com.qingshanfeihu.circle');
const dataPath =
  process.env.CIRCLE_WORKBENCH_DATA_DIR ??
  (existsSync(join(app.getPath('appData'), 'Circle Workbench'))
    ? join(app.getPath('appData'), 'Circle Workbench')
    : join(app.getPath('appData'), 'Circle'));
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
let browsers: BrowserSessions | null = null;
let runtime: RuntimeSupervisor | undefined;
const workspaceSelections = new Map<string, string>();
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
function checkSender(event: IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame?.routingId !== window.webContents.mainFrame.routingId ||
    event.senderFrame?.processId !== window.webContents.mainFrame.processId ||
    !trustedAppUrl(event.senderFrame.url)
  )
    throw Error('untrusted IPC sender');
}
function handle(channel: string, handler: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    checkSender(event);
    return handler(...args);
  });
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
  const menu: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin')
    menu.push({
      label: app.name,
      submenu: [
        role('about', 'About Circle'),
        { type: 'separator' },
        {
          label: text('settings'),
          accelerator: 'CmdOrCtrl+,',
          click: () => sendAction('settings'),
        },
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
          click: () => sendAction('new'),
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
        role('selectAll', 'Select All'),
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
        role('toggleDevTools', 'Toggle Developer Tools'),
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
  browsers = new BrowserSessions(window);
  window.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = safeExternalUrl(url);
    if (allowed && !fixtureProfile) void shell.openExternal(allowed);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedAppUrl(url)) event.preventDefault();
  });
  window.once('ready-to-show', () => window?.show());
  window.on('close', () => browsers?.close());
  window.on('closed', () => {
    browsers = null;
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
    protocol.handle('circle', async (request) => {
      try {
        const path = assetPath(rendererRoot, request.url);
        if (!(await stat(path)).isFile())
          return new Response('not found', { status: 404 });
        const response = await net.fetch(pathToFileURL(path).href);
        const headers = new Headers(response.headers);
        headers.set(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
        );
        return new Response(response.body, {
          status: response.status,
          headers,
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
      version: app.getVersion(),
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
      );
      runtime.subscribe((update) => {
        window?.webContents.send('circle:runtime-update', update);
        showAttention(update);
      });
      await runtime.start();
    }
    handle('circle:runtime-state', () => {
      if (!runtime) throw Error('runtime not enabled');
      return runtime.state();
    });
    handle('circle:runtime-command', (value) => {
      if (!runtime) throw Error('runtime not enabled');
      const command = validateRuntimeCommand(value);
      if (command.name === 'open-workspace') {
        const path = workspaceSelections.get(
          String(command.payload.workspaceGrant),
        );
        if (!path)
          throw Error('workspace was not selected through the native dialog');
        command.payload = { path };
      }
      if (command.name === 'close')
        throw Error('use the application quit action');
      return runtime.command(command);
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
      const paths: string[] = fixtureProfile?.workspace
        ? [fixtureProfile.workspace]
        : (
            await dialog.showOpenDialog(window!, {
              title: text('open a workspace'),
              properties: ['openDirectory'],
            })
          ).filePaths;
      const selected = paths[0] ? await grants.open(paths[0]) : null;
      if (selected) workspaceSelections.set(selected.id, selected.path);
      return selected;
    });
    // The files of the folder the runtime works in, when it is trusted: the app's own
    // workspace, or one you opened and trusted. Reads still go through granted handles.
    handle('circle:list-workspace', async (workspaceId) => {
      if (!runtime || typeof workspaceId !== 'string')
        throw Error('invalid workspace');
      const snapshot = runtime.state().snapshot;
      const active = snapshot.sessions.find(
        (row) => row.id === snapshot.activeSessionId,
      );
      const workspace = snapshot.workspaces.find(
        (row) => row.id === workspaceId,
      );
      if (
        !workspace ||
        active?.workspaceId !== workspaceId ||
        !workspace.trusted
      )
        return null;
      const listed = await grants.open(workspace.path);
      workspaceSelections.set(listed.id, listed.path);
      return listed;
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
          });
      if (result.canceled || !result.filePath) return { saved: false };
      await writeFile(result.filePath, content, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return { saved: true, name: basename(result.filePath) };
    });
    handle('circle:copy-text', (value) => {
      clipboard.writeText(boundedText(value, MAX_EXPORT_BYTES));
    });
    handle('circle:browser-state', (id) => {
      if (!browsers) throw Error('window not ready');
      return browsers.state(id);
    });
    handle('circle:browser-navigate', (id, url) => {
      if (!browsers) throw Error('window not ready');
      return browsers.navigate(id, url);
    });
    handle('circle:browser-bounds', (id, bounds, visible) => {
      if (!browsers) throw Error('window not ready');
      return browsers.bounds(id, bounds, visible);
    });
    handle('circle:browser-hide', (id) => browsers?.hide(id));
    handle('circle:browser-capture', (id) => {
      if (!browsers) throw Error('window not ready');
      return browsers.capture(id);
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
    await createWindow();
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
