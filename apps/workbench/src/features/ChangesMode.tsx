import { FileText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useRuntime } from '../app/context';
import { Button } from '../components/common';
import { DiffBlock } from '../components/DiffBlock';
import { t } from '../i18n';
import {
  diffViewFromPatch,
  sessionChangeRows,
  type ChangeRow,
} from '../model/changes';
import { gitFilePatch, useGitChanges } from '../model/git-changes';
import { useOwnerState } from '../model/owner-state';
import { currentSession } from '../model/state';
import type { DiffView } from '../model/types';
import { ModeButtons } from './mode-chrome';

type Scope = 'session' | 'all';

const LETTER_TITLE = {
  M: () => t('modified'),
  A: () => t('added'),
  D: () => t('deleted'),
};

function Counts({ row }: { row: ChangeRow }) {
  if (row.added === null && row.removed === null) return null;
  return (
    <span className="changes-counts">
      {!!row.added && <span className="add">+{row.added}</span>}
      {!!row.removed && <span className="del">−{row.removed}</span>}
    </span>
  );
}

/**
 * The files that differ, as one list: those this conversation changed, or everything
 * that differs from the last commit. A file shows its difference below the list, and
 * opens in the files mode from there.
 */
export function ChangesMode({
  selection,
  active,
  onFile,
}: {
  /** A file the person was sent here for. */
  selection: string;
  /** The mode is the one on screen. */
  active: boolean;
  onFile: (path: string, line?: number, column?: number) => void;
}) {
  const { snapshot, runtime } = useRuntime();
  const session = currentSession(snapshot);
  const workspace = snapshot.workspaces.find(
    (item) => item.id === session.workspaceId,
  );
  const live = runtime.mode === 'live';
  const [scope, setScope] = useOwnerState<Scope>(session.id, 'session');
  const [chosen, setChosen] = useOwnerState(session.id, '');
  const sessionRows = useMemo(
    () => sessionChangeRows(session.changes, workspace?.path),
    [session.changes, workspace?.path],
  );
  const git = useGitChanges({
    sessionId: session.id,
    live,
    active: active && scope === 'all',
    busy: session.state !== 'idle',
  });
  // In the preview there is no repository; its sample files with a status stand in.
  const previewRows: ChangeRow[] = useMemo(
    () =>
      snapshot.files
        .filter(
          (file) => file.workspaceId === session.workspaceId && file.status,
        )
        .map((file) => {
          const parts = file.path.split('/');
          return {
            path: file.path,
            name: parts.at(-1) ?? file.path,
            folder: parts.slice(0, -1).join('/'),
            letter: file.status === 'added' ? ('A' as const) : ('M' as const),
            added: null,
            removed: null,
          };
        }),
    [snapshot.files, session.workspaceId],
  );
  const rows: ChangeRow[] =
    scope === 'session' ? sessionRows : live ? (git.files ?? []) : previewRows;

  // Sent here for a file: show it, in the list that has it.
  useEffect(() => {
    if (!selection) return;
    setChosen(selection);
    if (!sessionRows.some((row) => row.path === selection)) setScope('all');
    else setScope('session');
  }, [selection]);
  const current = rows.find((row) => row.path === chosen) ?? rows[0];

  // A file's difference: the session's own, or the file against the last commit.
  const [patch, setPatch] = useState<{
    key: string;
    diff?: DiffView;
    error?: string;
  }>({ key: '' });
  const sessionDiff =
    scope === 'session' && current
      ? sessionRows.find((row) => row.path === current.path)?.diff
      : undefined;
  const key = current ? `${session.id}\n${scope}\n${current.path}` : '';
  useEffect(() => {
    if (!current || scope !== 'all' || !live) return;
    let stale = false;
    gitFilePatch(session.id, current.path).then(
      (result) => {
        if (!stale) setPatch({ key, diff: diffViewFromPatch(result.text) });
      },
      (reason) => {
        if (!stale)
          setPatch({
            key,
            error: reason instanceof Error ? reason.message : String(reason),
          });
      },
    );
    return () => {
      stale = true;
    };
  }, [key, scope, live, git.files]);
  const diff = sessionDiff ?? (patch.key === key ? patch.diff : undefined);

  return (
    <section className="changes-mode">
      <header className="mode-toolbar">
        <div className="segmented" role="group" aria-label={t('changes')}>
          {(
            [
              ['session', t('this session')],
              ['all', t('all uncommitted')],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={scope === id ? 'active' : ''}
              aria-pressed={scope === id}
              onClick={() => setScope(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="mode-toolbar-end">
          <ModeButtons />
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="panel-note changes-empty" role="status">
          {scope === 'all' && git.error
            ? t('could not read the changes')
            : scope === 'all' && live && !git.files
              ? t('reading the changes…')
              : t('no files changed')}
        </p>
      ) : (
        <>
          <ul className="changes-list" aria-label={t('changed files')}>
            {rows.map((row) => (
              <li key={row.path}>
                <button
                  type="button"
                  className="changes-row"
                  aria-current={row.path === current?.path || undefined}
                  title={row.path}
                  onClick={() => setChosen(row.path)}
                >
                  <span
                    className="overview-letter"
                    data-letter={row.letter}
                    title={LETTER_TITLE[row.letter]()}
                  >
                    {row.letter}
                  </span>
                  <span className="changes-name">{row.name}</span>
                  {row.folder && (
                    <small className="changes-folder">{row.folder}</small>
                  )}
                  <Counts row={row} />
                </button>
              </li>
            ))}
          </ul>
          {current && (
            <div className="changes-file">
              <header>
                <span
                  className="overview-letter"
                  data-letter={current.letter}
                  title={LETTER_TITLE[current.letter]()}
                >
                  {current.letter}
                </span>
                <span className="changes-path" title={current.path}>
                  {current.path}
                </span>
                {current.letter !== 'D' && (
                  <Button onClick={() => onFile(current.path)}>
                    <FileText size={13} aria-hidden />
                    {t('open file')}
                  </Button>
                )}
              </header>
              <div className="changes-diff">
                {diff ? (
                  <DiffBlock diff={diff} compact />
                ) : scope === 'all' && live ? (
                  <p className="panel-note" role="status">
                    {patch.key === key && patch.error
                      ? t('could not read the difference')
                      : t('reading the difference…')}
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
