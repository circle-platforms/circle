import { BrowserDiagnostics } from './BrowserDiagnostics';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Download,
  FileUp,
  FolderOpen,
  Globe,
  Plus,
  RotateCw,
  ShieldAlert,
  ShieldQuestion,
  X,
} from 'lucide-react';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import {
  browserEventAddress,
  browserOpened,
  browserTabChanged,
  downloadProgress,
  shownDialog,
} from '../model/browser';
import { useBrowserState } from './useBrowserState';
import type {
  BrowserCapture,
  BrowserPermission,
} from '../../../desktop/src/contracts';
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

/** `target`: a link to open as soon as it changes, such as one an extension asked for. */
export function NativeBrowser({ target }: { target?: string } = {}) {
  const { snapshot, notify } = useRuntime();
  const id = currentSession(snapshot).id;
  const state = useBrowserState(id);
  const [url, setUrl] = useState('');
  const [capture, setCapture] = useState<BrowserCapture | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  const wasOpened = useRef(false);
  const editingAddress = useRef(false);
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
  useEffect(() => {
    active.current = false;
    wasOpened.current = false;
    editingAddress.current = false;
    addressTab.current = undefined;
    navigationVersion.current++;
    setUrl('');
    setCapture(null);
    const update = () => {
      const rect = viewport.current?.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) return;
      const ownDialog = viewport.current?.closest('[role="dialog"]');
      const blockingDialog = [
        ...document.querySelectorAll('[role="dialog"]'),
      ].some((dialog) => !dialog.contains(viewport.current));
      const visible =
        active.current &&
        !blockingDialog &&
        ownDialog?.getAttribute('data-state') !== 'closed';
      void host
        .browserBounds(
          id,
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible,
        )
        .catch(() => {});
    };
    updateBounds.current = update;
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    const dialogs = new MutationObserver(update);
    dialogs.observe(document.body, { childList: true, subtree: true });
    addEventListener('resize', update);
    addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      dialogs.disconnect();
      removeEventListener('resize', update);
      removeEventListener('scroll', update, true);
      captureGeneration.current++;
      void host.browserHide(id);
    };
  }, [id]);
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
    }
    addressTab.current = state.tab;
    if (opened !== active.current) {
      active.current = opened;
      requestAnimationFrame(() => updateBounds.current());
    }
    const address = browserEventAddress(
      state,
      editingAddress.current,
      wasOpened.current,
      tabChanged,
    );
    if (address !== undefined) setUrl(address);
    wasOpened.current = wasOpened.current || opened;
  }, [state, opened]);
  const navigate = async (target: string) => {
    const identity = currentIdentity.current;
    const version = ++navigationVersion.current;
    editingAddress.current = false;
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
    void host
      .browserTabs(id, action, tab)
      .then(() => requestAnimationFrame(() => updateBounds.current()))
      .catch(() => notify(t('navigation failed')));
  const failure = state?.failure;
  return (
    // One column the height of the panel: the page takes what the bars leave
    <div className="native-browser">
      <div className="browser-tabs" role="tablist">
        {state?.tabs?.length ? (
          state.tabs.map((tab) => (
            <div
              key={tab.id}
              className={`browser-tab${tab.active ? ' active' : ''}`}
              role="tab"
              aria-selected={tab.active}
              title={tab.url}
            >
              <button
                className="browser-tab-title"
                onClick={() => tabs('select', tab.id)}
              >
                {state.dialogs?.some((dialog) => dialog.tab === tab.id) && (
                  <i className="browser-tab-alert" />
                )}
                {tab.title && tab.title !== 'about:blank'
                  ? tab.title
                  : tab.url && tab.url !== 'about:blank'
                    ? tab.url
                    : t('new tab')}
              </button>
              {state.tabs!.length > 1 && (
                <IconButton
                  label={t('close tab')}
                  onClick={() => tabs('close', tab.id)}
                >
                  <X size={12} />
                </IconButton>
              )}
            </div>
          ))
        ) : (
          // Before the page is made, the one tab it will open in
          <div className="browser-tab active" role="tab" aria-selected>
            <span className="browser-tab-title">{t('new tab')}</span>
          </div>
        )}
        <IconButton label={t('new tab')} onClick={() => tabs('new')}>
          <Plus size={14} />
        </IconButton>
      </div>
      <span className="panel-header-actions">
        <IconButton
          label={t('capture browser')}
          disabled={!opened || !!failure || !!dialog}
          onClick={captureBrowser}
        >
          <Camera size={14} />
        </IconButton>
      </span>
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
        <IconButton
          label={t('reload page')}
          disabled={!opened}
          onClick={() => void navigate('reload')}
        >
          <RotateCw size={13} />
        </IconButton>
        <div className="browser-url">
          {state?.warning ? (
            <span className="browser-insecure" data-testid="browser-warning">
              <ShieldAlert size={13} />
              {t('certificate error')}
            </span>
          ) : state?.insecure ? (
            <span className="browser-insecure" data-testid="browser-insecure">
              <ShieldAlert size={13} />
              {t('not secure')}
            </span>
          ) : null}
          <input
            aria-label={t('browser address')}
            value={url}
            placeholder={t('type a URL')}
            spellCheck={false}
            onChange={(event) => {
              editingAddress.current = true;
              setUrl(event.target.value);
            }}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void navigate(url);
            }}
          />
          <IconButton
            label={t('navigate browser')}
            onClick={() => void navigate(url)}
          >
            <ArrowRight size={13} />
          </IconButton>
        </div>
      </div>
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
        ) : null}
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
      <div className="native-browser-footer">
        {state?.control === 'user' ? (
          // What Circle waits for is said in the conversation, where the person goes on
          <span className="browser-operating" data-testid="browser-user">
            {t('you have the browser')}
          </span>
        ) : state?.control === 'user_pending' ? (
          <span className="browser-operating" data-testid="browser-pending">
            {t('Waiting for Circle to stop…')}
          </span>
        ) : state?.operating ? (
          <span className="browser-operating" data-testid="browser-operating">
            <span className="browser-operation-dot" />
            {t('Circle is operating')}
            <Button onClick={() => void host.browserControl(id, 'take')}>
              {t('take over')}
            </Button>
          </span>
        ) : null}
      </div>
      {opened && (
        <BrowserDiagnostics
          sessionId={id}
          tab={state?.tab}
          url={state?.url ?? url}
        />
      )}
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
