// The tray by the clock. On Windows and Linux closing the window hides Circle there
// instead of ending it: the runtime keeps working, and the icon answers. Left click
// brings the window back; right click gives the menu, and the menu quits. The logic is
// kept apart from Electron so the checks can try it without a screen.
/** Close hides to the tray; a quit, and a start without a tray, close for good. */
export function shouldHideOnClose(
  platform: NodeJS.Platform | string,
  options: { quitting: boolean; tray: boolean },
): boolean {
  if (platform !== 'win32' && platform !== 'linux') return false;
  return options.tray && !options.quitting;
}

/** Whether this start gets a tray at all. The desktop test harness closes windows
 * for real, so it keeps the classic behaviour; CIRCLE_DESKTOP_TRAY decides elsewhere. */
export function trayEnabled(
  platform: NodeJS.Platform | string,
  options: { fixture?: boolean; env?: Record<string, string | undefined> } = {},
): boolean {
  if (platform !== 'win32' && platform !== 'linux') return false;
  if (options.fixture) return false;
  const setting = (options.env?.CIRCLE_DESKTOP_TRAY ?? '').trim().toLowerCase();
  if (['0', 'off', 'no', 'false'].includes(setting)) return false;
  return true;
}

/** The shape `Menu.buildFromTemplate` takes, without the Electron import. */
export interface TrayItem {
  label?: string;
  click?: () => void;
  type?: 'separator';
}

/** What the right click shows: the window, then the way out. */
export function trayMenuTemplate(
  text: (value: string) => string,
  actions: { show: () => void; quit: () => void },
): TrayItem[] {
  return [
    { label: text('Open Circle'), click: actions.show },
    { type: 'separator' },
    { label: text('Quit Circle'), click: actions.quit },
  ];
}

/** What the first hide tells the person, where the system can show it. */
export function trayHint(text: (value: string) => string): {
  title: string;
  content: string;
} {
  return {
    title: text('Circle is still running'),
    content: text('right-click the tray icon to quit'),
  };
}
