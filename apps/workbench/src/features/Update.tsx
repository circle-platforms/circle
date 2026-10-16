import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, RotateCw } from 'lucide-react';
import type { UpdateAction, UpdateState } from '../../../desktop/src/contracts';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import { Button } from '../components/common';
import { t } from '../i18n';
import { updateActions } from './update-actions';

export { updateActions };

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

function sandboxCommands(folder: string): string {
  const path = `${folder}/chrome-sandbox`;
  return `sudo chown root:root ${path}\nsudo chmod 4755 ${path}`;
}

function LinuxGuide({
  folder,
  sandbox,
  manual,
  after,
}: {
  folder: string;
  sandbox: boolean;
  manual: boolean;
  after?: boolean;
}) {
  const commands = sandboxCommands(folder);
  if (after)
    return (
      <div className="linux-update-steps">
        <p>
          {t(
            'Circle was updated. Give chrome-sandbox to root again, or it will not start:',
          )}
        </p>
        <pre>{commands}</pre>
      </div>
    );
  if (!manual)
    return sandbox ? (
      <div className="linux-update-steps">
        <p>
          {t(
            'This copy will quit and replace {folder}. It will not start again until chrome-sandbox belongs to root.',
            { folder },
          )}
        </p>
        <pre>{commands}</pre>
      </div>
    ) : null;
  return (
    <ol className="linux-update-steps">
      <li>{t('Quit Circle before replacing it.')}</li>
      <li>
        {t(
          'Delete the old Circle-linux folder, then unpack. The archive always creates that folder, so unpacking beside it collides, and unpacking onto the old files drops setuid.',
        )}
      </li>
      {sandbox && (
        <li>
          {t('Give chrome-sandbox to root again, or Circle will not start:')}
          <pre>{commands}</pre>
        </li>
      )}
      <li>{t('Then start Circle.')}</li>
    </ol>
  );
}

/** The two commands, in a dialog, before a setuid copy quits to replace itself. */
function ReplaceConfirm({
  folder,
  onCancel,
  onConfirm,
}: {
  folder: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="linux-replace-backdrop">
      <div
        className="linux-replace-dialog"
        role="dialog"
        aria-labelledby="linux-replace-title"
      >
        <h3 id="linux-replace-title">{t('quit and replace')}</h3>
        <p>
          {t(
            'This copy will quit and replace {folder}. It will not start again until chrome-sandbox belongs to root.',
            { folder },
          )}
        </p>
        <pre>{sandboxCommands(folder)}</pre>
        <div className="linux-replace-actions">
          <Button onClick={onCancel}>{t('cancel')}</Button>
          <Button className="primary" onClick={onConfirm}>
            {t('quit and replace')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Settings → about: what the check found and the one step that comes next. */
export function UpdateControl() {
  const { state, act } = useUpdate();
  const { notify } = useRuntime();
  const [confirming, setConfirming] = useState(false);
  if (!state) return null;
  const actions = updateActions(state);
  const openPage = (page: string) => {
    notify(t('opened the release page in your browser'));
    window.open(page, '_blank');
  };
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
      {'linux' in state &&
        state.linux &&
        (actions.page || state.linux.sandbox) && (
          <LinuxGuide
            folder={state.linux.folder}
            sandbox={state.linux.sandbox}
            manual={actions.page}
            after={state.phase === 'current'}
          />
        )}
      {actions.page && 'page' in state && state.page && (
        <Button
          onClick={() => {
            if ('page' in state && state.page) openPage(state.page);
          }}
        >
          {t('open release page')}
        </Button>
      )}
      {actions.download && (
        <Button className="primary" onClick={() => act('download')}>
          {t('update')}
        </Button>
      )}
      {actions.install && (
        <Button
          className="primary"
          onClick={() => {
            if ('linux' in state && state.linux?.sandbox) setConfirming(true);
            else act('install');
          }}
        >
          {'linux' in state && state.linux?.sandbox
            ? t('quit and replace')
            : t('restart to update')}
        </Button>
      )}
      {actions.retry && (
        <Button onClick={() => act('download')}>{t('try again')}</Button>
      )}
      {actions.check && (
        <Button
          disabled={state.phase === 'checking'}
          onClick={() => act('check')}
        >
          {t('check now')}
        </Button>
      )}
      {confirming && 'linux' in state && state.linux?.sandbox && (
        <ReplaceConfirm
          folder={state.linux.folder}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            act('install');
          }}
        />
      )}
    </div>
  );
}

/** The foot of the sidebar: a found update, how far its download is, and the restart. */
export function UpdateChip() {
  const { state, act } = useUpdate();
  const { notify } = useRuntime();
  const [confirming, setConfirming] = useState(false);
  const told = useRef(false);
  useEffect(() => {
    if (state?.phase === 'current' && state.updated && !told.current) {
      told.current = true;
      const version = state.updated;
      if (state.linux?.sandbox) {
        notify(
          t(
            'Circle was updated to {version}. Give chrome-sandbox to root again, or it will not start:',
            { version },
          ),
        );
        notify(sandboxCommands(state.linux.folder));
      } else notify(t('Circle was updated to {version}', { version }));
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
          ? state.linux?.sandbox
            ? t('quit and replace')
            : t('restart to update')
          : t('restarting…');
  return (
    <>
      <button
        className="update-chip"
        data-phase={state.phase}
        disabled={state.phase === 'downloading' || state.phase === 'installing'}
        onClick={() => {
          if (state.phase === 'available' && state.page) {
            notify(t('opened the release page in your browser'));
            window.open(state.page, '_blank');
          } else if (state.phase === 'available') act('download');
          else if (state.phase === 'ready' && state.linux?.sandbox)
            setConfirming(true);
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
      {confirming && state?.phase === 'ready' && state.linux?.sandbox && (
        <ReplaceConfirm
          folder={state.linux.folder}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            act('install');
          }}
        />
      )}
    </>
  );
}
