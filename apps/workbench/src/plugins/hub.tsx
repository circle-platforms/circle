import { useEffect, useRef, useState } from 'react';
import { Server } from 'lucide-react';
import { useRuntime } from '../app/context';
import {
  Button,
  DataBlock,
  EmptyState,
  Facts,
  Page,
  Status,
} from '../components/common';
import type { RuntimeExtension } from '../model/types';
import type { WorkbenchPlugin } from './types';
import { t } from '../i18n';

interface HubProjection {
  byteLimit: number;
  shownItems: number;
  omittedItems: number;
  shortenedFields: number;
}

/** A limited projection is still a successful read, with its limits disclosed. */
export function HubProjectionNotice({
  projection,
}: {
  projection?: HubProjection;
}) {
  if (!projection) return null;
  return (
    <div className="panel-note" role="status">
      <p>
        {t(
          'limited view: {shown} shown, {omitted} omitted · {bytes} byte budget',
          {
            shown: projection.shownItems,
            omitted: projection.omittedItems,
            bytes: projection.byteLimit,
          },
        )}
      </p>
      {projection.shortenedFields > 0 && (
        <p>
          {t('{count} text fields shortened', {
            count: projection.shortenedFields,
          })}
        </p>
      )}
      <p>{t('full task details and results remain on hub')}</p>
      <p>{t('counts apply to the records returned by this refresh')}</p>
    </div>
  );
}

// What the bundled hub extension publishes with api.setView.
interface HubView {
  url: string;
  username: string;
  scopeId: string;
  signedIn: boolean;
  following: string[];
  tasks: { taskId: string; title: string; seq: number; saved?: boolean }[];
  recent: string[];
  projection?: HubProjection;
}
export function hubView(
  extensions: readonly RuntimeExtension[],
): HubView | undefined {
  const view = extensions.find((item) => item.name === 'hub')?.view;
  return view && typeof view === 'object' ? (view as HubView) : undefined;
}
const DEFAULT_HUB_URL = 'http://127.0.0.1:7410';
/** The interface half of the hub extension: its commands, as a page. */
export function HubPage() {
  const { snapshot, runtime, perform } = useRuntime();
  const view = hubView(snapshot.extensions);
  const [address, setAddress] = useState(DEFAULT_HUB_URL);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const touched = useRef({ address: false, user: false });
  useEffect(() => {
    if (!view) return;
    if (!touched.current.address && view.url) setAddress(view.url);
    if (!touched.current.user && view.username) setUser(view.username);
  }, [view]);
  // Every action is the extension's own /hub command; its lines go to the conversation.
  const run = (args: string) =>
    perform(async () => {
      await runtime.command('hub', args);
    });
  return (
    <Page
      title={t('hub')}
      description={t(
        'Work handed to a hub from here. The server keeps each task; closing Circle does not stop it.',
      )}
      action={<Button onClick={() => run('tasks')}>{t('refresh')}</Button>}
    >
      {view ? (
        <Facts
          values={{
            [t('server')]: view.url || t('none'),
            [t('user')]: view.username || t('none'),
            [t('project')]: view.scopeId || t('none'),
            [t('state')]: (
              <Status value={view.signedIn ? 'signed in' : 'signed out'} />
            ),
            [t('following')]: view.following.length
              ? view.following.join(', ')
              : t('nothing followed'),
          }}
        />
      ) : (
        <EmptyState title={t('not connected')}>
          {t('The hub extension has published nothing yet.')}
        </EmptyState>
      )}
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!address.trim() || !user.trim() || !password) {
            setError(t('enter the server, user and password'));
            return;
          }
          if (runtime.mode !== 'live') {
            setError(t('sign-in needs the Circle runtime'));
            return;
          }
          const server = address.trim();
          const name = user.trim();
          const secret = password;
          setError('');
          perform(async () => {
            try {
              await runtime.request('extension-command', {
                name: 'hub',
                args: `login ${server} ${name}`,
                secret,
              });
              setPassword('');
            } catch (caught) {
              setError(
                caught instanceof Error ? caught.message : t('sign-in failed'),
              );
            }
          });
        }}
      >
        <label>
          {t('server')}
          <input
            aria-label={t('server')}
            placeholder={DEFAULT_HUB_URL}
            value={address}
            onChange={(event) => {
              touched.current.address = true;
              setAddress(event.target.value);
            }}
          />
        </label>
        <label>
          {t('user')}
          <input
            aria-label={t('user')}
            placeholder={t('user')}
            value={user}
            autoComplete="username"
            onChange={(event) => {
              touched.current.user = true;
              setUser(event.target.value);
            }}
          />
        </label>
        <label>
          {t('password')}
          <input
            aria-label={t('password')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit">{t('sign in')}</Button>
      </form>
      {view?.tasks.length ? (
        <div className="extension-list">
          {view.tasks.map((task) => (
            <article className="extension-card" key={task.taskId}>
              <div className="detail-title">
                <div>
                  <h2>{task.title || task.taskId}</h2>
                  <p>
                    {task.taskId} · {t('seen to {seq}', { seq: task.seq })}
                    {task.saved ? ' · ' + t('results saved') : ''}
                  </p>
                </div>
                <Button
                  aria-label={t('follow {id}', { id: task.taskId })}
                  onClick={() => run(`task ${task.taskId}`)}
                >
                  {t('follow')}
                </Button>
                <Button
                  aria-label={t('save results of {id}', { id: task.taskId })}
                  onClick={() => run(`get ${task.taskId}`)}
                >
                  {t('save results')}
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      <HubProjectionNotice projection={view?.projection} />
      {view?.recent.length ? (
        <DataBlock title={t('recent')} value={view.recent.join('\n')} />
      ) : null}
    </Page>
  );
}
export const hubPlugin: WorkbenchPlugin = {
  id: 'hub',
  apiVersion: 1,
  version: '0.1.0',
  title: 'hub',
  description:
    'Hand work to a hub and follow it: the interface half of the bundled hub extension.',
  icon: Server,
  runtimeExtension: 'hub',
  pages: [
    {
      id: 'hub',
      title: 'hub',
      icon: Server,
      component: HubPage,
    },
  ],
};
