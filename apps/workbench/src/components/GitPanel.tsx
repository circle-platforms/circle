import { useEffect, useState } from 'react';
import { workspaceCall } from '../model/workspace-client';
import { t } from '../i18n';
import './GitPanel.css';
import { DeliveryPanel } from './DeliveryPanel';
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
export function GitPanel({
  sessionId,
  onFile,
  onOpenExternal,
}: {
  sessionId: string;
  onFile?: (path: string) => void;
  onOpenExternal?: (url: string) => void;
}) {
  const [state, setState] = useState<GitSnapshot | null>(null);
  const [scope, setScope] = useState('working');
  const [base, setBase] = useState('origin/main');
  const [selected, setSelected] = useState<string[]>([]);
  const [diff, setDiff] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const next = await workspaceCall<GitSnapshot>(sessionId, 'git', 'status');
    setState(next);
    return next;
  };
  useEffect(() => {
    setState(null);
    setSelected([]);
    setDiff('');
    refresh().catch((e) => setError(String(e)));
  }, [sessionId]);
  async function run(method: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      const next = await workspaceCall<GitSnapshot>(sessionId, 'git', method, {
        revision: state?.revision,
        paths: selected,
        ...extra,
      });
      setState(next);
      setDiff('');
    } catch (e) {
      setError(String(e));
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function showDiff(nextScope: string, paths = selected) {
    setScope(nextScope);
    setError('');
    try {
      const r = await workspaceCall<{ text: string }>(
        sessionId,
        'git',
        'diff',
        {
          scope: nextScope,
          paths: paths.length ? paths : undefined,
          base,
        },
      );
      setDiff(r.text);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="native-git" aria-label={t('git workspace')}>
      <header>
        <strong>{t('git workspace')}</strong>
        <span>{state?.branch}</span>
        <button
          disabled={busy}
          onClick={() => refresh().catch((e) => setError(String(e)))}
        >
          {t('refresh')}
        </button>
      </header>
      <p>
        {t(
          'git includes manual and agent changes; session changes remain in Changes',
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      <div
        className="native-git-scopes"
        role="group"
        aria-label={t('diff scope')}
      >
        {(['working', 'index', 'branch'] as const).map((s) => (
          <button
            key={s}
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
        <label>
          {t('comparison base')}
          <input value={base} onChange={(e) => setBase(e.target.value)} />
          <button onClick={() => showDiff('branch')}>{t('refresh')}</button>
        </label>
      )}
      <ul>
        {state?.entries.map((e) => (
          <li key={e.path}>
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
              onClick={() => {
                setSelected([e.path]);
                void showDiff(scope, [e.path]);
              }}
            >
              {e.path}
            </button>
            <button onClick={() => onFile?.(e.path)}>{t('open file')}</button>
          </li>
        ))}
      </ul>
      <div className="native-git-actions">
        <button
          disabled={busy || !selected.length}
          onClick={() => run('stage')}
        >
          {t('stage selected')}
        </button>
        <button
          disabled={busy || !selected.length}
          onClick={() => run('unstage')}
        >
          {t('unstage selected')}
        </button>
        <button disabled={busy} onClick={() => run('push')}>
          {t('push branch')}
        </button>
      </div>
      <pre tabIndex={0} aria-label={t('git diff')}>
        {diff || t('select a file to inspect its diff')}
      </pre>
      {scope !== 'branch' &&
        gitHunks(diff).map((patch, i) => (
          <div className="native-git-hunk" key={i}>
            <pre>{patch.slice(patch.indexOf('@@ '))}</pre>
            <button
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
            </button>
            {scope === 'working' && (
              <button
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('discard this hunk from disk?')))
                    void run('discard', { patch });
                }}
              >
                {t('discard this hunk')}
              </button>
            )}
          </div>
        ))}
      <label>
        {t('commit message')}
        <input value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <button
        disabled={busy || !message.trim() || !selected.length}
        onClick={() => run('commit', { message })}
      >
        {t('commit selected staged files')}
      </button>
      {state?.merging && (
        <div>
          <button disabled={busy} onClick={() => run('continueMerge')}>
            {t('continue merge')}
          </button>
          <button
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
          </button>
        </div>
      )}
      <DeliveryPanel
        sessionId={sessionId}
        revision={state?.revision}
        onOpenExternal={onOpenExternal}
      />
      {busy && <p role="status">{t('working…')}</p>}
    </section>
  );
}
