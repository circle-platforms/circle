import { Tooltip, DropdownMenu } from 'radix-ui';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  BookOpen,
  Folder,
  FileText,
  Search,
  RefreshCw,
  X,
} from 'lucide-react';
import { useRuntime } from '../app/context';
import {
  Button,
  IconButton,
  Modal,
  SearchInput,
  EmptyState,
} from '../components/common';
import { Markdown } from '../components/Markdown';
import { t, tn } from '../i18n';
import {
  knowledgeError,
  knowledgeStatusText,
  knowledgeLocation,
  knowledgeUpdated,
} from '../model/knowledge';
import type {
  KnowledgeDetail,
  KnowledgeList,
  KnowledgePreview,
  KnowledgeRow,
  KnowledgeScope,
  KnowledgeSection,
  KnowledgeSource,
  KnowledgeSyncView,
} from '../../../../src/knowledge/desktop-contract';
import './knowledge.css';

const sourceLocationText = (location: string) => {
  const match = /^l\/(\d+)(?:-(\d+))?$/.exec(location);
  return match
    ? match[2]
      ? t('lines {from}–{to}', { from: match[1]!, to: match[2] })
      : t('line {n}', { n: match[1]! })
    : location.startsWith('p/')
      ? 'JSON /' + location.slice(2)
      : location.startsWith('b/')
        ? location.split('/').slice(2).join('/') || t('document')
        : t('document');
};
const sectionTitle = (section: KnowledgeSection) =>
  section === 'memory'
    ? t('memory')
    : section === 'workflows'
      ? t('workflows')
      : t('knowledge');
const rowStatus = (row: KnowledgeRow) =>
  row.status === 'conflicted'
    ? t('conflicts')
    : row.kind === 'folder'
      ? t('folder')
      : row.kind === 'source'
        ? t('source')
        : row.kind === 'workflow' || row.kind === 'skill'
          ? row.availability === 'unavailable'
            ? t('files unavailable')
            : row.installed
              ? row.enabled
                ? t('available locally')
                : t('disabled')
              : t('manifest only')
          : row.status === 'verified'
            ? t('verified')
            : row.status === 'unverified'
              ? t('pending verification')
              : row.status === 'enabled'
                ? t('enabled')
                : row.status === 'disabled'
                  ? t('disabled')
                  : t('deleted');
const rowStateClass = (row: KnowledgeRow) =>
  row.status === 'conflicted'
    ? 'conflicted'
    : ['workflow', 'skill'].includes(row.kind)
      ? row.availability === 'available'
        ? 'enabled'
        : row.availability === 'unavailable'
          ? 'unverified'
          : 'disabled'
      : row.status;
const loadText = (row: KnowledgeRow) =>
  row.loadState === 'partial'
    ? t('partially loaded in this session')
    : row.loadState === 'earlier'
      ? t('earlier content is loaded in this session')
      : row.loaded
        ? t('loaded in this session')
        : t('not loaded in this session');
const rowKind = (row: KnowledgeRow) =>
  row.kind === 'entry'
    ? t('knowledge', undefined, 'item')
    : row.kind === 'memory'
      ? t('memory')
      : row.kind === 'folder'
        ? t('folder')
        : row.kind === 'source'
          ? t('source')
          : row.kind === 'workflow'
            ? t('workflow')
            : t('generic skill');
function SourceQuotation({ source }: { source: KnowledgeSource }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLQuoteElement>(null);
  useEffect(() => {
    const measure = () => {
      const quote = ref.current;
      if (quote)
        setOverflows(
          quote.scrollHeight >
            parseFloat(getComputedStyle(quote).lineHeight) * 3 + 1,
        );
    };
    const observer = new ResizeObserver(measure);
    if (ref.current) observer.observe(ref.current);
    measure();
    return () => observer.disconnect();
  }, [source.quotation]);
  return (
    <>
      <blockquote ref={ref} className={expanded ? 'is-expanded' : ''}>
        「{source.quotation}」
      </blockquote>
      {(overflows || expanded) && (
        <Button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? t('collapse quotation') : t('expand quotation')}
        </Button>
      )}
      {expanded && source.truncated && <p>{t('remaining content omitted')}</p>}
    </>
  );
}
export function KnowledgeSyncStatus({
  status,
  onClick,
}: {
  status?: KnowledgeSyncView;
  onClick: () => void;
}) {
  return (
    <button
      className="knowledge-sync-line"
      data-condition={status?.condition ?? 'local'}
      onClick={onClick}
    >
      <i aria-hidden="true" />
      {knowledgeStatusText(status)}
    </button>
  );
}
type Draft = {
  action: string;
  title: string;
  text: string;
  destination: string;
  candidate: string;
  teamPath: string;
};
const emptyDraft: Draft = {
  action: '',
  title: '',
  text: '',
  destination: '',
  candidate: '',
  teamPath: '/',
};
export function KnowledgePage({ section }: { section: KnowledgeSection }) {
  const { runtime, snapshot } = useRuntime(),
    navigate = useNavigate();
  const [params, setParams] = useSearchParams(),
    scope = (params.get('scope') ?? 'personal') as KnowledgeScope,
    selected = params.get('item') ?? '',
    query = params.get('q') ?? '',
    filter = params.get('filter') ?? 'all',
    folder = params.get('folder') ?? '',
    sort = params.get('sort') ?? 'title',
    direction = params.get('direction') ?? 'asc';
  const [list, setList] = useState<KnowledgeList>(),
    [detail, setDetail] = useState<KnowledgeDetail>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [draft, setDraft] = useState<Draft>(),
    [preview, setPreview] = useState<KnowledgePreview>(),
    [source, setSource] = useState<{
      name: string;
      text: string;
      truncated: boolean;
    }>(),
    [history, setHistory] = useState(false);
  const [folders, setFolders] = useState<{ id: string; path: string }[]>([]),
    [version, setVersion] = useState(0);
  const generation = useRef(0),
    detailGeneration = useRef(0),
    listRef = useRef<HTMLDivElement>(null),
    backRef = useRef<HTMLButtonElement>(null),
    pendingFocus = useRef<'detail' | 'list' | ''>('');
  const change = (patch: Record<string, string | undefined>) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(patch))
        value ? next.set(key, value) : next.delete(key);
      return next;
    });
  useEffect(() => {
    if (pendingFocus.current === 'detail' && params.get('view') === 'detail') {
      if (matchMedia('(max-width: 1179px)').matches) backRef.current?.focus();
      pendingFocus.current = '';
    } else if (
      pendingFocus.current === 'list' &&
      params.get('view') !== 'detail'
    ) {
      listRef.current
        ?.querySelector<HTMLElement>('[data-item="' + selected + '"]')
        ?.focus();
      pendingFocus.current = '';
    }
  }, [params, selected]);
  const call = useCallback(
    (payload: Record<string, unknown>) =>
      runtime.mode === 'live'
        ? Promise.resolve(runtime.request('knowledge', payload))
        : Promise.reject(Error('knowledge-preview-unavailable')),
    [runtime],
  );
  const reload = () => setVersion((n) => n + 1);
  useEffect(() => {
    const id = ++generation.current;
    setError('');
    void call({
      op: 'list',
      section,
      scope,
      query,
      filter,
      folder,
      sort,
      direction,
    })
      .then((value) => {
        if (id === generation.current) setList(value as KnowledgeList);
      })
      .catch((e) => {
        if (id === generation.current) {
          setList(undefined);
          setDetail(undefined);
          setError(knowledgeError(e));
        }
      });
    return () => {
      generation.current++;
    };
  }, [
    call,
    section,
    scope,
    query,
    filter,
    folder,
    sort,
    direction,
    version,
    scope === 'personal' ? '' : snapshot.knowledgeSync?.server,
    scope === 'personal' ? '' : snapshot.knowledgeSync?.condition,
  ]);
  useEffect(() => {
    const id = ++detailGeneration.current;
    const row = list?.rows.find((r) => r.id === selected);
    setDetail((previous) =>
      row && previous?.id === selected && previous.token === row.token
        ? previous
        : undefined,
    );
    if (!row || row.kind === 'folder') return;
    void call({ op: 'detail', id: row.id, token: row.token })
      .then((value) => {
        if (id === detailGeneration.current)
          setDetail(value as KnowledgeDetail);
      })
      .catch((e) => {
        if (id === detailGeneration.current) {
          setDetail(undefined);
          setError(knowledgeError(e));
        }
      });
    return () => {
      detailGeneration.current++;
    };
  }, [call, list, selected, version]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        list &&
        !draft &&
        !preview &&
        !busy &&
        !list.more &&
        !list.incomplete &&
        list.rows.length <= 100
      )
        reload();
    }, 5000);
    return () => clearInterval(timer);
  }, [draft, preview, busy, list?.more, list?.incomplete, list?.rows.length]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      return await action();
    } catch (e) {
      setError(knowledgeError(e));
    } finally {
      setBusy(false);
    }
  };
  const openDraft = async (action: string) => {
    setError('');
    setPreview(undefined);
    setDraft({
      ...emptyDraft,
      action,
      title: action.startsWith('create-') ? '' : (detail?.title ?? ''),
      text: action.startsWith('create-') ? '' : (detail?.text ?? ''),
      candidate: detail?.candidates[0]?.token ?? '',
    });
    const settings = (await run(async () => {
      const settings = (await call({ op: 'settings' })) as any;
      if (detail && ['edit', 'resolve'].includes(action)) {
        const body = (await call({
          op: 'edit-body',
          id: detail.id,
          token: detail.token,
        })) as any;
        setDraft((prior) =>
          prior ? { ...prior, title: body.title, text: body.text } : prior,
        );
      }
      return settings;
    })) as any;
    if (settings) setFolders(settings.folders);
  };
  const prepare = async () => {
    if (!draft) return;
    const payload: any = { op: 'prepare', action: draft.action };
    if (
      ['create-entry', 'create-memory', 'create-folder'].includes(draft.action)
    ) {
      payload.title = draft.title;
      payload.text = draft.text;
      if (folder) payload.destination = folder;
    } else {
      if (!detail) return;
      payload.id = detail.id;
      payload.token = detail.token;
      if (['edit', 'resolve'].includes(draft.action)) {
        payload.text = draft.text;
        payload.title = draft.title;
      }
      if (draft.action === 'move') payload.destination = draft.destination;
      if (draft.action === 'resolve') payload.candidate = draft.candidate;
      if (draft.action === 'enabled' || draft.action === 'pack-enabled')
        payload.enabled =
          detail.status === 'disabled' || detail.enabled === false;
      if (draft.action === 'share') payload.teamPath = draft.teamPath;
    }
    const result = (await run(() => call(payload))) as
      KnowledgePreview | undefined;
    if (result) setPreview(result);
  };
  const cancel = () => {
    if (preview) void call({ op: 'cancel', ticket: preview.ticket });
    setPreview(undefined);
    setDraft(undefined);
  };
  const confirm = async () => {
    if (!preview) return;
    const result = await run(() =>
      call({ op: 'confirm', ticket: preview.ticket, confirmed: true }),
    );
    if (result) {
      setList(undefined);
      setDetail(undefined);
      cancel();
      reload();
    }
  };
  const choose = (row: KnowledgeRow, open = true) =>
    row.kind === 'folder' && open
      ? change({
          folder: scope === 'personal' ? row.id : row.path,
          item: undefined,
          view: undefined,
        })
      : change({ item: row.id, view: open ? 'detail' : undefined });
  const moveSelection = (event: KeyboardEvent) => {
    if (
      !list?.rows.length ||
      !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)
    )
      return;
    const focused =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-item]')?.dataset.item
        : undefined;
    const at = list.rows.findIndex((r) => r.id === (focused ?? selected));
    const row =
      event.key === 'Enter'
        ? list.rows[Math.max(0, at)]
        : list.rows[
            Math.max(
              0,
              Math.min(
                list.rows.length - 1,
                at + (event.key === 'ArrowDown' ? 1 : -1),
              ),
            )
          ];
    if (row) {
      event.preventDefault();
      if (event.key === 'Enter' && row.kind !== 'folder')
        pendingFocus.current = 'detail';
      choose(row, event.key === 'Enter');
      listRef.current
        ?.querySelector<HTMLElement>('[data-item="' + row.id + '"]')
        ?.focus();
    }
  };
  const pageStatus = snapshot.knowledgeSync ?? list?.sync;
  return (
    <section
      className={
        'knowledge-shell' +
        (selected && params.get('view') === 'detail' ? ' has-selection' : '')
      }
      data-knowledge-section={section}
    >
      <main className="knowledge-list-pane" aria-label={sectionTitle(section)}>
        <header className="knowledge-page-header">
          {folder && (
            <button
              className="knowledge-crumb"
              onClick={() => change({ folder: undefined, item: undefined })}
            >
              <ArrowLeft size={14} />
              {t('all folders')}
              <span>{list?.folder}</span>
            </button>
          )}
          <div className="knowledge-heading">
            <h1>{sectionTitle(section)}</h1>
            <div className="knowledge-actions">
              <Button onClick={() => navigate('/page/sync')}>
                {t('sync settings')}
              </Button>
              <IconButton label={t('refresh')} disabled={busy} onClick={reload}>
                <RefreshCw size={15} />
              </IconButton>
              {section === 'memory' && (
                <Button
                  onClick={() =>
                    void run(() => call({ op: 'refresh-memory' })).then(reload)
                  }
                >
                  {t('refresh session memory')}
                </Button>
              )}
              {scope === 'personal' && section === 'knowledge' && (
                <>
                  <Button onClick={() => void openDraft('create-folder')}>
                    {t('new folder…')}
                  </Button>
                  <Button
                    onClick={() =>
                      void run(() =>
                        call({
                          op: 'import-pick',
                          ...(folder ? { destination: folder } : {}),
                        }),
                      ).then((value) => {
                        if ((value as any)?.ticket) {
                          setDraft({ ...emptyDraft, action: 'import' });
                          setPreview(value as KnowledgePreview);
                        }
                      })
                    }
                  >
                    {t('import file…')}
                  </Button>
                </>
              )}
              {scope === 'personal' && (
                <Button
                  className="primary"
                  onClick={() => {
                    if (section === 'workflows')
                      void run(() => call({ op: 'pack-pick' })).then(
                        (value) => {
                          if ((value as any)?.ticket) {
                            setDraft({
                              ...emptyDraft,
                              action: 'register-pack',
                            });
                            setPreview(value as KnowledgePreview);
                          }
                        },
                      );
                    else
                      void openDraft(
                        section === 'memory' ? 'create-memory' : 'create-entry',
                      );
                  }}
                >
                  {section === 'workflows'
                    ? t('import workflow or skill…')
                    : t('new…')}
                </Button>
              )}
            </div>
          </div>
          <div className="knowledge-facts">
            {list ? tn(list.total, '{n} item', '{n} items') : t('loading…')}
            {list?.incomplete && <span> · {t('partial results')}</span>}
          </div>
          {section !== 'workflows' && (
            <div
              className="segmented knowledge-scopes"
              role="group"
              aria-label={t('scope')}
            >
              {(['personal', 'team', 'shared'] as const).map((s) => (
                <button
                  key={s}
                  aria-pressed={scope === s}
                  onClick={() =>
                    change({ scope: s, item: undefined, folder: undefined })
                  }
                >
                  {s === 'personal'
                    ? section === 'memory'
                      ? t('my memory')
                      : t('mine')
                    : s === 'team'
                      ? section === 'memory'
                        ? t('team memory')
                        : t('team')
                      : t('shared with me')}
                </button>
              ))}
            </div>
          )}
          <div className="knowledge-toolbar">
            <SearchInput
              value={query}
              onChange={(q) => change({ q, item: undefined })}
              label={
                section === 'memory'
                  ? t('search memory')
                  : section === 'workflows'
                    ? t('search workflows')
                    : t('search knowledge')
              }
              placeholder={
                section === 'memory'
                  ? t('search memory…')
                  : section === 'workflows'
                    ? t('search workflows…')
                    : t('search knowledge…')
              }
            />
            <div
              className="knowledge-chips"
              role="group"
              aria-label={t('filter')}
            >
              {(section === 'workflows'
                ? ['all', 'workflow', 'skill']
                : section === 'memory'
                  ? ['all', 'enabled', 'disabled', 'conflicted']
                  : ['all', 'verified', 'unverified', 'conflicted']
              ).map((f) => (
                <button
                  key={f}
                  aria-pressed={filter === f}
                  onClick={() => change({ filter: f, item: undefined })}
                >
                  {f === 'all'
                    ? t('all')
                    : f === 'verified'
                      ? t('verified')
                      : f === 'unverified'
                        ? t('pending verification')
                        : f === 'conflicted'
                          ? t('conflicts')
                          : f === 'enabled'
                            ? t('enabled')
                            : f === 'disabled'
                              ? t('disabled')
                              : f === 'workflow'
                                ? t('workflows')
                                : t('generic skills')}
                </button>
              ))}
            </div>
          </div>
        </header>
        {error && (
          <div className="knowledge-error" role="alert">
            {error}
            <Button onClick={reload}>{t('retry')}</Button>
          </div>
        )}
        <div
          className="knowledge-results"
          ref={listRef}
          role={section === 'workflows' ? undefined : 'listbox'}
          aria-label={sectionTitle(section)}
          onKeyDown={moveSelection}
        >
          {!list?.rows.length ? (
            <EmptyState
              title={
                !list && !error
                  ? t('loading…')
                  : error
                    ? t('knowledge list could not load')
                    : query
                      ? section === 'memory'
                        ? t('no matching memory')
                        : section === 'workflows'
                          ? t('no matching workflows')
                          : t('no matching knowledge')
                      : section === 'memory'
                        ? t('no memory in this scope')
                        : section === 'workflows'
                          ? t('no personal workflows yet')
                          : t('this folder has no knowledge')
              }
            >
              {scope === 'shared' && !query
                ? t('search to find knowledge shared with this account')
                : section === 'workflows'
                  ? t(
                      'import a workflow or skill folder, then choose whether to install it',
                    )
                  : scope === 'personal'
                    ? t('create an item or change the filters')
                    : t('change filters or choose another scope')}{' '}
              <Button
                onClick={() =>
                  change({
                    q: undefined,
                    filter: undefined,
                    folder: undefined,
                    item: undefined,
                  })
                }
              >
                {t('clear filters')}
              </Button>
            </EmptyState>
          ) : section === 'workflows' ? (
            <div className="knowledge-table-wrap">
              <table className="knowledge-table">
                <thead>
                  <tr>
                    {(['title', 'kind', 'status'] as const).map((column) => (
                      <th
                        key={column}
                        aria-sort={
                          sort === column
                            ? direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                      >
                        <button
                          onClick={() =>
                            change({
                              sort: column,
                              direction:
                                sort === column && direction === 'asc'
                                  ? 'desc'
                                  : 'asc',
                            })
                          }
                        >
                          {column === 'title'
                            ? t('name')
                            : column === 'kind'
                              ? t('type')
                              : t('status')}
                          {sort === column
                            ? direction === 'asc'
                              ? ' ↑'
                              : ' ↓'
                            : ''}
                        </button>
                      </th>
                    ))}
                    <th>{t('location')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((row) => (
                    <tr
                      key={row.id}
                      tabIndex={0}
                      data-item={row.id}
                      aria-selected={selected === row.id}
                      onClick={() => choose(row)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          choose(row);
                        }
                      }}
                    >
                      <td>{row.title}</td>
                      <td>{rowKind(row)}</td>
                      <td>
                        <span
                          className={'knowledge-state ' + rowStateClass(row)}
                        >
                          <i />
                          {rowStatus(row)}
                        </span>
                      </td>
                      <td>{knowledgeLocation(row.path, scope)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            list.rows.map((row, index) => (
              <button
                role="option"
                tabIndex={
                  selected === row.id || (!selected && index === 0) ? 0 : -1
                }
                className={
                  'knowledge-row' + (selected === row.id ? ' is-selected' : '')
                }
                key={row.id}
                data-item={row.id}
                aria-selected={selected === row.id}
                onClick={() => choose(row)}
              >
                <span className="knowledge-row-mark">
                  {row.kind === 'folder' ? (
                    <Folder size={15} />
                  ) : row.kind === 'source' ? (
                    <FileText size={15} />
                  ) : (
                    <i />
                  )}
                </span>
                <span className="knowledge-row-content">
                  <span className="knowledge-row-title">{row.title}</span>
                  <span className="knowledge-row-meta">
                    <span>{rowKind(row)}</span>
                    {!['folder', 'source'].includes(row.kind) && (
                      <span className={'knowledge-state ' + rowStateClass(row)}>
                        <i />
                        {rowStatus(row)}
                      </span>
                    )}
                    {row.sources > 0 && (
                      <span>{t('sources {n}', { n: row.sources })}</span>
                    )}
                    {row.kind === 'memory' && <span>{loadText(row)}</span>}
                    <span
                      className="knowledge-row-path"
                      title={knowledgeLocation(row.path, scope)}
                    >
                      {knowledgeLocation(row.path, scope)}
                    </span>
                  </span>
                </span>
              </button>
            ))
          )}
          {list?.more && (
            <Button
              onClick={() =>
                void run(() =>
                  call({
                    op: 'list',
                    section,
                    scope,
                    query,
                    filter,
                    folder,
                    sort,
                    direction,
                    offset: list.rows.length,
                  }),
                ).then((value) => {
                  if (value) {
                    const next = value as KnowledgeList;
                    setList({ ...next, rows: [...list.rows, ...next.rows] });
                  }
                })
              }
            >
              {t('load more')}
            </Button>
          )}
        </div>
        <footer className="knowledge-page-footer">
          <KnowledgeSyncStatus
            status={pageStatus}
            onClick={() => navigate('/page/sync')}
          />
        </footer>
      </main>
      <aside
        className="knowledge-inspector"
        aria-label={t('knowledge details')}
      >
        <header className="knowledge-inspector-header">
          <button
            className="knowledge-back"
            ref={backRef}
            onClick={() => {
              pendingFocus.current = 'list';
              change({ view: undefined });
            }}
          >
            <ArrowLeft size={15} />
            {t('back to list')}
          </button>
          <span>{t('details')}</span>
          {selected && (
            <IconButton
              label={t('close details')}
              onClick={() => change({ item: undefined })}
            >
              <X size={15} />
            </IconButton>
          )}
        </header>
        {detail ? (
          <>
            <div className="knowledge-inspector-content">
              <div className="knowledge-detail-tags">
                <span>{rowKind(detail)}</span>
                {!['folder', 'source'].includes(detail.kind) && (
                  <span className={'knowledge-state ' + rowStateClass(detail)}>
                    <i />
                    {rowStatus(detail)}
                  </span>
                )}
                {detail.kind === 'memory' && <span>{loadText(detail)}</span>}
              </div>
              <h2 title={detail.title}>{detail.title}</h2>
              <p className="knowledge-detail-path">
                {knowledgeLocation(detail.path, scope, true)} ·{' '}
                {knowledgeUpdated(detail.updatedAt)}
              </p>
              {detail.text && (
                <div className="knowledge-detail-text">
                  <Markdown text={detail.text} />
                  {detail.truncated && <p>{t('remaining content omitted')}</p>}
                </div>
              )}
              {detail.sourcesList.length > 0 && (
                <section>
                  <h3>
                    {t('sources · {n}', { n: detail.sourcesList.length })}
                  </h3>
                  {detail.sourcesList.map((s) => (
                    <div className="knowledge-source" key={s.id}>
                      <header>
                        <span>
                          {s.name || t('linked source')}
                          {s.location
                            ? ' · ' + sourceLocationText(s.location)
                            : ''}
                        </span>
                        <Button
                          disabled={!s.available}
                          onClick={() =>
                            void run(() =>
                              call({ op: 'source', id: s.id }),
                            ).then((value) => {
                              if (value) setSource(value as any);
                            })
                          }
                        >
                          {s.available ? t('open original') : t('cannot open')}
                        </Button>
                      </header>
                      <SourceQuotation source={s} />
                    </div>
                  ))}
                </section>
              )}
              {detail.files && (
                <section>
                  <h3>{t('files')}</h3>
                  <div className="knowledge-table-wrap">
                    <table className="knowledge-table">
                      <tbody>
                        {detail.files.map((f) => (
                          <tr key={f.name}>
                            <td>{f.name}</td>
                            <td className="num">
                              {t('{n} bytes', { n: f.bytes.toLocaleString() })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              {detail.history.length > 0 && (
                <section>
                  <h3>{t('version history')}</h3>
                  {detail.history.slice(0, 3).map((r, n) => (
                    <p key={r.token}>
                      {r.current ? t('current content') : t('earlier content')}{' '}
                      · {t('change {n}', { n: n + 1 })}
                    </p>
                  ))}
                </section>
              )}
            </div>
            <footer className="knowledge-inspector-footer">
              {scope === 'personal' &&
                detail.share === 'local' &&
                ['entry', 'memory'].includes(detail.kind) && (
                  <p className="knowledge-local-note">
                    {t('local-only content cannot be shared to the team')} ·{' '}
                    <button
                      className="link"
                      onClick={() => navigate('/page/sync')}
                    >
                      {t('sync settings')}
                    </button>
                  </p>
                )}
              <div className="knowledge-inspector-actions">
                <Button onClick={() => setHistory(true)}>
                  {t('version history')}
                </Button>
                {scope === 'personal' && (
                  <>
                    {detail.status === 'conflicted' ? (
                      <Button
                        className="primary"
                        onClick={() => void openDraft('resolve')}
                      >
                        {t('resolve conflict…')}
                      </Button>
                    ) : (
                      <>
                        {['entry', 'memory'].includes(detail.kind) && (
                          <>
                            <Tooltip.Root>
                              <Tooltip.Trigger asChild>
                                <span
                                  tabIndex={0}
                                  title={
                                    detail.share === 'local'
                                      ? t(
                                          'switch to Sync to Hub before sharing to the team',
                                        )
                                      : detail.share === 'waiting'
                                        ? t(
                                            'sync this version before sharing to the team',
                                          )
                                        : undefined
                                  }
                                >
                                  <Button
                                    disabled={
                                      detail.share !== 'ready' ||
                                      (detail.kind === 'entry' &&
                                        detail.status !== 'verified')
                                    }
                                    onClick={() => void openDraft('share')}
                                  >
                                    {t('share to team…')}
                                  </Button>
                                </span>
                              </Tooltip.Trigger>
                              <Tooltip.Portal>
                                <Tooltip.Content
                                  className="tooltip"
                                  sideOffset={7}
                                >
                                  {detail.share === 'local'
                                    ? t(
                                        'switch to Sync to Hub before sharing to the team',
                                      )
                                    : t(
                                        'sync this version before sharing to the team',
                                      )}
                                  <Tooltip.Arrow />
                                </Tooltip.Content>
                              </Tooltip.Portal>
                            </Tooltip.Root>
                          </>
                        )}
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger asChild>
                            <Button>{t('more')}</Button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              className="dropdown"
                              side="top"
                              align="end"
                              sideOffset={6}
                            >
                              {detail.kind === 'memory' && (
                                <DropdownMenu.Item
                                  onSelect={() => void openDraft('enabled')}
                                >
                                  {detail.status === 'enabled'
                                    ? t('disable…')
                                    : t('enable…')}
                                </DropdownMenu.Item>
                              )}
                              {detail.kind !== 'memory' && (
                                <DropdownMenu.Item
                                  onSelect={() => void openDraft('move')}
                                >
                                  {t('move…')}
                                </DropdownMenu.Item>
                              )}
                              <DropdownMenu.Item
                                className="danger"
                                onSelect={() => void openDraft('delete')}
                              >
                                {t('delete…')}
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                        {['workflow', 'skill'].includes(detail.kind) ? (
                          <Button
                            className="primary"
                            onClick={() => {
                              if (
                                detail.installed &&
                                detail.availability !== 'unavailable'
                              )
                                void openDraft('pack-enabled');
                              else
                                void run(() =>
                                  call({
                                    op: 'install-pick',
                                    id: detail.id,
                                    token: detail.token,
                                  }),
                                ).then((value) => {
                                  if ((value as any)?.ticket) {
                                    setDraft({
                                      ...emptyDraft,
                                      action: 'install',
                                    });
                                    setPreview(value as KnowledgePreview);
                                  }
                                });
                            }}
                          >
                            {detail.installed &&
                            detail.availability !== 'unavailable'
                              ? detail.enabled
                                ? t('disable…')
                                : t('enable…')
                              : t('install files…')}
                          </Button>
                        ) : (
                          <Button
                            className="primary"
                            onClick={() => void openDraft('edit')}
                          >
                            {t('edit…')}
                          </Button>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </footer>
          </>
        ) : (
          <div className="knowledge-overview">
            <h2>{sectionTitle(section)}</h2>
            <strong>{list?.total ?? 0}</strong>
            <p>{t('select an item to view its sources and actions')}</p>
          </div>
        )}
      </aside>
      <Modal
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
        title={
          draft?.action === 'share'
            ? t('share to team')
            : draft?.action === 'resolve'
              ? t('resolve conflict')
              : draft?.action === 'delete'
                ? t('delete item')
                : draft?.action === 'install'
                  ? t('install files')
                  : t('change local knowledge')
        }
        restoreFocus
        dismissOutside={false}
        className="knowledge-dialog"
      >
        {draft && (
          <>
            <div className="knowledge-dialog-body">
              {preview ? (
                <>
                  <p>{preview.title}</p>
                  {preview.text && (
                    <pre>
                      {draft.action === 'share'
                        ? knowledgeLocation(preview.text, 'team', true)
                        : preview.text}
                    </pre>
                  )}
                  {preview.files && (
                    <ul>
                      {preview.files.map((f) => (
                        <li key={f.name}>
                          {f.name} · {t('{n} bytes', { n: f.bytes })}
                        </li>
                      ))}
                    </ul>
                  )}
                  {preview.replaces && (
                    <p>{t('this replaces the matching team memory')}</p>
                  )}
                  <p>
                    {draft.action === 'share'
                      ? t('this creates an independent team copy')
                      : draft.action === 'delete'
                        ? t(
                            'the current item is removed; earlier content remains in version history',
                          )
                        : draft.action === 'register-pack'
                          ? t(
                              'only the manifest syncs; files require a separate installation on each device',
                            )
                          : t(
                              'the checked content is saved locally after confirmation',
                            )}
                  </p>
                </>
              ) : (
                <>
                  {(draft.action === 'create-memory' ||
                    draft.action === 'create-folder' ||
                    (draft.action === 'edit' &&
                      ['memory', 'folder', 'source'].includes(
                        detail?.kind ?? '',
                      ))) && (
                    <label className="knowledge-field">
                      {t('title')}
                      <input
                        disabled={busy}
                        value={draft.title}
                        onChange={(e) =>
                          setDraft({ ...draft, title: e.target.value })
                        }
                      />
                    </label>
                  )}
                  {(['create-entry', 'create-memory'].includes(draft.action) ||
                    (['edit', 'resolve'].includes(draft.action) &&
                      ['entry', 'memory'].includes(detail?.kind ?? ''))) && (
                    <label className="knowledge-field">
                      {t('content')}
                      <textarea
                        aria-label={t('content')}
                        disabled={busy}
                        rows={8}
                        value={draft.text}
                        onChange={(e) =>
                          setDraft({ ...draft, text: e.target.value })
                        }
                      />
                    </label>
                  )}
                  {draft.action === 'resolve' && (
                    <label className="knowledge-field">
                      {t('candidate')}
                      <select
                        aria-label={t('candidate')}
                        value={draft.candidate}
                        disabled={busy}
                        onChange={(e) => {
                          const token = e.target.value;
                          setDraft({ ...draft, candidate: token });
                          void run(() =>
                            call({ op: 'edit-body', id: detail!.id, token }),
                          ).then((value) => {
                            if (value)
                              setDraft((prior) =>
                                prior?.candidate === token
                                  ? {
                                      ...prior,
                                      text: (value as any).text,
                                      title: (value as any).title,
                                    }
                                  : prior,
                              );
                          });
                        }}
                      >
                        {detail?.candidates.map((c, n) => (
                          <option key={c.token} value={c.token}>
                            {t('candidate {n}', { n: n + 1 })} · {c.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {draft.action === 'move' && (
                    <label className="knowledge-field">
                      {t('destination folder')}
                      <select
                        aria-label={t('destination folder')}
                        disabled={busy}
                        value={draft.destination}
                        onChange={(e) =>
                          setDraft({ ...draft, destination: e.target.value })
                        }
                      >
                        <option value="">{t('select a folder')}</option>
                        {folders.map((f) => (
                          <option key={f.id} value={f.id}>
                            {knowledgeLocation(f.path, 'personal', true)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {draft.action === 'share' && (
                    <label className="knowledge-field">
                      {t('team folder')}
                      <input
                        disabled={busy}
                        value={draft.teamPath}
                        onChange={(e) =>
                          setDraft({ ...draft, teamPath: e.target.value })
                        }
                      />
                    </label>
                  )}
                  {draft.action === 'delete' && (
                    <p>
                      {t(
                        'the current item is removed; earlier content remains in version history',
                      )}
                    </p>
                  )}
                </>
              )}
              {error && <p role="alert">{error}</p>}
            </div>
            <footer className="knowledge-dialog-actions">
              <Button onClick={cancel}>{t('cancel')}</Button>
              <Button
                className="primary"
                disabled={busy}
                onClick={() => void (preview ? confirm() : prepare())}
              >
                {busy
                  ? t('checking…')
                  : preview
                    ? t('confirm change')
                    : t('check changes')}
              </Button>
            </footer>
          </>
        )}
      </Modal>
      <Modal
        open={!!source}
        onOpenChange={(open) => {
          if (!open) setSource(undefined);
        }}
        title={source?.name || t('source')}
        restoreFocus
        dismissOutside={false}
        className="knowledge-dialog"
      >
        <pre className="knowledge-original">{source?.text}</pre>
        {source?.truncated && <p>{t('remaining content omitted')}</p>}
      </Modal>
      <Modal
        open={history}
        onOpenChange={setHistory}
        title={t('version history')}
        restoreFocus
        dismissOutside={false}
        className="knowledge-dialog"
      >
        {detail?.history.map((r, n) => (
          <button
            className="knowledge-history-row"
            key={r.token}
            onClick={() =>
              void run(() => call({ op: 'source', id: r.token })).then(
                (value) => {
                  if (value) setSource(value as any);
                },
              )
            }
          >
            {r.current ? t('current content') : t('earlier content')} ·{' '}
            {t('change {n}', { n: n + 1 })}
            <span>{r.title}</span>
          </button>
        ))}
        {detail?.historyMore && (
          <p>{t('earlier changes are omitted from this view')}</p>
        )}
      </Modal>
    </section>
  );
}
