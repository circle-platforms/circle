import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { DropdownMenu } from 'radix-ui';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Download,
  EllipsisVertical,
  FileUp,
  FolderOpen,
  Globe,
  LoaderCircle,
  Lock,
  Minus,
  Plus,
  RotateCw,
  ShieldAlert,
  ShieldQuestion,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import {
  addressParts,
  browserEventAddress,
  browserOpened,
  browserRing,
  browserTabChanged,
  connectionKind,
  currentTurnTools,
  downloadProgress,
  shownDialog,
} from '../model/browser';
import { visibleMessages } from '../model/state';
import { formatChord } from '../model/shortcuts';
import { useBrowserState } from './useBrowserState';
import type {
  BrowserCapture,
  BrowserPermission,
  BrowserPick,
  BrowserTab,
} from '../../../desktop/src/contracts';
import {
  canPick,
  elementAttachment,
  isBrowserPick,
  pickBox,
  pickFailure,
  pickLabel,
  pickPoint,
  type BrowserPickPicture,
} from '../model/browser-pick';
import {
  browserShortcut,
  type BrowserKeyAction,
} from '../../../desktop/src/browser-controls';
import { Button, IconButton, PaneEmpty } from '../components/common';
import { BrowserDialogPanel, CertificateChoicePanel } from './BrowserDialog';
import { t } from '../i18n';
import { ModeButtons, useModeChrome } from './mode-chrome';
import { useAddToDraft } from '../app/draft';
import { screenshotAttachment } from '../model/draft-attachments';

const PERMISSIONS: Record<BrowserPermission['kinds'][number], () => string> = {
  camera: () => t('use your camera'),
  microphone: () => t('use your microphone'),
  location: () => t('know your location'),
  notifications: () => t('show notifications'),
  clipboard: () => t('see text and images copied to the clipboard'),
  midi: () => t('use your MIDI devices'),
  idle: () => t('know when you are using this device'),
  windows: () => t('manage windows on all your displays'),
};
/** What a page asks permission for, as a browser says it. */
const permissionText = (kinds: BrowserPermission['kinds']) =>
  kinds.length === 2 && kinds.includes('camera') && kinds.includes('microphone')
    ? t('use your camera and microphone')
    : kinds.map((kind) => PERMISSIONS[kind]()).join(', ');

/** A tab's name, as Chrome's tab strip shows it. */
const tabTitle = (tab: BrowserTab) =>
  tab.title && tab.title !== 'about:blank'
    ? tab.title
    : tab.url && tab.url !== 'about:blank'
      ? tab.url
      : t('new tab');

/**
 * The page's box when that box is on screen. A hidden tab, a closed inspector or a
 * collapsed column has none, and the native view must not keep its last rectangle.
 */
function laidOutBrowserViewport(node: HTMLElement): DOMRect | null {
  if (!node.isConnected || node.closest('[hidden]')) return null;
  const style = getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden') return null;
  const rect = node.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  if (rect.bottom <= 0 || rect.right <= 0) return null;
  const view = document.documentElement.getBoundingClientRect();
  if (rect.top >= view.height || rect.left >= view.width) return null;
  return rect;
}

/**
 * The next frame, or a moment later when no frame comes. Placing the native page paints
 * nothing, so a window whose drawing is held up must not keep the page away.
 */
function afterFrame(callback: () => void) {
  const cancel = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
  const run = () => {
    cancel();
    callback();
  };
  const frame = requestAnimationFrame(run);
  const timer = setTimeout(run, 100);
  return cancel;
}

const platform = () =>
  document.documentElement.dataset.desktop ??
  (/Mac/.test(navigator.platform) ? 'darwin' : 'other');

const isField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest('input, textarea, select, [contenteditable="true"]');

export function NativeBrowser({
  target,
  targetRequest,
  sessionId,
}: {
  target?: string;
  /** Counts the times `target` was asked for, so the same address can open again. */
  targetRequest?: number;
  /** The conversation whose browser this is; the open one when not given. */
  sessionId?: string;
} = {}) {
  const { snapshot, notify, runtime } = useRuntime();
  const chrome = useModeChrome();
  const whole = chrome?.whole;
  const session =
    snapshot.sessions.find((item) => item.id === sessionId) ??
    currentSession(snapshot);
  const id = session.id;
  // The page is in a window of its own: this one leaves it where it is and unplaced.
  const elsewhere = !!chrome?.poppedOut;
  const elsewhereRef = useRef(elsewhere);
  elsewhereRef.current = elsewhere;
  const state = useBrowserState(id);
  const [url, setUrl] = useState('');
  const [addressFocused, setAddressFocused] = useState(false);
  // A still picture of the page, shown while a menu is open: the page's own view is
  // native and would cover the menu
  const [frozen, setFrozen] = useState<string | null>(null);
  const frozenRef = useRef<string | null>(null);
  const [menu, setMenu] = useState<'' | 'main' | 'zoom'>('');
  const [finding, setFinding] = useState(false);
  // A navigation the panel asked for is under way: its first page loads before the
  // tab has an address of its own
  const [navigating, setNavigating] = useState(0);
  const [findText, setFindText] = useState('');
  // Pointing at an element of the page: the picture of the page it is done on, what the
  // last look under the cursor found, and the point that look was asked for
  const [pick, setPick] = useState<BrowserPickPicture | null>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    element: BrowserPick;
  } | null>(null);
  const pickRef = useRef<BrowserPickPicture | null>(null);
  pickRef.current = pick;
  const hoverPoint = useRef<{ x: number; y: number } | null>(null);
  const hovering = useRef(false);
  const pickLayer = useRef<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const findField = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  // True once this panel has placed the page. The first frames must not hide it:
  // a hide that lands after the show leaves a blank area where the page was.
  const placed = useRef(false);
  // A window of its own puts the page back as it closes. Hiding on the way out
  // parks that page after it has already moved, and the drawer then draws blank.
  const releaseOnUnmount = useRef(true);
  releaseOnUnmount.current = !chrome?.onDock;
  const wasOpened = useRef(false);
  const editingAddress = useRef(false);
  const selectOnMouseUp = useRef(false);
  const addressTab = useRef<string | undefined>(undefined);
  const navigationVersion = useRef(0);
  const captureGeneration = useRef(0);
  const currentIdentity = useRef({
    session: id,
    tab: state?.tab,
    url: state?.url,
  });
  if (
    currentIdentity.current.session !== id ||
    currentIdentity.current.tab !== state?.tab ||
    currentIdentity.current.url !== state?.url
  )
    captureGeneration.current++;
  currentIdentity.current = { session: id, tab: state?.tab, url: state?.url };
  const updateBounds = useRef<() => void>(() => {});
  // The move the measurement belongs to. One taken before the pages changed
  // windows is not this window's, and must not be sent as if it were.
  const hostToken = useRef<number | undefined>(undefined);
  const host = desktopHost()!;
  const opened = browserOpened(state);
  const dialog = shownDialog(state);
  // The shown tab's site waits for a client certificate
  const choice = state?.certificateChoices?.find(
    (entry) => entry.tab === state.tab,
  );
  const failure = state?.failure;
  const setFrozenPicture = (value: string | null) => {
    frozenRef.current = value;
    setFrozen(value);
  };
  useEffect(() => {
    active.current = false;
    placed.current = false;
    wasOpened.current = false;
    editingAddress.current = false;
    addressTab.current = undefined;
    navigationVersion.current++;
    setUrl('');
    setFrozenPicture(null);
    let froze = false;
    let freezing = false;
    let disposed = false;
    // One placement at a time, and only the latest: an earlier hide must not
    // arrive after a show and leave the page off-screen.
    let generation = 0;
    let chain = Promise.resolve();
    const update = () => {
      const mine = ++generation;
      const run = () => {
        if (mine !== generation || disposed) return;
        return place();
      };
      chain = chain.then(run, run);
    };
    const place = () => {
      // Whoever has the page places it: another window, while it is popped out.
      if (elsewhereRef.current) return;
      const token = hostToken.current;
      if (token === undefined) return;
      const node = viewport.current;
      const rect = node ? laidOutBrowserViewport(node) : null;
      // Hidden, collapsed, zero-size, or a drawer mode that folds the page: the
      // native view must leave the window. Returning here used to keep the last
      // WebContentsView painted on top. Native surfaces do not inherit DOM
      // visibility, so also release the page's keyboard ownership while
      // retaining its tab and session. A panel that has not placed the page yet
      // does not hide it: that hide is what left a moved page blank.
      if (disposed || !node || !rect) {
        if (!placed.current) return;
        void host.browserHide(id).catch(() => {});
        void Promise.resolve(host.browserPage?.(id, 'keys', false)).catch(
          () => {},
        );
        return;
      }
      const ownDialog = node.closest('[role="dialog"]');
      const blockingDialog = [
        ...document.querySelectorAll('[role="dialog"]'),
      ].some((dialog) => !dialog.contains(node));
      // A menu open anywhere in the window may reach over the page: the page steps
      // aside while it is open, its picture in its place
      const menuOpen = !!document.querySelector('[role="menu"]');
      const shown =
        active.current &&
        !blockingDialog &&
        ownDialog?.getAttribute('data-state') !== 'closed';
      // Pointing at the page steps it aside too: the cursor is over a still picture of
      // it, so every point can be checked against the page as the picture showed it.
      const visible = shown && !menuOpen && !pickRef.current;
      // One picture per menu: taken while the page still shows, before it steps aside
      if (shown && menuOpen && freezing) return;
      if (shown && menuOpen && !froze && !frozenRef.current) {
        froze = true;
        freezing = true;
        void Promise.resolve(host.browserPage?.(id, 'snapshot'))
          .catch(() => null)
          .then((picture) => {
            freezing = false;
            if (typeof picture === 'string' && !frozenRef.current)
              setFrozenPicture(picture);
            update();
          });
        return;
      }
      if (visible) froze = false;
      // Not placed yet, and not showing: do not park an open page off-screen.
      if (!visible && !placed.current) return;
      return host
        .browserBounds(
          id,
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible,
          token,
        )
        .then((next) => {
          // A reply for an older move, or one the main process dropped, leaves
          // the page unplaced so the next measurement is sent.
          if (next?.applied !== true || next.host !== token) return;
          if (visible) placed.current = true;
          // The page is back: its picture goes once the page has drawn
          if (visible && frozenRef.current)
            requestAnimationFrame(() => {
              if (!document.querySelector('[role="menu"]'))
                setFrozenPicture(null);
            });
        })
        .catch(() => {});
    };
    updateBounds.current = update;
    let pending: (() => void) | undefined;
    const schedule = () => {
      pending ??= afterFrame(() => {
        pending = undefined;
        update();
      });
    };
    const observer = new ResizeObserver(schedule);
    if (viewport.current) observer.observe(viewport.current);
    const dialogs = new MutationObserver(schedule);
    dialogs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'hidden',
        'style',
        'class',
        'data-state',
        'data-inspector-mode',
        'open',
        'aria-hidden',
      ],
    });
    const seen = new IntersectionObserver(schedule);
    if (viewport.current) seen.observe(viewport.current);
    addEventListener('resize', schedule);
    addEventListener('scroll', schedule, true);
    // A placement made while the window was hidden was dropped: make it again
    document.addEventListener('visibilitychange', schedule);
    update();
    // The window may not have a size on the first frame, and a page that just
    // moved is measured again once it does. A failed placement is retried.
    const soon = setTimeout(update, 50);
    const later = setTimeout(update, 400);
    return () => {
      disposed = true;
      clearTimeout(soon);
      clearTimeout(later);
      pending?.();
      observer.disconnect();
      dialogs.disconnect();
      seen.disconnect();
      removeEventListener('resize', schedule);
      removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
      captureGeneration.current++;
      if (!elsewhereRef.current && releaseOnUnmount.current) {
        void host.browserHide(id);
        void Promise.resolve(host.browserPage?.(id, 'keys', false)).catch(
          () => {},
        );
      }
    };
  }, [id]);
  // The page comes back from its window, or this window has just opened: the box
  // often has no size on the first frames. Measure until the page is on screen.
  useEffect(() => {
    if (elsewhere) return;
    let ticks = 0;
    const timer = setInterval(() => {
      if (active.current) updateBounds.current();
      if (placed.current || ++ticks > 50) clearInterval(timer);
    }, 100);
    const cancel = afterFrame(() => updateBounds.current());
    return () => {
      cancel();
      clearInterval(timer);
    };
  }, [elsewhere, id]);
  // The pages moved. Measure this window's own box, and forget a placement that
  // belonged to the window they left.
  useEffect(() => {
    if (typeof state?.host !== 'number') return;
    if (hostToken.current === state.host) return;
    hostToken.current = state.host;
    placed.current = false;
    updateBounds.current();
  }, [state?.host]);
  // Full view moves the same panel to another box. Measure after that move.
  useEffect(() => {
    return afterFrame(() => updateBounds.current());
  }, [whole]);
  // Pointing starts and stops the same way a menu does: the page leaves the window for
  // its picture, and comes back when the picture goes. Esc stops the pointing whatever
  // has the keyboard meanwhile: the menu's own focus, the page's, none of it matters.
  useEffect(() => {
    updateBounds.current();
    if (!pick) {
      pickLayer.current?.blur();
      return;
    }
    requestAnimationFrame(() => pickLayer.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stopPick();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pick]);
  // A picture of the page you took goes into the message box as an attachment, for you to
  // send or take back: nothing is shown in the panel for it. From a window of its own it
  // goes to the main window's message box, and the window says so.
  const addToDraft = useAddToDraft();
  const attachScreenshot = (value: BrowserCapture) => {
    const target = runtime
      .getSnapshot()
      .sessions.find((item) => item.id === id);
    if (!target || target.lifecycle === 'deleting') return;
    void addToDraft(id, screenshotAttachment(value)).then(
      (saved) => {
        if (chrome?.onDock)
          notify(
            saved
              ? t('added to the message box')
              : t('added to the message box, but it could not be saved'),
          );
      },
      (error: unknown) =>
        notify(error instanceof Error ? error.message : t('action failed')),
    );
  };
  const captureBrowser = () => {
    const identity = currentIdentity.current;
    const navigation = navigationVersion.current;
    const generation = ++captureGeneration.current;
    const current = () =>
      generation === captureGeneration.current &&
      navigation === navigationVersion.current &&
      identity.session === currentIdentity.current.session &&
      identity.tab === currentIdentity.current.tab &&
      identity.url === currentIdentity.current.url;
    void host.browserCapture(id).then(
      (value) => {
        if (current()) attachScreenshot(value);
      },
      () => {
        if (current()) notify(t('browser capture failed'));
      },
    );
  };
  /**
   * What the page pointed at goes into the message box the way a picture of it does: the
   * person sends it, or takes it back. The page itself is not touched, so the element
   * stays where they saw it.
   */
  const attachElement = (picture: BrowserPickPicture, element: BrowserPick) => {
    const target = runtime
      .getSnapshot()
      .sessions.find((item) => item.id === id);
    if (!target || target.lifecycle === 'deleting') return;
    void addToDraft(
      id,
      elementAttachment({ sessionId: id, picture, element }),
    ).then(
      (saved) =>
        notify(
          saved
            ? t('element added to draft')
            : t('element could not be added to the message box'),
        ),
      () => notify(t('element could not be added to the message box')),
    );
  };
  const stopPick = () => {
    hoverPoint.current = null;
    hovering.current = false;
    setHover(null);
    setPick(null);
  };
  /** The page as a picture the panel can point at, with the page's own CSS size. */
  const startPick = () => {
    if (pickRef.current || !state) return;
    const identity = currentIdentity.current;
    const navigation = navigationVersion.current;
    const generation = ++captureGeneration.current;
    void host.browserCapture(id).then(
      (value) => {
        const same =
          generation === captureGeneration.current &&
          navigation === navigationVersion.current &&
          identity.session === currentIdentity.current.session &&
          identity.tab === currentIdentity.current.tab &&
          identity.url === currentIdentity.current.url;
        // The page moved while its picture was being taken: point at it again.
        if (!same || !value.screenshot) {
          notify(t('the page changed; point again'));
          return;
        }
        setHover(null);
        hoverPoint.current = null;
        setPick({
          dataUrl: value.dataUrl,
          screenshotId: value.screenshot.id,
          width: value.screenshot.width,
          height: value.screenshot.height,
          url: value.url,
          title: value.title,
          observedAt: value.observedAt,
        });
      },
      () => notify(t('browser capture failed')),
    );
  };
  /**
   * What is under the cursor, asked of the page: one look at a time and always the newest
   * point, so a fast move costs one round trip and no answer is used for the wrong place.
   */
  const lookAt = (point: { x: number; y: number }) => {
    hoverPoint.current = point;
    if (hovering.current) return;
    hovering.current = true;
    const next = () => {
      const wanted = hoverPoint.current;
      if (!wanted || !pickRef.current) {
        hovering.current = false;
        return;
      }
      hoverPoint.current = null;
      void Promise.resolve(
        host.browserPage?.(id, 'pick', { ...wanted, preview: true }),
      ).then(
        (found) => {
          if (pickRef.current && isBrowserPick(found) && found.preview)
            setHover({ x: wanted.x, y: wanted.y, element: found });
          next();
        },
        () => {
          if (pickRef.current) setHover(null);
          next();
        },
      );
    };
    next();
  };
  /** The point that commits: the page answers with the element it was checked against. */
  const pickHere = (point: { x: number; y: number }) => {
    const picture = pickRef.current;
    if (!picture) return;
    void Promise.resolve(
      host.browserPage?.(id, 'pick', {
        ...point,
        screenshotId: picture.screenshotId,
      }),
    ).then(
      (found) => {
        if (!isBrowserPick(found) || found.preview) {
          notify(t('nothing to point at there'));
          return;
        }
        attachElement(picture, found);
        stopPick();
      },
      (error: unknown) => notify(pickFailure(error)),
    );
  };
  /** A cursor point in the picture, in the page's own CSS pixels. */
  const pointInPage = (clientX: number, clientY: number) => {
    const picture = pickRef.current;
    const node = pickLayer.current;
    if (!picture || !node) return null;
    const box = node.getBoundingClientRect();
    return pickPoint(
      { left: box.left, top: box.top, width: box.width, height: box.height },
      { width: picture.width, height: picture.height },
      clientX,
      clientY,
    );
  };
  // The page's own view shows once a page is open; it follows the shown tab.
  useEffect(() => {
    if (!state) return;
    const tabChanged = browserTabChanged(addressTab.current, state.tab);
    if (tabChanged) {
      editingAddress.current = false;
      wasOpened.current = false;
      setFinding(false);
    }
    // Anything that moves the page away, or gives Circle the browser again, ends the
    // pointing: the picture in the panel is no longer the page.
    if (
      pickRef.current &&
      (tabChanged ||
        !browserOpened(state) ||
        !!state.failure ||
        !!state.warning ||
        !!shownDialog(state) ||
        !!state.chooser ||
        state.operating ||
        state.control === 'agent')
    )
      stopPick();
    addressTab.current = state.tab;
    if (opened !== active.current) {
      active.current = opened;
      afterFrame(() => updateBounds.current());
    }
    const shown = browserEventAddress(
      state,
      editingAddress.current,
      wasOpened.current,
      tabChanged,
    );
    if (shown !== undefined) setUrl(shown);
    wasOpened.current = wasOpened.current || opened;
  }, [state, opened]);
  const navigate = async (target: string) => {
    const identity = currentIdentity.current;
    const version = ++navigationVersion.current;
    // The page goes somewhere else: the picture to point at is gone with it.
    stopPick();
    editingAddress.current = false;
    setNavigating((count) => count + 1);
    try {
      active.current = true;
      await host.browserNavigate(id, target);
      afterFrame(() => updateBounds.current());
    } catch (error) {
      if (
        version !== navigationVersion.current ||
        identity.session !== currentIdentity.current.session ||
        identity.tab !== currentIdentity.current.tab
      )
        return;
      if (!['back', 'forward', 'reload'].includes(target)) {
        setUrl(target);
        editingAddress.current = true;
      }
      // A string the address bar could not read is the person's to fix, not a
      // network failure; say which of the two it was.
      notify(
        error instanceof Error && error.message === 'invalid browser address'
          ? t('invalid address')
          : t('navigation failed'),
      );
    } finally {
      setNavigating((count) => count - 1);
    }
  };
  // A link an extension asked for opens as soon as it is given; typing in the address
  // bar does not.
  useEffect(() => {
    if (!target || !/^https?:\/\//i.test(target)) return;
    setUrl(target);
    void navigate(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, targetRequest, id]);
  const tabs = (action: 'new' | 'select' | 'close', tab?: string) =>
    host
      .browserTabs(id, action, tab)
      .then(() => {
        afterFrame(() => updateBounds.current());
      })
      .catch(() => notify(t('navigation failed')));
  const page = (
    action:
      'stop' | 'zoom' | 'find' | 'find-stop' | 'tab' | 'devtools' | 'inspect',
    value?: unknown,
  ) =>
    Promise.resolve(host.browserPage?.(id, action, value))
      .then(() => {
        afterFrame(() => updateBounds.current());
      })
      .catch(() => {});
  const focusAddress = () =>
    requestAnimationFrame(() => {
      address.current?.focus();
      address.current?.select();
    });
  const find = (text: string, forward = true) =>
    void page('find', { text, forward });
  const openFind = () => {
    // As in Chrome, the bar opens with what was sought last, sought again
    if (!finding && findText) find(findText);
    setFinding(true);
    requestAnimationFrame(() => {
      findField.current?.focus();
      findField.current?.select();
    });
  };
  const closeFind = () => {
    setFinding(false);
    void page('find-stop');
  };
  const zoom = (which: 'in' | 'out' | 'reset') => void page('zoom', which);
  const loading = !!state?.loading && (opened || navigating > 0);
  const zoomLevel = state?.zoom ?? 100;
  // What a browser shortcut does, from the page (through the main process) or the panel
  // `tab`: the tab captured by the native process when it received the key.
  // For a key handled here without one, the native process closes its active tab.
  const run = (action: BrowserKeyAction, tab?: string) => {
    // A browser key moves the page or its tabs, so pointing at its picture stops.
    stopPick();
    if (action === 'address') focusAddress();
    else if (action === 'new-tab') void tabs('new').then(focusAddress);
    else if (action === 'close-tab') {
      void tabs('close', tab);
    } else if (action === 'reload') {
      if (opened) void navigate('reload');
    } else if (action === 'back') {
      if (state?.canGoBack) void navigate('back');
    } else if (action === 'forward') {
      if (state?.canGoForward) void navigate('forward');
    } else if (action === 'find') {
      if (opened) openFind();
    } else if (action === 'zoom-in') zoom('in');
    else if (action === 'zoom-out') zoom('out');
    else if (action === 'zoom-reset') zoom('reset');
    else if (action === 'next-tab') void page('tab', 'next');
    else if (action === 'previous-tab') void page('tab', 'previous');
    else if (action === 'stop') void page('stop');
    else if (action === 'devtools' || action === 'inspect') void page(action);
  };
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(
    () =>
      host.onBrowserKey?.((event) => {
        if (event.sessionId === 'browser:' + id)
          runRef.current(event.action, event.tab);
      }),
    [id],
  );
  const onKeys = (event: ReactKeyboardEvent) => {
    const action = browserShortcut(
      {
        key: event.key,
        code: event.code,
        control: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
      },
      platform(),
    );
    if (!action) return;
    // Escape is a field's own, and stops a loading page elsewhere in the panel
    if (action === 'stop' && (isField(event.target) || !loading)) return;
    event.preventDefault();
    event.stopPropagation();
    run(action);
  };
  // The panel has the keyboard: the browser's shortcuts are its own, even those the
  // system's menu would take. Focus moving inside the panel blurs one control and
  // focuses the next; the keyboard stays the panel's across that. Anywhere else,
  // including the editor, those shortcuts are not the browser's.
  const keys = (focused: boolean) => {
    const bridge = desktopHost();
    if (!bridge) return;
    if (bridge.browserKeys) {
      try {
        bridge.browserKeys(id, focused);
      } catch {
        /* The panel still works if the shortcut handoff fails. */
      }
      return;
    }
    void Promise.resolve(bridge.browserPage?.(id, 'keys', focused)).catch(
      () => {},
    );
  };
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    let token = 0;
    const report = (inside: boolean) => keys(inside);
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      token += 1;
      report(true);
    };
    const onFocusIn = (event: FocusEvent) => {
      token += 1;
      report(event.target instanceof Node && node.contains(event.target));
    };
    const onFocusOut = () => {
      const mark = ++token;
      queueMicrotask(() => {
        if (mark !== token) return;
        const active = document.activeElement;
        report(!!active && active !== document.body && node.contains(active));
      });
    };
    node.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    node.addEventListener('focusout', onFocusOut);
    return () => {
      token += 1;
      node.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
      node.removeEventListener('focusout', onFocusOut);
      report(false);
    };
    // `keys` reads the latest host and id; the effect is the panel's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // A menu opens once the page's picture is in place, so the page never covers it
  const openMenu = (which: 'main' | 'zoom', open: boolean) => {
    if (!open) {
      setMenu('');
      return;
    }
    if (!active.current || frozenRef.current) {
      setMenu(which);
      return;
    }
    let done = false;
    const show = () => {
      if (done) return;
      done = true;
      setMenu(which);
    };
    setTimeout(show, 400);
    void Promise.resolve(host.browserPage?.(id, 'snapshot'))
      .catch(() => null)
      .then((picture) => {
        if (!done && typeof picture === 'string') setFrozenPicture(picture);
        show();
      });
  };
  const pageAddress = () => {
    const value = state?.failure?.url ?? state?.url ?? '';
    return value === 'about:blank' ? '' : value;
  };
  const connection = connectionKind(state);
  const parts = addressParts(url);
  const showingAddress = !addressFocused && !!url && url === pageAddress();
  const zoomRow = (
    <div className="browser-zoom-row" role="group" aria-label={t('zoom')}>
      <span className="browser-zoom-label">{t('zoom')}</span>
      <DropdownMenu.Item
        className="browser-zoom-step"
        aria-label={t('zoom out')}
        title={t('zoom out')}
        onSelect={(event) => {
          event.preventDefault();
          zoom('out');
        }}
      >
        <Minus size={14} />
      </DropdownMenu.Item>
      <DropdownMenu.Item
        className="browser-zoom-value"
        aria-label={t('reset zoom')}
        title={t('reset zoom')}
        onSelect={(event) => {
          event.preventDefault();
          zoom('reset');
        }}
      >
        {zoomLevel}%
      </DropdownMenu.Item>
      <DropdownMenu.Item
        className="browser-zoom-step"
        aria-label={t('zoom in')}
        title={t('zoom in')}
        onSelect={(event) => {
          event.preventDefault();
          zoom('in');
        }}
      >
        <Plus size={14} />
      </DropdownMenu.Item>
    </div>
  );
  const pageReady = opened && !failure && !dialog;
  // The ring stays on for the whole time Circle's turn is using the browser,
  // not only during the action that is on screen now.
  const ring = browserRing({
    control: state?.control,
    operating: state?.operating,
    sessionState: session.state,
    turnStarted: session.turn !== undefined,
    tools: currentTurnTools(visibleMessages(session)),
  });
  // Pointing at the page is the person's turn to give it: not while Circle works in it,
  // not on a page that is not there, and not while Chromium holds its debugger.
  const pickable = canPick({
    ring,
    opened,
    failure,
    warning: state?.warning,
    dialog,
    chooser: state?.chooser,
    devTools: state?.devTools,
  });
  // The picture fills the box it is drawn in, so the page's own CSS pixels are that box's
  // percentages: the ring stays on its element as the panel is resized.
  const hoverBox = pickBox(hover?.element);
  const hoverStyle =
    hoverBox && pick && pick.width >= 1 && pick.height >= 1
      ? {
          left: `${(hoverBox.left / pick.width) * 100}%`,
          top: `${(hoverBox.top / pick.height) * 100}%`,
          width: `${(hoverBox.width / pick.width) * 100}%`,
          height: `${(hoverBox.height / pick.height) * 100}%`,
        }
      : undefined;
  const controlLabel =
    ring === 'user'
      ? t('you have the browser')
      : ring === 'pending'
        ? t('Waiting for Circle to stop…')
        : ring === 'awaiting'
          ? t('Waiting for your approval')
          : ring === 'driving'
            ? t('Circle is operating')
            : undefined;
  const findCount =
    state?.find && state.find.text === findText ? state.find : undefined;
  return (
    // One column the height of the panel: the page takes what the bars leave
    <div ref={root} className="native-browser" onKeyDown={onKeys}>
      {(state?.tabs?.length ?? 0) > 1 && (
        <div className="browser-tabs" role="tablist">
          {state?.tabs?.length ? (
            state.tabs.map((tab) => (
              <div
                key={tab.id}
                className={`browser-tab${tab.active ? ' active' : ''}`}
                role="tab"
                aria-selected={tab.active}
                title={tabTitle(tab)}
                // The middle button closes a tab, as in Chrome
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault();
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  void tabs('close', tab.id);
                }}
              >
                <button
                  className="browser-tab-title"
                  onClick={() => void tabs('select', tab.id)}
                >
                  {state.dialogs?.some((dialog) => dialog.tab === tab.id) && (
                    <i className="browser-tab-alert" />
                  )}
                  <span className="browser-tab-icon" aria-hidden="true">
                    {tab.loading && tab.url && tab.url !== 'about:blank' ? (
                      <LoaderCircle size={13} className="browser-tab-spinner" />
                    ) : tab.favicon ? (
                      <img src={tab.favicon} alt="" width={14} height={14} />
                    ) : (
                      <Globe size={13} />
                    )}
                  </span>
                  <span className="browser-tab-text">{tabTitle(tab)}</span>
                </button>
                <IconButton
                  label={t('close tab')}
                  onClick={() => void tabs('close', tab.id)}
                >
                  <X size={12} />
                </IconButton>
              </div>
            ))
          ) : (
            // Before the page is made, the one tab it will open in
            <div className="browser-tab active" role="tab" aria-selected>
              <span className="browser-tab-title">
                <span className="browser-tab-icon" aria-hidden="true">
                  <Globe size={13} />
                </span>
                <span className="browser-tab-text">{t('new tab')}</span>
              </span>
            </div>
          )}
          <IconButton
            label={t('new tab')}
            onClick={() => void tabs('new').then(focusAddress)}
          >
            <Plus size={14} />
          </IconButton>
        </div>
      )}
      <div className="browser-address">
        <IconButton
          label={t('go back')}
          disabled={!state?.canGoBack}
          onClick={() => void navigate('back')}
        >
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton
          label={t('go forward')}
          disabled={!state?.canGoForward}
          onClick={() => void navigate('forward')}
        >
          <ArrowRight size={14} />
        </IconButton>
        {loading ? (
          <IconButton label={t('stop loading')} onClick={() => run('stop')}>
            <X size={14} />
          </IconButton>
        ) : (
          <IconButton
            label={t('reload page')}
            disabled={!opened}
            onClick={() => void navigate('reload')}
          >
            <RotateCw size={13} />
          </IconButton>
        )}
        <div className="browser-url">
          {connection === 'warning' ? (
            <span className="browser-insecure" data-testid="browser-warning">
              <ShieldAlert size={13} />
              {t('certificate error')}
            </span>
          ) : connection === 'insecure' ? (
            <span className="browser-insecure" data-testid="browser-insecure">
              <ShieldAlert size={13} />
              {t('not secure')}
            </span>
          ) : connection === 'http' ? (
            <span className="browser-not-secure" data-testid="browser-http">
              <ShieldAlert size={13} />
              {t('not secure')}
            </span>
          ) : connection === 'https' ? (
            <span
              className="browser-secure"
              data-testid="browser-secure"
              role="img"
              aria-label={t('connection is secure')}
              title={t('connection is secure')}
            >
              <Lock size={12} />
            </span>
          ) : null}
          <div
            className={`browser-url-field${showingAddress ? ' display' : ''}`}
          >
            <input
              ref={address}
              aria-label={t('browser address')}
              value={url}
              placeholder={t('type a URL')}
              spellCheck={false}
              onChange={(event) => {
                editingAddress.current = true;
                setUrl(event.target.value);
              }}
              onFocus={(event) => {
                setAddressFocused(true);
                selectOnMouseUp.current = true;
                event.currentTarget.select();
              }}
              onMouseUp={(event) => {
                // The click that focused the field keeps the whole address selected
                if (selectOnMouseUp.current) event.preventDefault();
                selectOnMouseUp.current = false;
              }}
              onBlur={() => {
                setAddressFocused(false);
                selectOnMouseUp.current = false;
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  const field = event.currentTarget;
                  const typed = field.value;
                  // Blurring while Enter is still down hands the keyboard back to
                  // the panel button that opened the browser, and that button
                  // closes the panel before the page loads.
                  window.setTimeout(() => {
                    if (document.activeElement === field) field.blur();
                  }, 0);
                  void navigate(typed);
                } else if (event.key === 'Escape') {
                  // As in Chrome: the page's own address again, and the field let go
                  event.preventDefault();
                  event.stopPropagation();
                  editingAddress.current = false;
                  setUrl(pageAddress());
                  event.currentTarget.blur();
                }
              }}
            />
            {showingAddress && (
              <span className="browser-url-display" aria-hidden="true">
                {parts.host && <b>{parts.host}</b>}
                <span>{parts.rest}</span>
              </span>
            )}
          </div>
          {zoomLevel !== 100 && (
            <DropdownMenu.Root
              open={menu === 'zoom'}
              onOpenChange={(open) => openMenu('zoom', open)}
            >
              <DropdownMenu.Trigger asChild>
                <button
                  className="icon-button browser-zoom-indicator"
                  aria-label={t('zoom {percent}%', { percent: zoomLevel })}
                  title={t('zoom {percent}%', { percent: zoomLevel })}
                >
                  {zoomLevel > 100 ? (
                    <ZoomIn size={13} />
                  ) : (
                    <ZoomOut size={13} />
                  )}
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="dropdown browser-menu"
                  align="end"
                  sideOffset={6}
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  {zoomRow}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
          {finding && (
            // Chrome's find bar, over the end of the address bar: the page keeps its size
            <div
              className="browser-find"
              role="search"
              aria-label={t('find in page')}
            >
              <input
                ref={findField}
                aria-label={t('find in page')}
                placeholder={t('find in page')}
                value={findText}
                spellCheck={false}
                onChange={(event) => {
                  setFindText(event.target.value);
                  find(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (findText) find(findText, !event.shiftKey);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    closeFind();
                  }
                }}
              />
              <span
                className="browser-find-count"
                data-testid="browser-find-count"
                aria-label={
                  findCount
                    ? t('{active} of {matches}', {
                        active: findCount.active,
                        matches: findCount.matches,
                      })
                    : undefined
                }
              >
                {findCount ? `${findCount.active}/${findCount.matches}` : ''}
              </span>
              <IconButton
                label={t('previous match')}
                disabled={!findText}
                onClick={() => find(findText, false)}
              >
                <ChevronUp size={14} />
              </IconButton>
              <IconButton
                label={t('next match')}
                disabled={!findText}
                onClick={() => find(findText, true)}
              >
                <ChevronDown size={14} />
              </IconButton>
              <IconButton label={t('close find bar')} onClick={closeFind}>
                <X size={13} />
              </IconButton>
            </div>
          )}
        </div>
        {ring === 'driving' && (
          <Button onClick={() => void host.browserControl(id, 'take')}>
            {t('take over')}
          </Button>
        )}
        <DropdownMenu.Root
          open={menu === 'main'}
          onOpenChange={(open) => openMenu('main', open)}
        >
          <DropdownMenu.Trigger asChild>
            <button className="icon-button" aria-label={t('browser menu')}>
              <EllipsisVertical size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="dropdown app-menu browser-menu"
              align="end"
              sideOffset={6}
              // What an item focuses (the address, the find field) keeps the keyboard
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <DropdownMenu.Item
                onSelect={() => void tabs('new').then(focusAddress)}
              >
                <span>{t('new tab')}</span>
                <kbd aria-hidden="true">{formatChord('mod+t')}</kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="dropdown-separator" />
              {zoomRow}
              <DropdownMenu.Separator className="dropdown-separator" />
              <DropdownMenu.Item disabled={!pageReady} onSelect={openFind}>
                <span>{t('find…')}</span>
                <kbd aria-hidden="true">{formatChord('mod+f')}</kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={!pageReady}
                onSelect={captureBrowser}
              >
                {t('take page screenshot')}
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={!pickable} onSelect={startPick}>
                {t('pick element')}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={!opened}
                onSelect={() => void page('devtools')}
              >
                <span>
                  {state?.devTools
                    ? t('close developer tools')
                    : t('developer tools')}
                </span>
                <kbd aria-hidden="true">
                  {platform() === 'darwin'
                    ? formatChord('alt+mod+i')
                    : formatChord('ctrl+shift+i')}
                </kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="dropdown-separator" />
              <DropdownMenu.Item
                disabled={!state?.tab}
                onSelect={() => run('close-tab')}
              >
                <span>{t('close tab')}</span>
                <kbd aria-hidden="true">{formatChord('mod+w')}</kbd>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <ModeButtons popOut />
      </div>
      <div
        className={`native-browser-frame${
          ring === 'driving' || ring === 'pending' ? ' driving' : ''
        }${ring === 'awaiting' ? ' awaiting' : ''}`}
        data-testid={
          ring === 'user'
            ? 'browser-user'
            : ring === 'pending'
              ? 'browser-pending'
              : ring === 'driving'
                ? 'browser-operating'
                : ring === 'awaiting'
                  ? 'browser-awaiting'
                  : 'browser-frame'
        }
        role={controlLabel ? 'region' : undefined}
        aria-label={controlLabel}
        title={controlLabel}
      >
        <div className="native-browser-viewport" ref={viewport}>
          {dialog ? (
            <BrowserDialogPanel sessionId={id} dialog={dialog} />
          ) : choice ? (
            <CertificateChoicePanel sessionId={id} choice={choice} />
          ) : failure ? (
            <div
              className="browser-error-page"
              data-testid="browser-load-failure"
            >
              <Globe size={30} />
              <h3>{t('cannot reach this site')}</h3>
              <p>{failure.url}</p>
              <code>{failure.error}</code>
              <Button onClick={() => void navigate(failure.url)}>
                {t('reload page')}
              </Button>
            </div>
          ) : !opened ? (
            <PaneEmpty icon={Globe} className="browser-empty" title={t('web')}>
              <p>{t('browse and control pages in the built-in browser')}</p>
            </PaneEmpty>
          ) : pick ? (
            // The page, as a picture the person points at: what is under the cursor is
            // ringed, and the click that commits asks the page what it really is.
            <div
              ref={pickLayer}
              className="browser-pick"
              data-testid="browser-pick"
              role="application"
              aria-label={t('pick an element')}
              tabIndex={-1}
            >
              {/* The picture takes the pointing, so the bar over it stays clickable. */}
              <img
                className="browser-pick-picture"
                src={pick.dataUrl}
                alt=""
                draggable={false}
                onMouseDown={(event) => {
                  // Pointing keeps the picture's keyboard, so esc keeps stopping it.
                  event.preventDefault();
                  pickLayer.current?.focus();
                }}
                onMouseMove={(event) => {
                  const point = pointInPage(event.clientX, event.clientY);
                  if (point) lookAt(point);
                }}
                onMouseLeave={() => {
                  hoverPoint.current = null;
                  setHover(null);
                }}
                onClick={(event) => {
                  const point = pointInPage(event.clientX, event.clientY);
                  if (point) pickHere(point);
                }}
              />
              {hoverStyle && (
                <div
                  className="browser-pick-box"
                  data-testid="browser-pick-box"
                  style={hoverStyle}
                />
              )}
              <div className="browser-pick-hint">
                <Crosshair size={13} />
                <span data-testid="browser-pick-label">
                  {hover
                    ? pickLabel(hover.element)
                    : t('click an element to add it to your message')}
                </span>
                <IconButton label={t('stop picking')} onClick={stopPick}>
                  <X size={13} />
                </IconButton>
              </div>
            </div>
          ) : frozen ? (
            <img className="browser-frozen" src={frozen} alt="" />
          ) : null}
        </div>
      </div>
      {state?.chooser && (
        // A click of Circle's opened the page's file chooser: either of you can answer it
        <div className="browser-chooser" data-testid="browser-chooser">
          <FileUp size={14} />
          <span>
            {state.chooser.multiple
              ? t('The page asks for files')
              : t('The page asks for a file')}
          </span>
          <Button
            onClick={() =>
              void host
                .browserChoose(id, state.chooser!.id)
                .catch(() => notify(t('the files could not be given')))
            }
          >
            {t('choose…')}
          </Button>
        </div>
      )}
      {state?.permissions?.map((request) => (
        // The page asks as it would in a browser: only the person answers
        <div
          key={request.id}
          className="browser-chooser"
          data-testid="browser-permission"
        >
          <ShieldQuestion size={14} />
          <span>
            {t('{site} wants to {what}', {
              site: request.origin,
              what: permissionText(request.kinds),
            })}
          </span>
          <Button
            onClick={() =>
              void host.browserPermission(id, request.id, false).catch(() => {})
            }
          >
            {t('block')}
          </Button>
          <Button
            className="primary"
            onClick={() =>
              void host.browserPermission(id, request.id, true).catch(() => {})
            }
          >
            {t('allow')}
          </Button>
        </div>
      ))}
      {!!state?.downloads?.length && (
        <ul className="browser-downloads" data-testid="browser-downloads">
          {[...state.downloads].reverse().map((download) => (
            <li key={download.id}>
              <Download size={13} />
              <span className="browser-download-name">{download.name}</span>
              <span className="browser-download-state">
                {download.state === 'failed'
                  ? t('failed')
                  : download.state === 'waiting'
                    ? t('waiting for approval')
                    : downloadProgress(download)}
              </span>
              {download.state === 'waiting' && (
                // Circle's turn may have ended before it could ask: the person decides here
                <>
                  <Button
                    onClick={() =>
                      void host
                        .browserKeepDownload(id, download.id, false)
                        .catch(() => {})
                    }
                  >
                    {t('discard')}
                  </Button>
                  <Button
                    onClick={() =>
                      void host
                        .browserKeepDownload(id, download.id, true)
                        .catch(() => {})
                    }
                  >
                    {t('keep')}
                  </Button>
                </>
              )}
              {download.state === 'done' && (
                <IconButton
                  label={t('show in folder')}
                  onClick={() => void host.browserReveal(id, download.id)}
                >
                  <FolderOpen size={13} />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
