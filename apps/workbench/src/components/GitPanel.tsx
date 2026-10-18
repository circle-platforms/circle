import { useOwnerDraft } from '../model/owner-draft';
import { useOwnerState } from '../model/owner-state';
import { useEffect, useRef, useId, useMemo } from 'react';
import { workspaceCall } from '../model/workspace-client';
import { t, tn } from '../i18n';
import './GitPanel.css';
import { DeliveryPanel, WorkspaceServiceError } from './DeliveryPanel';
import { Button, IconButton, Modal, SearchInput } from './common';
import {
  RotateCcw,
  FileText,
  ExternalLink,
  GitBranch,
  ListTree,
  Search,
} from 'lucide-react';
import { DiffBlock } from './DiffBlock';
import { ResizableContextIndex } from './ResizableContextIndex';
import { VirtualFileTree } from './VirtualFileTree';
import { buildFileTreeRows } from '../model/virtual-file-tree';
import type { DiffView } from '../model/types';
import type {
  GitSnapshot,
  GitHistory,
  GitCommitDiff,
} from '../../../desktop/src/workspace/git';
/** A file chosen in the changed-files tree, opened as it was chosen. */
interface PendingFile {
  path: string;
  readonly: boolean;
  commitId: string;
  scope: string;
}
export function gitHunks(diff: string): string[] {
  const result: string[] = [];
  for (const file of diff.split(/(?=^diff --git )/m).filter(Boolean)) {
    const offset = file.search(/^@@ /m);
    if (offset < 0) continue;
    const header = file.slice(0, offset);
    for (const hunk of file
      .slice(offset)
      .split(/(?=^@@ )/m)
      .filter(Boolean))
      result.push(header + hunk);
  }
  return result;
}
function gitDiffView(text: string): DiffView {
  const rows: DiffView['rows'] = text.split('\n').map((text) => ({
    text,
    ...(text.startsWith('+') && !text.startsWith('+++')
      ? { tone: 'added' as const }
      : text.startsWith('-') && !text.startsWith('---')
        ? { tone: 'removed' as const }
        : {}),
  }));
  return {
    summary: `+${rows.filter((row) => row.tone === 'added').length} -${rows.filter((row) => row.tone === 'removed').length}`,
    rows,
  };
}
export function GitPanel({
  sessionId,
  onFile,
  onOpenExternal,
  embedded = false,
}: {
  embedded?: boolean;
  sessionId: string;
  onFile?: (path: string) => void;
  onOpenExternal?: (url: string) => void;
}) {
  const [state, setState] = useOwnerState<GitSnapshot | null>(sessionId, null);
  const [scope, setScope] = useOwnerState(sessionId, 'working');
  const [base, setBase] = useOwnerState(sessionId, 'origin/main');
  const [selected, setSelected] = useOwnerState<string[]>(sessionId, []);
  const [diff, setDiff] = useOwnerState(sessionId, '');
  // Browsing never alters the explicit checkbox selection sent to mutations.
  const [activePath, setActivePath] = useOwnerState(sessionId, '');
  const [query, setQuery] = useOwnerState(sessionId, '');
  const [indexOpen, setIndexOpen] = useOwnerState(sessionId, true);
  const [closedFolders, setClosedFolders] = useOwnerState<string[]>(
    sessionId,
    [],
  );
  const locatorId = useId();
  const locatorTrigger = useRef<HTMLButtonElement>(null);
  const indexToggle = useRef<HTMLButtonElement>(null);
  const diffBrowser = useRef<HTMLDivElement>(null);
  const closeOverlay = () => {
    if (
      !diffBrowser.current?.querySelector('[data-index-overlay]:not([hidden])')
    )
      return false;
    setIndexOpen(false);
    return true;
  };
  const diffSurface = useRef<HTMLDivElement>(null);
  const locatorSelected = useRef(false);
  const [locatorOpen, setLocatorOpen] = useOwnerState(sessionId, false);
  const [locatorQuery, setLocatorQuery] = useOwnerState(sessionId, '');
  const [locatorIndex, setLocatorIndex] = useOwnerState(sessionId, 0);
  const [fileStats, setFileStats] = useOwnerState<
    Record<string, GitCommitDiff['entries'][number]>
  >(sessionId, {});
  const [history, setHistory] = useOwnerState<GitHistory | null>(
    sessionId,
    null,
  );
  const [commitId, setCommitId] = useOwnerState(sessionId, '');
  const [commitEntries, setCommitEntries] = useOwnerState<
    GitCommitDiff['entries']
  >(sessionId, []);
  const [branchEntries, setBranchEntries] = useOwnerState<
    GitCommitDiff['entries']
  >(sessionId, []);

  const [message, setMessage, draftUnavailable] = useOwnerDraft(
    sessionId,
    'git.commit-message',
  );
  const [error, setError] = useOwnerState(sessionId, '');
  const [busy, setBusy] = useOwnerState(sessionId, false);
  const generation = useRef(0);
  const owner = useRef(sessionId);
  if (owner.current !== sessionId) {
    owner.current = sessionId;
    generation.current++;
  }
  const current = (request: number, session: string) =>
    request === generation.current && owner.current === session;
  const begin = () => {
    const request = ++generation.current;
    setBusy(true);
    setError('');
    return request;
  };
  const applySnapshot = (next: GitSnapshot, method?: string) => {
    setState(next);
    if (next.revision !== state?.revision && scope !== 'history') {
      setDiff('');
      setFileStats({});
      setBranchEntries([]);
    }
    const visible = new Set(next.entries.map((entry) => entry.path));
    setSelected((selection) =>
      method === 'commit' ? [] : selection.filter((path) => visible.has(path)),
    );
    // A committed message is not the draft of the next commit.
    if (method === 'commit') setMessage('');
  };
  const refresh = async () => {
    const request = begin(),
      session = sessionId;
    try {
      const next = await workspaceCall<GitSnapshot>(session, 'git', 'status');
      if (current(request, session)) applySnapshot(next);
    } catch (e) {
      if (current(request, session)) setError(String(e));
    } finally {
      if (current(request, session)) setBusy(false);
    }
  };
  useEffect(() => {
    setBusy(false);
    void refresh();
    return () => {
      generation.current++;
    };
  }, [sessionId]);
  async function run(method: string, extra: Record<string, unknown> = {}) {
    const request = begin(),
      session = sessionId;
    try {
      const next = await workspaceCall<GitSnapshot>(session, 'git', method, {
        revision: state?.revision,
        paths: selected,
        ...extra,
      });
      if (current(request, session)) {
        applySnapshot(next, method);
        setDiff('');
      }
    } catch (e) {
      if (current(request, session)) setError(String(e));
      try {
        const next = await workspaceCall<GitSnapshot>(session, 'git', 'status');
        if (current(request, session)) applySnapshot(next);
      } catch {
        /* Retain the action error if refreshing its result also fails. */
      }
    } finally {
      if (current(request, session)) setBusy(false);
    }
  }
  async function showDiff(nextScope: string, paths: string[] = []) {
    const request = begin(),
      session = sessionId;
    setScope(nextScope);
    if (nextScope === 'branch' && !paths.length) setBranchEntries([]);
    setActivePath(paths[0] ?? '');
    if (paths.length && closeOverlay()) diffSurface.current?.focus();
    setDiff('');
    try {
      const r = await workspaceCall<{
        text: string;
        entries: GitCommitDiff['entries'];
      }>(session, 'git', 'diff', {
        scope: nextScope,
        revision: state?.revision,
        paths: paths.length ? paths : undefined,
        base,
      });
      if (current(request, session)) {
        setDiff(r.text);
        setFileStats((old) => ({
          ...(scope === nextScope ? old : {}),
          ...Object.fromEntries(
            (r.entries ?? []).map((entry) => [entry.path, entry]),
          ),
        }));
        if (nextScope === 'branch' && !paths.length)
          setBranchEntries(r.entries ?? []);
      }
    } catch (e) {
      if (current(request, session)) setError(String(e));
    } finally {
      if (current(request, session)) setBusy(false);
    }
  }
  async function loadHistory(more = false) {
    const request = begin(),
      session = sessionId;
    try {
      const next = await workspaceCall<GitHistory>(session, 'git', 'history', {
        ...(more && history
          ? { head: history.head, offset: history.commits.length }
          : {}),
      });
      if (current(request, session))
        setHistory(
          more && history
            ? { ...next, commits: [...history.commits, ...next.commits] }
            : next,
        );
    } catch (e) {
      if (current(request, session)) setError(String(e));
    } finally {
      if (current(request, session)) setBusy(false);
    }
  }
  async function showCommit(id: string, paths: string[] = []) {
    const request = begin(),
      session = sessionId;
    setScope('history');
    setCommitId(id);
    if (id !== commitId) setCommitEntries([]);
    setActivePath(paths[0] ?? '');
    if (paths.length && closeOverlay()) diffSurface.current?.focus();
    setDiff('');
    try {
      const next = await workspaceCall<GitCommitDiff>(
        session,
        'git',
        'commitDiff',
        { commit: id, ...(paths.length ? { paths } : {}) },
      );
      if (current(request, session)) {
        setDiff(next.text);
        if (!paths.length) setCommitEntries(next.entries);
      }
    } catch (e) {
      if (current(request, session)) setError(String(e));
    } finally {
      if (current(request, session)) setBusy(false);
    }
  }
  const readonly = scope === 'history';
  const openFile = (file: PendingFile) => {
    if (file.readonly) void showCommit(file.commitId, [file.path]);
    else void showDiff(file.scope, [file.path]);
  };
  const [pendingFile, setPendingFile] = useOwnerState<PendingFile | null>(
    sessionId,
    null,
  );
  useEffect(() => {
    if (busy || !pendingFile) return;
    setPendingFile(null);
    openFile(pendingFile);
  }, [busy, pendingFile]);
  const canMutate = !readonly && scope !== 'branch';
  const files = useMemo<
    (GitSnapshot['entries'][number] & {
      added?: number | null;
      removed?: number | null;
    })[]
  >(
    () =>
      readonly
        ? commitEntries.map((entry) => ({
            ...entry,
            index: entry.status,
            working: entry.status,
          }))
        : scope === 'branch'
          ? branchEntries.map((entry) => ({
              ...entry,
              index: entry.status,
              working: entry.status,
            }))
          : (state?.entries ?? [])
              .map((entry) => ({ ...entry, ...fileStats[entry.path] }))
              .filter((entry) =>
                scope === 'index'
                  ? entry.index.trim() && entry.index !== '?'
                  : entry.working.trim() || entry.index === '?',
              ),
    [readonly, commitEntries, branchEntries, scope, state?.entries, fileStats],
  );
  const visibleFiles = useMemo(
    () =>
      files.filter((entry) =>
        query
          .toLocaleLowerCase()
          .split(/\s+/)
          .every((part) => entry.path.toLocaleLowerCase().includes(part)),
      ),
    [files, query],
  );
  const filesByPath = useMemo(
    () => new Map(files.map((entry) => [entry.path, entry])),
    [files],
  );
  const selectedPaths = useMemo(() => new Set(selected), [selected]);
  const tree = useMemo(() => {
    const collapsed = new Set(
      closedFolders.map((path) => path.replace(/\/$/, '')),
    );
    return buildFileTreeRows(
      visibleFiles.map((entry) => entry.path),
      (path) => !!query.trim() || !collapsed.has(path),
    );
  }, [visibleFiles, closedFolders, query]);
  const largeComparison = !activePath && files.length > 200;
  const locatorMatches = files.filter((entry) =>
    locatorQuery
      .toLocaleLowerCase()
      .split(/\s+/)
      .every((part) => entry.path.toLocaleLowerCase().includes(part)),
  );
  const locatorResults = locatorMatches.slice(0, 100);
  const inspect = (path: string) => {
    locatorSelected.current = true;
    setLocatorOpen(false);
    if (readonly) void showCommit(commitId, [path]);
    else void showDiff(scope, [path]);
  };
  const delta = (entry: { added?: number | null; removed?: number | null }) =>
    entry.added === undefined ? null : entry.added === null ? (
      <span className="muted">{t('binary')}</span>
    ) : (
      <span className="native-git-delta">
        <span>+{entry.added}</span>
        <span>−{entry.removed}</span>
      </span>
    );
  const conflict = (entry: GitSnapshot['entries'][number]) =>
    ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(
      entry.index + entry.working,
    );
  const hasConflicts = state?.entries.some(conflict);
  const fileStatus = (entry: GitSnapshot['entries'][number]) => {
    if (conflict(entry)) return t('conflict');
    if (entry.index === '?') return t('untracked');
    const code =
      scope === 'index' ? entry.index : entry.working.trim() || entry.index;
    return code === 'A'
      ? t('added')
      : code === 'D'
        ? t('deleted')
        : code === 'R'
          ? t('renamed')
          : t('modified');
  };
  return (
    <section
      className={`native-git${embedded ? ' embedded' : ''}`}
      aria-label={t('git')}
      aria-busy={busy}
      data-revision={state?.revision}
      data-branch={state?.branch}
      data-diff-scope={scope}
      data-commit={readonly ? commitId : undefined}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && !locatorOpen && closeOverlay()) {
          event.preventDefault();
          event.stopPropagation();
          indexToggle.current?.focus();
        }
      }}
    >
      <header className="inspector-heading">
        {!embedded && <h2>{t('git')}</h2>}
        {state?.branch && (
          <span className="native-git-branch" title={state.branch}>
            <GitBranch size={13} aria-hidden="true" />
            <span>{state.branch}</span>
          </span>
        )}
        <IconButton
          label={t('search changed files')}
          ref={locatorTrigger}
          disabled={busy}
          onClick={() => {
            locatorSelected.current = false;
            setLocatorIndex(0);
            setLocatorOpen(true);
          }}
        >
          <Search size={14} />
        </IconButton>
        <IconButton
          label={t('change index')}
          ref={indexToggle}
          aria-pressed={indexOpen}
          onClick={() => setIndexOpen(!indexOpen)}
        >
          <ListTree size={14} />
        </IconButton>
        <IconButton
          label={t('refresh')}
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RotateCcw size={14} />
        </IconButton>
      </header>
      {error && <WorkspaceServiceError key={sessionId} error={error} />}
      {draftUnavailable && (
        <p className="panel-note" role="status">
          {t(
            'local draft storage is unavailable; keep this panel open and copy your text before leaving',
          )}
        </p>
      )}
      {canMutate && (
        <>
          <details className="native-git-operation-selection">
            <summary>
              {t('operation selection ({n})', { n: selected.length })}
            </summary>
            <ul>
              {selected.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
            <Button
              disabled={!selected.length || busy}
              onClick={() => setSelected([])}
            >
              {t('clear operation selection')}
            </Button>
          </details>
          <label className="field-label">
            {t('commit message')}
            <input
              className="input"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <Button
            className="primary git-commit"
            disabled={
              busy || !!hasConflicts || !message.trim() || !selected.length
            }
            onClick={() => run('commit', { message })}
          >
            {t('commit selected')}
          </Button>
        </>
      )}
      <div
        className="native-git-scopes segmented"
        role="group"
        aria-label={t('show changes')}
      >
        {(['working', 'index', 'branch'] as const).map((s) => (
          <button
            key={s}
            disabled={busy}
            className={scope === s ? 'active' : ''}
            aria-pressed={scope === s}
            onClick={() => showDiff(s)}
          >
            {s === 'working'
              ? t('unstaged')
              : s === 'index'
                ? t('staged')
                : t('whole branch')}
          </button>
        ))}
      </div>
      {scope === 'branch' && (
        <label className="field-label">
          {t('compare with')}
          <input
            className="input"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
          <Button onClick={() => showDiff('branch')}>{t('refresh')}</Button>
        </label>
      )}
      {canMutate && (
        <div className="native-git-actions">
          <Button
            disabled={busy || !selected.length}
            onClick={() => run('stage')}
          >
            {t('stage selected')}
          </Button>
          <Button
            disabled={busy || !selected.length}
            onClick={() => run('unstage')}
          >
            {t('unstage selected')}
          </Button>
          <Button
            disabled={busy || !!hasConflicts || !!state?.merging}
            onClick={() => run('push')}
          >
            {t('push branch')}
          </Button>
        </div>
      )}
      <div
        ref={diffBrowser}
        className={`native-git-browser${indexOpen ? ' with-index' : ''}`}
      >
        <div className="native-git-content">
          <div ref={diffSurface} tabIndex={0} aria-label={t('git diff')}>
            {largeComparison ? (
              <p className="panel-note" role="note">
                {t('select a file to inspect this large comparison')}{' '}
                {tn(files.length, '{n} changed file', '{n} changed files')}{' '}
                <Button onClick={() => setIndexOpen(true)}>
                  {t('change index')}
                </Button>
              </p>
            ) : diff ? (
              <DiffBlock diff={gitDiffView(diff)} />
            ) : (
              <p className="muted">{t('select a file to inspect its diff')}</p>
            )}
          </div>
          {!readonly &&
            !largeComparison &&
            scope !== 'branch' &&
            gitHunks(diff).map((patch, i) => (
              <div className="native-git-hunk panel-section" key={i}>
                <DiffBlock
                  diff={gitDiffView(patch.slice(patch.indexOf('@@ ')))}
                  compact
                />
                <Button
                  disabled={busy}
                  onClick={() =>
                    run('applyHunk', {
                      patch,
                      action: scope === 'index' ? 'unstage' : 'stage',
                    })
                  }
                >
                  {scope === 'index'
                    ? t('unstage this hunk')
                    : t('stage this hunk')}
                </Button>
                {scope === 'working' && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(t('discard this hunk from disk?')))
                        void run('discard', { patch });
                    }}
                  >
                    {t('discard this hunk')}
                  </Button>
                )}
              </div>
            ))}
        </div>
        <ResizableContextIndex
          ownerKey={sessionId}
          resourceKey="git"
          open={indexOpen}
          className="native-git-index"
        >
          <div className="native-git-index-heading">
            <Button
              disabled={busy}
              onClick={() =>
                readonly ? void showCommit(commitId) : void showDiff(scope)
              }
            >
              {t('all changes')}
            </Button>
            <span className="muted">
              {visibleFiles.length} / {files.length}
            </span>
          </div>
          {readonly && (
            <p className="panel-note" role="note">
              {t(
                'commit view is read-only; merge commits compare with their first parent',
              )}{' '}
              <code>{commitId.slice(0, 8)}</code>
            </p>
          )}
          <input
            className="input"
            type="search"
            aria-label={t('filter changed files')}
            placeholder={t('filter changed files')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="native-git-tree">
            <VirtualFileTree
              rows={tree.rows}
              selectedPath={activePath}
              ownerKey={sessionId}
              filterKey={JSON.stringify([scope, commitId, query])}
              ariaLabel={t('changed files')}
              onSelect={(path) =>
                // A file chosen while an operation runs opens once it finishes,
                // rather than cancelling that operation or being dropped.
                busy
                  ? setPendingFile({ path, readonly, commitId, scope })
                  : openFile({ path, readonly, commitId, scope })
              }
              onToggle={(path) => {
                if (query.trim()) return;
                setClosedFolders((old) =>
                  old.includes(path)
                    ? old.filter((value) => value !== path)
                    : [...old, path],
                );
              }}
              rowClassName={(row) =>
                row.folder ? 'native-git-directory' : 'change-entry'
              }
              renderLeading={(row) =>
                !row.folder && canMutate ? (
                  <input
                    type="checkbox"
                    disabled={busy}
                    aria-label={row.path}
                    checked={selectedPaths.has(row.path)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      setSelected((old) =>
                        event.target.checked
                          ? [...new Set([...old, row.path])]
                          : old.filter((path) => path !== row.path),
                      )
                    }
                  />
                ) : null
              }
              renderTrailing={(row) => {
                const entry = filesByPath.get(row.path);
                return entry ? (
                  <>
                    {delta(entry)}
                    <span
                      className={
                        conflict(entry)
                          ? 'git-file-state conflict'
                          : 'git-file-state'
                      }
                    >
                      {fileStatus(entry)}
                    </span>
                    {!readonly && (
                      <IconButton
                        label={t('open file')}
                        onClick={(event) => {
                          event.stopPropagation();
                          onFile?.(entry.path);
                        }}
                      >
                        <ExternalLink size={14} />
                      </IconButton>
                    )}
                  </>
                ) : null;
              }}
            />
          </div>
          {!visibleFiles.length && (
            <p className="muted">
              {query
                ? t('no matching changed files')
                : t('no changed files in this scope')}
            </p>
          )}
          <details
            className="native-git-history"
            onToggle={(event) => {
              if (event.currentTarget.open && !history && !busy)
                void loadHistory();
            }}
          >
            <summary>{t('commits')}</summary>
            {history && (
              <>
                <Button disabled={busy} onClick={() => void loadHistory()}>
                  {t('refresh commits')}
                </Button>
                <ul className="native-git-commits">
                  {history.commits.map((commit) => (
                    <li key={commit.id}>
                      <button
                        disabled={busy}
                        className="change-file"
                        aria-current={
                          readonly && commitId === commit.id
                            ? 'true'
                            : undefined
                        }
                        onClick={() => void showCommit(commit.id)}
                      >
                        <span>{commit.subject}</span>
                        <small>
                          {commit.id.slice(0, 8)} · {commit.author} ·{' '}
                          {commit.date.slice(0, 10)}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
                {!history.commits.length && (
                  <p className="muted">{t('no commits yet')}</p>
                )}
                {history.hasMore && (
                  <Button
                    disabled={busy}
                    onClick={() => void loadHistory(true)}
                  >
                    {t('load more commits')}
                  </Button>
                )}
              </>
            )}
          </details>
        </ResizableContextIndex>
      </div>
      {canMutate && state?.merging && (
        <>
          {hasConflicts && (
            <p className="panel-note" role="status">
              {t('resolve and stage conflicts first')}
            </p>
          )}
          <div className="native-git-actions">
            <Button disabled={busy} onClick={() => run('continueMerge')}>
              {t('continue merge')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    t('abort this merge and restore its pre-merge state?'),
                  )
                )
                  void run('abortMerge');
              }}
            >
              {t('abort merge')}
            </Button>
          </div>
        </>
      )}
      {!readonly && (
        <DeliveryPanel
          embedded
          sessionId={sessionId}
          revision={state?.revision}
          onOpenExternal={onOpenExternal}
        />
      )}
      {busy && <p role="status">{t('working…')}</p>}
      <Modal
        open={locatorOpen}
        onOpenChange={setLocatorOpen}
        title={t('search changed files')}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          (locatorSelected.current
            ? diffSurface.current
            : locatorTrigger.current
          )?.focus();
          locatorSelected.current = false;
        }}
      >
        <SearchInput
          value={locatorQuery}
          onChange={(value) => {
            setLocatorQuery(value);
            setLocatorIndex(0);
          }}
          label={t('search changed files')}
          autoFocus
          inputProps={{
            role: 'combobox',
            'aria-expanded': true,
            'aria-controls': `${locatorId}-results`,
            'aria-activedescendant': locatorResults[locatorIndex]
              ? `${locatorId}-result-${locatorIndex}`
              : undefined,
            onKeyDown: (event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setLocatorIndex((old) =>
                  locatorResults.length
                    ? (old +
                        (event.key === 'ArrowDown' ? 1 : -1) +
                        locatorResults.length) %
                      locatorResults.length
                    : 0,
                );
              }
              if (event.key === 'Enter' && locatorResults[locatorIndex]) {
                event.preventDefault();
                inspect(locatorResults[locatorIndex]!.path);
              }
            },
          }}
        />
        <div
          className="native-git-locator"
          role="listbox"
          id={`${locatorId}-results`}
          aria-label={t('changed files')}
        >
          {locatorResults.map((entry, i) => (
            <button
              type="button"
              role="option"
              id={`${locatorId}-result-${i}`}
              aria-selected={i === locatorIndex}
              key={entry.path}
              onClick={() => inspect(entry.path)}
            >
              <FileText size={14} aria-hidden="true" />
              <span>
                <strong>{entry.path.split('/').at(-1)}</strong>
                <small>
                  {entry.path.includes('/')
                    ? entry.path.slice(0, entry.path.lastIndexOf('/'))
                    : t('workspace')}
                </small>
              </span>
              {delta(entry)}
            </button>
          ))}
        </div>
        {!locatorMatches.length && (
          <p className="muted">{t('no matching changed files')}</p>
        )}
        {locatorMatches.length > locatorResults.length && (
          <p className="muted">
            {tn(
              locatorMatches.length - locatorResults.length,
              '{n} more file; narrow your search',
              '{n} more files; narrow your search',
            )}
          </p>
        )}
      </Modal>
    </section>
  );
}
