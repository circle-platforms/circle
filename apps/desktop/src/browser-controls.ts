// What the browser panel shares between the window and the main process: Chrome's
// keyboard shortcuts and zoom steps. No Electron here: the renderer imports it too.

/** Chrome's page zoom steps, in percent. */
export const ZOOM_STEPS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
] as const;

/** The next zoom step in or out from `percent`, as Chrome steps; the ends stay put. */
export function nextZoom(percent: number, direction: 'in' | 'out'): number {
  if (direction === 'in')
    return (
      ZOOM_STEPS.find((step) => step > percent + 0.5) ?? ZOOM_STEPS.at(-1)!
    );
  return (
    [...ZOOM_STEPS].reverse().find((step) => step < percent - 0.5) ??
    ZOOM_STEPS[0]
  );
}

/** A zoom factor (1 = 100%) as the whole percent the menu shows. */
export const zoomPercent = (factor: number) => Math.round(factor * 100);

export type BrowserKeyAction =
  | 'address'
  | 'new-tab'
  | 'close-tab'
  | 'reload'
  | 'back'
  | 'forward'
  | 'find'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'next-tab'
  | 'previous-tab'
  | 'stop'
  // Chrome's developer tools: the shortcut opens and closes them, Inspect opens them
  | 'devtools'
  | 'inspect';

export const BROWSER_KEY_ACTIONS: readonly BrowserKeyAction[] = [
  'address',
  'new-tab',
  'close-tab',
  'reload',
  'back',
  'forward',
  'find',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'next-tab',
  'previous-tab',
  'stop',
  'devtools',
  'inspect',
];

/** A key press, as Electron's before-input-event and the DOM both can give it. */
export interface BrowserKeyInput {
  key: string;
  /** The physical key, which ⌥ on macOS does not change. */
  code?: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * Chrome's shortcut for a key press, or nothing. The command key is ⌘ on macOS and Ctrl
 * elsewhere; tab switching is Ctrl+Tab everywhere, as in Chrome. Escape is `stop`: the
 * caller uses it only while the page loads, and otherwise leaves Escape to the page.
 */
export function browserShortcut(
  input: BrowserKeyInput,
  platform: string,
): BrowserKeyAction | undefined {
  const mac = platform === 'darwin';
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (key === 'Tab' && input.control && !input.meta && !input.alt)
    return input.shift ? 'previous-tab' : 'next-tab';
  if (
    key === 'Escape' &&
    !input.control &&
    !input.meta &&
    !input.alt &&
    !input.shift
  )
    return 'stop';
  // Developer tools: F12, ⌥⌘I on macOS, Ctrl+Shift+I elsewhere
  const keyI = input.code === 'KeyI' || key === 'i';
  if (
    key === 'F12' &&
    !input.control &&
    !input.meta &&
    !input.alt &&
    !input.shift
  )
    return 'devtools';
  if (keyI && mac && input.meta && input.alt && !input.control && !input.shift)
    return 'devtools';
  if (keyI && !mac && input.control && input.shift && !input.alt && !input.meta)
    return 'devtools';
  if (
    key === 'F5' &&
    !input.control &&
    !input.meta &&
    !input.alt &&
    !input.shift
  )
    return 'reload';
  if (
    !mac &&
    input.alt &&
    !input.control &&
    !input.meta &&
    !input.shift &&
    (key === 'ArrowLeft' || key === 'ArrowRight')
  )
    return key === 'ArrowLeft' ? 'back' : 'forward';
  const command = mac
    ? input.meta && !input.control
    : input.control && !input.meta;
  if (!command || input.alt) return undefined;
  // Zoom in is ⌘= or ⌘+, which needs shift on most layouts
  if (key === '=' || key === '+') return 'zoom-in';
  if (key === '-' || key === '_') return 'zoom-out';
  if (input.shift) return undefined;
  return (
    {
      l: 'address',
      t: 'new-tab',
      w: 'close-tab',
      r: 'reload',
      '[': 'back',
      ']': 'forward',
      f: 'find',
      '0': 'zoom-reset',
    } as Record<string, BrowserKeyAction>
  )[key];
}

/** What a right-click on the page knows, as Electron's context-menu event gives it. */
export interface BrowserContextParams {
  linkURL: string;
  srcURL: string;
  mediaType: string;
  selectionText: string;
  isEditable: boolean;
  editFlags: {
    canUndo: boolean;
    canRedo: boolean;
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}
export type BrowserContextCommand =
  | 'back'
  | 'forward'
  | 'reload'
  | 'open-link'
  | 'copy-link'
  | 'open-image'
  | 'copy-image'
  | 'copy-image-address'
  | 'copy'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'paste'
  | 'select-all'
  | 'inspect';
export type BrowserContextItem =
  | { command: BrowserContextCommand; label: string; enabled: boolean }
  | 'separator';

/**
 * Chrome's page context menu, in Chrome's English words (the main process translates
 * them): a field's editing commands, a link's and an image's, a selection's copy, or
 * back, forward and reload on the page itself; and Inspect last.
 */
export function browserContextMenu(
  params: BrowserContextParams,
  page: { canGoBack: boolean; canGoForward: boolean; canInspect: boolean },
  web: (url: string) => boolean,
): BrowserContextItem[] {
  const items: BrowserContextItem[] = [];
  const group = (entries: BrowserContextItem[]) => {
    if (items.length && entries.length) items.push('separator');
    items.push(...entries);
  };
  const item = (
    command: BrowserContextCommand,
    label: string,
    enabled = true,
  ): BrowserContextItem => ({ command, label, enabled });
  const flags = params.editFlags;
  const link = params.linkURL;
  const image = params.mediaType === 'image' ? params.srcURL : '';
  const selection = params.selectionText.trim() !== '';
  if (params.isEditable) {
    group([
      item('undo', 'Undo', flags.canUndo),
      item('redo', 'Redo', flags.canRedo),
    ]);
    group([
      item('cut', 'Cut', flags.canCut),
      item('copy', 'Copy', flags.canCopy),
      item('paste', 'Paste', flags.canPaste),
      item('select-all', 'Select all', flags.canSelectAll),
    ]);
  } else {
    if (link)
      group([
        item('open-link', 'Open link in new tab', web(link)),
        item('copy-link', 'Copy link address'),
      ]);
    if (image)
      group([
        item('open-image', 'Open image in new tab', web(image)),
        item('copy-image', 'Copy image'),
        item('copy-image-address', 'Copy image address'),
      ]);
    if (selection) group([item('copy', 'Copy')]);
    if (!link && !image && !selection)
      group([
        item('back', 'Back', page.canGoBack),
        item('forward', 'Forward', page.canGoForward),
        item('reload', 'Reload'),
      ]);
  }
  group([item('inspect', 'Inspect', page.canInspect)]);
  return items;
}
