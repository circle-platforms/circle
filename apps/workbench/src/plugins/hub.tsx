import { useEffect, useRef, useState } from 'react';
import { Server } from 'lucide-react';
import { useRuntime } from '../app/context';
import { Button, EmptyState, Facts, Page, Status } from '../components/common';
import type { RuntimeExtension } from '../model/types';
import type { PluginViewProps, WorkbenchPlugin } from './types';
import { locale, t } from '../i18n';

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
  inbox?: HubInboxItem[];
  knowledge?: { query: string; items: HubKnowledgeHit[] };
}
interface HubInboxItem {
  kind: string;
  requestId: string;
  taskId: string;
  approvalId: string;
  title: string;
  messageZh?: string;
  titleZh?: string;
  status?: string;
}
interface HubKnowledgeHit {
  recordId: string;
  snapshotId: string;
  title: string;
}
const DEFAULT_HUB_URL = 'http://127.0.0.1:7410';
const HUB_LOGIN_KEY = 'circle.workbench.hub.login.v1';
/** The last server and user typed on this page. The password is never kept. */
export function readHubLogin(storage?: Pick<Storage, 'getItem'>): {
  url: string;
  username: string;
} {
  const empty = { url: DEFAULT_HUB_URL, username: '' };
  if (!storage) return empty;
  try {
    const parsed = JSON.parse(storage.getItem(HUB_LOGIN_KEY) ?? '');
    if (!parsed || typeof parsed !== 'object') return empty;
    const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
    const username = typeof parsed.username === 'string' ? parsed.username : '';
    return { url: url || DEFAULT_HUB_URL, username };
  } catch {
    return empty;
  }
}
function writeHubLogin(
  storage: Pick<Storage, 'setItem'> | undefined,
  value: { url: string; username: string },
) {
  try {
    storage?.setItem(
      HUB_LOGIN_KEY,
      JSON.stringify({ url: value.url, username: value.username }),
    );
  } catch {
    /* A private window keeps the fields for this visit only. */
  }
}
export function hubView(
  extensions: readonly RuntimeExtension[],
): HubView | undefined {
  const view = extensions.find((item) => item.name === 'hub')?.view;
  return view && typeof view === 'object' ? (view as HubView) : undefined;
}
function loginStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}
function offeredLogin(
  view: HubView | undefined,
  storage: Pick<Storage, 'getItem'> | undefined,
): { url: string; username: string } {
  const saved = readHubLogin(storage);
  if (!view) return saved;
  const url =
    view.username || (view.url && view.url !== DEFAULT_HUB_URL)
      ? view.url || saved.url
      : saved.url;
  return { url, username: view.username || saved.username };
}
function approveArgs(item: HubInboxItem): string {
  if (item.kind === 'governance' || (!item.taskId && item.requestId))
    return `approve ${item.requestId}`;
  const approval = item.approvalId || item.requestId;
  return approval
    ? `approve ${item.taskId} ${approval}`
    : `approve ${item.taskId}`;
}
/** A refused password on this page. The terminal still names the command. */
export function hubSignInError(message: string): string {
  if (
    message.includes('UNAUTHENTICATED') ||
    message.includes('sign-in was refused') ||
    message.includes('登录被拒绝')
  )
    return t('username or password is wrong');
  return message;
}
function hubKind(kind: string): string {
  switch (kind) {
    case 'change-set':
      return t('change set');
    case 'governance':
      return t('governance');
    default:
      return kind;
  }
}
function hubStatus(status: string): string {
  switch (status) {
    case 'waiting-review':
      return t('waiting for review');
    default:
      return status;
  }
}
function inboxTitle(item: HubInboxItem): string {
  if (locale() === 'zh-CN') {
    const chinese = item.messageZh?.trim() || item.titleZh?.trim();
    if (chinese) return chinese;
  }
  return item.title;
}
const APPROVAL_LINE =
  /\/hub approve\b|需要别人批准|someone else approves|waiting for approval/i;
function signedOutLine(line: string): boolean {
  const text = line.replace(/^[●○]\s*/, '').trim();
  return (
    text === '已退出' ||
    text === 'Signed out' ||
    text === '未登录' ||
    text === 'Not signed in' ||
    text.startsWith('已退出：') ||
    text.startsWith('已退出:') ||
    /^signed out\b/i.test(text) ||
    text.startsWith('枢纽 · 已退出') ||
    text.startsWith('hub · signed out')
  );
}
function proseLine(line: string): string {
  const sep = locale() === 'zh-CN' ? '，' : ', ';
  return line
    .trim()
    .replace(/^[●○]\s*/, '')
    .replace(/\s*·\s*/g, sep);
}
/** Terminal lines as the hub page shows them. A sign-out is dropped once
 * signed in again. An approval command becomes one plain sentence. */
export function hubRecentItems(
  lines: readonly string[],
  signedIn: boolean,
): { kind: 'note' | 'approval'; text: string }[] {
  const items: { kind: 'note' | 'approval'; text: string }[] = [];
  let approval = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (signedIn && signedOutLine(line)) continue;
    if (APPROVAL_LINE.test(line)) {
      approval = true;
      continue;
    }
    items.push({ kind: 'note', text: proseLine(line) });
  }
  if (approval)
    items.push({
      kind: 'approval',
      text: '',
    });
  return items;
}
function rejectArgs(item: HubInboxItem, reason: string): string {
  if (item.kind === 'governance' || (!item.taskId && item.requestId))
    return `reject ${item.requestId} ${reason}`;
  const approval = item.approvalId || item.requestId;
  return `reject ${item.taskId} ${approval} ${reason}`;
}
/** The interface half of the hub extension: its commands, as a page. */
export function HubPage({
  storage,
}: PluginViewProps & {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}) {
  const { snapshot, runtime, perform } = useRuntime();
  const view = hubView(snapshot.extensions);
  const recentItems = view ? hubRecentItems(view.recent, view.signedIn) : [];
  const box = storage ?? loginStorage();
  const [address, setAddress] = useState(() => offeredLogin(view, box).url);
  const [user, setUser] = useState(() => offeredLogin(view, box).username);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const touched = useRef({ address: false, user: false });
  const asked = useRef<string | null>(null);
  // The open session may only have catalogued hub. Ask that session to load
  // it; the saved sign-in is in the home, and the page reads the view it publishes.
  useEffect(() => {
    if (view || runtime.mode !== 'live') return;
    const listed = snapshot.extensions.some(
      (item) => item.name === 'hub' && item.enabled && !item.error,
    );
    if (!listed) return;
    if (asked.current === snapshot.activeSessionId) return;
    asked.current = snapshot.activeSessionId;
    void Promise.resolve(
      runtime.request('extension-command', { name: 'hub', args: '' }),
    ).catch(() => {
      asked.current = null;
    });
  }, [view, runtime, snapshot.activeSessionId, snapshot.extensions]);
  useEffect(() => {
    if (!view) return;
    const offered = offeredLogin(view, box);
    if (!touched.current.address && offered.url) setAddress(offered.url);
    if (!touched.current.user && offered.username) setUser(offered.username);
    if (view.username || (view.url && view.url !== DEFAULT_HUB_URL))
      writeHubLogin(box, {
        url: view.url || offered.url,
        username: view.username || offered.username,
      });
  }, [view, box]);
  // Every action is the extension's own /hub command. Its lines stay on this page.
  const run = (args: string) =>
    perform(async () => {
      await runtime.request('extension-command', { name: 'hub', args });
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
            [t('scope')]: view.scopeId || t('none'),
            [t('state')]: (
              <Status value={view.signedIn ? 'signed in' : 'signed out'} />
            ),
            [t('following')]: view.following.length
              ? view.following.join(', ')
              : t('nothing followed'),
          }}
        />
      ) : (
        <EmptyState title={t('not signed in yet')} />
      )}
      {view?.signedIn ? (
        <div className="inline-actions hub-actions">
          <Button onClick={() => run('logout')}>{t('sign out')}</Button>
        </div>
      ) : (
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
            writeHubLogin(box, { url: server, username: name });
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
                runtime.dismissActionError?.();
                setError(
                  caught instanceof Error
                    ? hubSignInError(caught.message)
                    : t('sign-in failed'),
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
                const url = event.target.value;
                setAddress(url);
                writeHubLogin(box, { url, username: user });
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
                const username = event.target.value;
                setUser(username);
                writeHubLogin(box, { url: address, username });
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
          <Button type="submit">{t('sign in')}</Button>
        </form>
      )}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {view?.signedIn ? (
        <>
          <section className="extension-list" id="hub-inbox">
            <div className="detail-title">
              <h2>{t('inbox')}</h2>
              <Button onClick={() => run('inbox')}>
                {view.inbox ? t('refresh') : t('open inbox')}
              </Button>
            </div>
            {view.inbox?.length ? (
              view.inbox.map((item, index) => {
                const id = item.requestId || item.taskId || String(index);
                return (
                  <article className="extension-card" key={id}>
                    <div className="detail-title">
                      <div>
                        <h2>{inboxTitle(item) || id}</h2>
                        <p>
                          {hubKind(item.kind)}
                          {item.status ? ' · ' + hubStatus(item.status) : ''}
                          {' · '}
                          {item.taskId || item.requestId}
                          {item.approvalId ? ' · ' + item.approvalId : ''}
                        </p>
                      </div>
                      <Button onClick={() => run(`show ${id}`)}>
                        {t('show')}
                      </Button>
                      <Button onClick={() => run(approveArgs(item))}>
                        {t('approve')}
                      </Button>
                    </div>
                    <form
                      className="form-stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const reason = reasons[id]?.trim() ?? '';
                        if (!reason) {
                          setError(t('a rejection needs a reason'));
                          return;
                        }
                        setError('');
                        run(rejectArgs(item, reason));
                      }}
                    >
                      <label>
                        {t('rejection reason')}
                        <input
                          aria-label={t('rejection reason')}
                          value={reasons[id] ?? ''}
                          onChange={(event) =>
                            setReasons({ ...reasons, [id]: event.target.value })
                          }
                        />
                      </label>
                      <Button type="submit">{t('reject')}</Button>
                    </form>
                  </article>
                );
              })
            ) : view.inbox ? (
              <p>{t('nothing is waiting for you')}</p>
            ) : null}
          </section>
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              const text = query.trim();
              if (!text) {
                setError(t('enter text to search knowledge'));
                return;
              }
              setError('');
              run(`knowledge search ${text}`);
            }}
          >
            <h2>{t('knowledge')}</h2>
            <label>
              {t('search knowledge')}
              <input
                aria-label={t('search knowledge')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <Button type="submit">{t('search')}</Button>
            {view.knowledge?.items.length ? (
              <div className="extension-list">
                {view.knowledge.items.map((item) => (
                  <article className="extension-card" key={item.recordId}>
                    <h2>{item.title || item.recordId}</h2>
                    <p>
                      {item.recordId}
                      {item.snapshotId
                        ? ' · ' + t('snapshot {id}', { id: item.snapshotId })
                        : ''}
                    </p>
                  </article>
                ))}
              </div>
            ) : view.knowledge ? (
              <p>{t('no knowledge matched')}</p>
            ) : null}
          </form>
        </>
      ) : null}
      {view?.tasks.length ? (
        <div className="extension-list">
          {view.tasks.map((task) => (
            <article className="extension-card" key={task.taskId}>
              <div className="detail-title">
                <div>
                  <h2>{task.title || task.taskId}</h2>
                  <p>
                    {task.taskId} ·{' '}
                    {t('events seen to {seq}', { seq: task.seq })}
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
      {recentItems.length ? (
        <section className="hub-log-block">
          <h2>{t('recent')}</h2>
          <ul className="hub-log">
            {recentItems.map((item, index) =>
              item.kind === 'approval' ? (
                <li key={`approval-${index}`}>
                  <p>{t('Someone else still has to approve this.')}</p>
                  <Button
                    onClick={() => {
                      document.getElementById('hub-inbox')?.scrollIntoView();
                      run('inbox');
                    }}
                  >
                    {t('open inbox')}
                  </Button>
                </li>
              ) : (
                <li key={`${index}-${item.text}`}>{item.text}</li>
              ),
            )}
          </ul>
        </section>
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
