import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Camera,
  Download,
  FileUp,
  FolderOpen,
  Globe,
  Plus,
  RotateCw,
  ShieldAlert,
  X,
} from 'lucide-react';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import {
  browserEventAddress,
  browserOpened,
  downloadProgress,
  shownDialog,
} from '../model/browser';
import { useBrowserState } from './useBrowserState';
import type { BrowserCapture } from '../../../desktop/src/contracts';
import { Button, IconButton, Status } from '../components/common';
import { BrowserDialogPanel } from './BrowserDialog';
import { t } from '../i18n';

export function NativeBrowser() {
  const { snapshot, notify } = useRuntime();
  const id = currentSession(snapshot).id;
  const state = useBrowserState(id);
  const [url, setUrl] = useState('');
  const [capture, setCapture] = useState<BrowserCapture | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  const wasOpened = useRef(false);
  const editingAddress = useRef(false);
  const updateBounds = useRef<() => void>(() => {});
  const host = desktopHost()!;
  const opened = browserOpened(state);
  const dialog = shownDialog(state);
  useEffect(() => {
    active.current = false;
    wasOpened.current = false;
    editingAddress.current = false;
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
      void host.browserHide(id);
    };
  }, [id]);
  // The page's own view shows once a page is open; it follows the shown tab.
  useEffect(() => {
    if (!state) return;
    if (opened !== active.current) {
      active.current = opened;
      requestAnimationFrame(() => updateBounds.current());
    }
    const address = browserEventAddress(
      state,
      editingAddress.current,
      wasOpened.current,
    );
    if (address !== undefined) setUrl(address);
    wasOpened.current = wasOpened.current || opened;
  }, [state, opened]);
  const navigate = async (target: string) => {
    editingAddress.current = false;
    try {
      active.current = true;
      setCapture(null);
      await host.browserNavigate(id, target);
      requestAnimationFrame(() => updateBounds.current());
    } catch {
      if (!['back', 'forward', 'reload'].includes(target)) {
        setUrl(target);
        editingAddress.current = true;
      }
      notify(t('navigation failed'));
    }
  };
  const tabs = (action: 'new' | 'select' | 'close', tab?: string) =>
    void host
      .browserTabs(id, action, tab)
      .then(() => requestAnimationFrame(() => updateBounds.current()))
      .catch(() => notify(t('navigation failed')));
  const failure = state?.failure;
  return (
    <>
      {!!state?.tabs?.length && (
        <div className="browser-tabs" role="tablist">
          {state.tabs.map((tab) => (
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
                {tab.title ||
                  (tab.url && tab.url !== 'about:blank'
                    ? tab.url
                    : t('new tab'))}
              </button>
              <IconButton
                label={t('close tab')}
                onClick={() => tabs('close', tab.id)}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
          <IconButton label={t('new tab')} onClick={() => tabs('new')}>
            <Plus size={13} />
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
        <IconButton
          label={t('reload page')}
          disabled={!opened}
          onClick={() => void navigate('reload')}
        >
          <RotateCw size={13} />
        </IconButton>
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
        ) : (
          <Globe size={13} />
        )}
        <input
          aria-label={t('browser address')}
          value={url}
          placeholder="https://…"
          onChange={(event) => {
            editingAddress.current = true;
            setUrl(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void navigate(url);
          }}
        />
        <IconButton
          label={t('navigate browser')}
          onClick={() => void navigate(url)}
        >
          <ArrowUpRight size={14} />
        </IconButton>
      </div>
      <div className="native-browser-viewport" ref={viewport}>
        {dialog ? (
          <BrowserDialogPanel sessionId={id} dialog={dialog} />
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
            <Globe size={30} />
            <h3>{t('open a page')}</h3>
            <p>
              {t('A sandboxed native browser belongs to this Circle session.')}
            </p>
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
      <div className="native-browser-footer">
        {state?.operating ? (
          <span className="browser-operating" data-testid="browser-operating">
            <span className="browser-operation-dot" />
            {t('Circle is operating')}
          </span>
        ) : (
          <Status value={opened ? 'native browser' : 'not opened'} />
        )}
        <code>
          {(state?.sessionId ?? 'browser:' + id) +
            (state?.tab ? ' · ' + state.tab : '')}
        </code>
        <IconButton
          label={t('capture browser')}
          disabled={!opened || !!failure || !!dialog}
          onClick={() =>
            void host.browserCapture(id).then(
              (value) => setCapture(value),
              () => notify(t('browser capture failed')),
            )
          }
        >
          <Camera size={14} />
        </IconButton>
      </div>
      {!!state?.downloads?.length && (
        <ul className="browser-downloads" data-testid="browser-downloads">
          {[...state.downloads].reverse().map((download) => (
            <li key={download.id}>
              <Download size={13} />
              <span className="browser-download-name">{download.name}</span>
              <span className="browser-download-state">
                {download.state === 'failed'
                  ? t('failed')
                  : downloadProgress(download)}
              </span>
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
    </>
  );
}
