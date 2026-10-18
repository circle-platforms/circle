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
  BrowserTab,
} from '../../../desktop/src/contracts';
import {
  browserShortcut,
  type BrowserKeyAction,
} from '../../../desktop/src/browser-controls';
import { Button, IconButton } from '../components/common';
import { BrowserDialogPanel, CertificateChoicePanel } from './BrowserDialog';
import { t } from '../i18n';

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

const platform = () =>
  document.documentElement.dataset.desktop ??
  (/Mac/.test(navigator.platform) ? 'darwin' : 'other');

const isField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest('input, textarea, select, [contenteditable="true"]');

/** `whole` and the rest: the inspector's full view, which the browser's menu also offers. */
export function NativeBrowser({
  target,
  whole,
  canBeWhole,
  onWhole,
}: {
  target?: string;
  whole?: boolean;
  canBeWhole?: boolean;
  onWhole?: () => void;
} = {}) {
  const { snapshot, notify } = useRuntime();
  const session = currentSession(snapshot);
  const id = session.id;
  const state = useBrowserState(id);
  const [url, setUrl] = useState('');
  const [addressFocused, setAddressFocused] = useState(false);
  const [capture, setCapture] = useState<BrowserCapture | null>(null);
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
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const findField = useRef<HTMLInputElement>(null);
  const active = useRef(false);
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
    wasOpened.current = false;
    editingAddress.current = false;
    addressTab.current = undefined;
    navigationVersion.current++;
    setUrl('');
    setCapture(null);
    setFrozenPicture(null);
    let froze = false;
    let freezing = false;
    let disposed = false;
    const update = () => {
      const node = viewport.current;
      const rect = node ? laidOutBrowserViewport(node) : null;
      // Hidden, collapsed, zero-size, or a drawer mode that folds the page: the
      // native view must leave the window. Returning here used to keep the last
      // WebContentsView painted on top. Native surfaces do not inherit DOM
      // visibility, so also release the page's keyboard ownership while
      // retaining its tab and session.
      if (disposed || !node || !rect) {
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
      const visible = shown && !menuOpen;
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
      void host
        .browserBounds(
          id,
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible,
        )
        .then(() => {
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
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
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
    update();
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      dialogs.disconnect();
      seen.disconnect();
      removeEventListener('resize', schedule);
      removeEventListener('scroll', schedule, true);
      captureGeneration.current++;
      void host.browserHide(id);
      void Promise.resolve(host.browserPage?.(id, 'keys', false)).catch(
        () => {},
      );
    };
  }, [id]);
  // Full view moves the same panel to another box. Measure after that move.
  useEffect(() => {
    const frame = requestAnimationFrame(() => updateBounds.current());
    return () => cancelAnimationFrame(frame);
  }, [whole]);
  useEffect(() => {
    setCapture(null);
  }, [id, state?.tab, state?.url]);
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
        if (current()) setCapture(value);
      },
      () => {
        if (current()) notify(t('browser capture failed'));
      },
    );
  };
  // The page's own view shows once a page is open; it follows the shown tab.
  useEffect(() => {
    if (!state) return;
    const tabChanged = browserTabChanged(addressTab.current, state.tab);
    if (tabChanged) {
      editingAddress.current = false;
      wasOpened.current = false;
      setCapture(null);
      setFinding(false);
    }
    addressTab.current = state.tab;
    if (opened !== active.current) {
      active.current = opened;
      requestAnimationFrame(() => updateBounds.current());
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
    editingAddress.current = false;
    setNavigating((count) => count + 1);
    try {
      active.current = true;
      setCapture(null);
      await host.browserNavigate(id, target);
      requestAnimationFrame(() => updateBounds.current());
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
  }, [target, id]);
  const tabs = (action: 'new' | 'select' | 'close', tab?: string) =>
    host
      .browserTabs(id, action, tab)
      .then(() => {
        requestAnimationFrame(() => updateBounds.current());
      })
      .catch(() => notify(t('navigation failed')));
  const page = (
    action:
      'stop' | 'zoom' | 'find' | 'find-stop' | 'tab' | 'devtools' | 'inspect',
    value?: unknown,
  ) =>
    Promise.resolve(host.browserPage?.(id, action, value))
      .then(() => {
        requestAnimationFrame(() => updateBounds.current());
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
  // `tab`: the tab whose page had the keyboard, for a key pressed in the page
  const run = (action: BrowserKeyAction, tab = state?.tab) => {
    if (action === 'address') focusAddress();
    else if (action === 'new-tab') void tabs('new').then(focusAddress);
    else if (action === 'close-tab') {
      if (tab) void tabs('close', tab);
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
    tools: currentTurnTools(visibleMessages(session)),
  });
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
                <kbd aria-hidden="true">{formatChord('ctrl+t')}</kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="dropdown-separator" />
              {zoomRow}
              <DropdownMenu.Separator className="dropdown-separator" />
              <DropdownMenu.Item disabled={!pageReady} onSelect={openFind}>
                <span>{t('find…')}</span>
                <kbd aria-hidden="true">{formatChord('ctrl+f')}</kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={!pageReady}
                onSelect={captureBrowser}
              >
                {t('take screenshot')}
              </DropdownMenu.Item>
              {canBeWhole && onWhole && (
                <DropdownMenu.Item onSelect={onWhole}>
                  {whole ? t('exit full view') : t('full view')}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator className="dropdown-separator" />
              {(ring === 'driving' || ring === 'awaiting') && (
                <DropdownMenu.Item
                  onSelect={() => void host.browserControl(id, 'take')}
                >
                  {t('take over')}
                </DropdownMenu.Item>
              )}
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
                    ? formatChord('alt+ctrl+i')
                    : formatChord('ctrl+shift+i')}
                </kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="dropdown-separator" />
              <DropdownMenu.Item
                disabled={!state?.tab}
                onSelect={() => run('close-tab')}
              >
                <span>{t('close tab')}</span>
                <kbd aria-hidden="true">{formatChord('ctrl+w')}</kbd>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
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
            <div className="browser-empty">
              <Globe size={22} strokeWidth={1.5} />
              <h3>{t('browse the web')}</h3>
              <p>{t('type a URL to open a site.')}</p>
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
      {capture && (
        <details className="context-source">
          <summary>{t('captured observation')}</summary>
          <img
            className="attachment-image"
            src={capture.dataUrl}
            alt={t('browser observation')}
          />
          <code>{capture.sha256}</code>
          <p className="panel-note">{capture.observedAt}</p>
        </details>
      )}
    </div>
  );
}
