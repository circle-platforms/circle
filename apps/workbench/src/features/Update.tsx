import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, RotateCw } from 'lucide-react';
import type { UpdateAction, UpdateState } from '../../../desktop/src/contracts';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import { Button } from '../components/common';
import { t } from '../i18n';

/** The application's own update, from the desktop host; null in the browser preview. */
export function useUpdate(): {
  state: UpdateState | null;
  act: (action: UpdateAction) => void;
} {
  const host = desktopHost();
  const { perform } = useRuntime();
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!host?.updateState) return;
    let live = true;
    void host.updateState().then((value) => live && setState(value));
    const stop = host.onUpdate((value) => setState(value));
    return () => {
      live = false;
      stop();
    };
  }, [host]);
  return {
    state: host?.updateState ? state : null,
    act: (action) =>
      perform(async () => {
        setState(await host!.update(action));
      }),
  };
}

const percent = (state: { received: number; total: number }) =>
  state.total ? Math.floor((state.received * 100) / state.total) : 0;
const openPage = (page: string) => window.open(page, '_blank');

/** Settings → about: what the check found and the one step that comes next. */
export function UpdateControl() {
  const { state, act } = useUpdate();
  if (!state) return null;
  const line =
    state.phase === 'checking'
      ? t('checking…')
      : state.phase === 'current'
        ? state.updated
          ? t('Circle was updated to {version}', { version: state.updated })
          : t('Circle is up to date')
        : state.phase === 'available'
          ? t('Circle {version} is available', { version: state.version })
          : state.phase === 'downloading'
            ? t('downloading Circle {version} · {percent}%', {
                version: state.version,
                percent: percent(state),
              })
            : state.phase === 'ready'
              ? t('Circle {version} is ready to install', {
                  version: state.version,
                })
              : state.phase === 'installing'
                ? t('restarting…')
                : state.phase === 'failed'
                  ? t('update failed: {error}', { error: state.error })
                  : '';
  return (
    <div className="update-control" data-phase={state.phase}>
      {line && (
        <span className="update-line" role="status">
          {line}
        </span>
      )}
      {state.phase === 'downloading' && (
        <progress max={100} value={percent(state)} aria-hidden />
      )}
      {(state.phase === 'available' || state.phase === 'failed') &&
        state.page && (
          <Button onClick={() => openPage(state.page!)}>{t('download')}</Button>
        )}
      {state.phase === 'available' && !state.page && (
        <Button className="primary" onClick={() => act('download')}>
          {t('update')}
        </Button>
      )}
      {state.phase === 'ready' && (
        <Button className="primary" onClick={() => act('install')}>
          {t('restart to update')}
        </Button>
      )}
      {state.phase === 'failed' && state.version && !state.page && (
        <Button onClick={() => act('download')}>{t('try again')}</Button>
      )}
      {['idle', 'current', 'failed', 'checking'].includes(state.phase) && (
        <Button
          disabled={state.phase === 'checking'}
          onClick={() => act('check')}
        >
          {t('check now')}
        </Button>
      )}
    </div>
  );
}

/** The foot of the sidebar: a found update, how far its download is, and the restart. */
export function UpdateChip() {
  const { state, act } = useUpdate();
  const { notify } = useRuntime();
  const told = useRef(false);
  useEffect(() => {
    if (state?.phase === 'current' && state.updated && !told.current) {
      told.current = true;
      notify(t('Circle was updated to {version}', { version: state.updated }));
    }
  }, [state, notify]);
  if (
    !state ||
    !['available', 'downloading', 'ready', 'installing'].includes(state.phase)
  )
    return null;
  const label =
    state.phase === 'available'
      ? t('update to {version}', { version: state.version })
      : state.phase === 'downloading'
        ? t('downloading {percent}%', { percent: percent(state) })
        : state.phase === 'ready'
          ? t('restart to update')
          : t('restarting…');
  return (
    <button
      className="update-chip"
      data-phase={state.phase}
      disabled={state.phase === 'downloading' || state.phase === 'installing'}
      onClick={() => {
        if (state.phase === 'available' && state.page) openPage(state.page);
        else if (state.phase === 'available') act('download');
        else if (state.phase === 'ready') act('install');
      }}
    >
      {state.phase === 'ready' ? (
        <RotateCw size={14} />
      ) : (
        <ArrowDownToLine size={14} />
      )}
      <span>{label}</span>
    </button>
  );
}
