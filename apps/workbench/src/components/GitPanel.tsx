import { useOwnerDraft } from '../model/owner-draft';
import { useOwnerState } from '../model/owner-state';
import { useEffect, useRef } from 'react';
import { workspaceCall } from '../model/workspace-client';
import { t } from '../i18n';
import './GitPanel.css';
import { DeliveryPanel, WorkspaceServiceError } from './DeliveryPanel';
import { Button } from './common';
import { DiffBlock } from './DiffBlock';
import type { DiffView } from '../model/types';
import type { GitSnapshot } from '../../../desktop/src/workspace/git';
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
    const visible = new Set(next.entries.map((entry) => entry.path));
    setSelected((selection) =>
      method === 'commit' ? [] : selection.filter((path) => visible.has(path)),
    );
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
  async function showDiff(nextScope: string, paths = selected) {
    const request = begin(),
      session = sessionId;
    setScope(nextScope);
    try {
      const r = await workspaceCall<{ text: string }>(session, 'git', 'diff', {
        scope: nextScope,
        paths: paths.length ? paths : undefined,
        base,
      });
      if (current(request, session)) setDiff(r.text);
    } catch (e) {
      if (current(request, session)) setError(String(e));
    } finally {
      if (current(request, session)) setBusy(false);
    }
  }
  return (
    <section
      className={`native-git${embedded ? ' embedded' : ''}`}
      aria-label={t('git workspace')}
      aria-busy={busy}
      data-revision={state?.revision}
      data-branch={state?.branch}
    >
      <header className="inspector-heading">
        {!embedded && <h2>{t('git workspace')}</h2>}
        <span>{state?.branch}</span>
        <Button disabled={busy} onClick={() => void refresh()}>
          {t('refresh')}
        </Button>
      </header>
      {error && <WorkspaceServiceError key={sessionId} error={error} />}
      {draftUnavailable && (
        <p className="panel-note" role="status">
          {t(
            'local draft storage is unavailable; keep this panel open and copy your text before leaving',
          )}
        </p>
      )}
      <div
        className="native-git-scopes segmented"
        role="group"
        aria-label={t('diff scope')}
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
              ? t('working tree')
              : s === 'index'
                ? t('staged changes')
                : t('branch changes')}
          </button>
        ))}
      </div>
      {scope === 'branch' && (
        <label className="field-label">
          {t('comparison base')}
          <input
            className="input"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
          <Button onClick={() => showDiff('branch')}>{t('refresh')}</Button>
        </label>
      )}
      <ul className="native-git-files">
        {state?.entries.map((e) => (
          <li className="change-entry" key={e.path}>
            <input
              type="checkbox"
              checked={selected.includes(e.path)}
              aria-label={e.path}
              onChange={(event) =>
                setSelected((old) =>
                  event.target.checked
                    ? [...old, e.path]
                    : old.filter((p) => p !== e.path),
                )
              }
            />
            <code>
              {e.index}
              {e.working}
            </code>
            <button
              className="change-file"
              onClick={() => {
                setSelected([e.path]);
                void showDiff(scope, [e.path]);
              }}
            >
              <span>{e.path}</span>
            </button>
            <Button onClick={() => onFile?.(e.path)}>{t('open file')}</Button>
          </li>
        ))}
      </ul>
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
        <Button disabled={busy} onClick={() => run('push')}>
          {t('push branch')}
        </Button>
      </div>
      <div tabIndex={0} aria-label={t('git diff')}>
        {diff ? (
          <DiffBlock diff={gitDiffView(diff)} />
        ) : (
          <p className="muted">{t('select a file to inspect its diff')}</p>
        )}
      </div>
      {scope !== 'branch' &&
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
      <label className="field-label">
        {t('commit message')}
        <input
          className="input"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      <Button
        disabled={busy || !message.trim() || !selected.length}
        onClick={() => run('commit', { message })}
      >
        {t('commit selected staged files')}
      </Button>
      {state?.merging && (
        <div>
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
      )}
      <DeliveryPanel
        embedded
        sessionId={sessionId}
        revision={state?.revision}
        onOpenExternal={onOpenExternal}
      />
      {busy && <p role="status">{t('working…')}</p>}
    </section>
  );
}
