import { useEffect, useRef, useState } from 'react';
import { FileText, Save, X } from 'lucide-react';
import { Tooltip } from 'radix-ui';
import type { IRange } from 'monaco-editor';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import { Button, IconButton, Status } from '../components/common';
import { t, tn } from '../i18n';
import {
  workspaceCall,
  subscribeWorkspace,
  connectWorkspaceStreams,
} from '../model/workspace-client';
import {
  NativeCodeEditor,
  editorDocuments,
  editorBuffer,
  editorUri,
  pendingEditorDocuments,
  retainedModel,
  refreshEditorDocument,
  setEditorDocument,
} from './NativeCodeEditor';
import type { EditorDocument } from './NativeCodeEditor';
import { Markdown } from '../components/Markdown';
import { gitFilePatch } from '../model/git-changes';
import { gutterMarks, type GutterMark } from '../model/gutter-marks';
import type { SourceResourceOwner } from '../model/source-resource-owner';
import { ModeButtons } from './mode-chrome';
type SaveFlight = {
  queued?: { all: boolean; restore: boolean };
  writes: Map<string, string>;
  latest: Map<string, EditorDocument>;
};
const MODE_LABEL = {
  edit: (readOnly: boolean) => (readOnly ? t('view') : t('edit')),
  diff: () => t('diff'),
};
export function FileViewer({
  path: requestedPath,
  line,
  column,
  resourceOwner,
  onClose,
  onNavigate: onSourceNavigate,
}: {
  path: string;
  line?: number;
  column?: number;
  resourceOwner?: SourceResourceOwner;
  onClose: () => void;
  onNavigate?: (
    path: string,
    line?: number,
    column?: number,
  ) => void | Promise<void>;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const parentSession = currentSession(snapshot);
  const session = resourceOwner
    ? {
        ...parentSession,
        id: resourceOwner.sessionId,
        workspaceId: resourceOwner.workspaceId,
        readOnly: resourceOwner.readOnly,
      }
    : parentSession;
  const workspaceId = session.workspaceId;
  const [path, setPath] = useState(
    requestedPath.replace(/#L\d+(?:C\d+)?$/, ''),
  );
  const projected = snapshot.files.find(
    (item) => item.path === path && item.workspaceId === workspaceId,
  );
  // Files open editable in place; "diff" compares with the disk or git
  // original only when asked. The changes mode is where a file's difference is read.
  const [mode, setMode] = useState<'diff' | 'edit'>('edit');
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const identity = JSON.stringify([workspaceId, session.id, path]);
  const markdown = /\.(md|markdown|mdown)$/i.test(path);
  // Reading is a presentation of the retained editor buffer, never another document.
  const [readingOwner, setReadingOwner] = useState<string | null>(null);
  const reading = markdown && readingOwner === identity;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [value, setValue] = useState(
    projected?.draft ?? projected?.content ?? '',
  );
  const [selection, setSelection] = useState<IRange>();
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<EditorDocument | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveQueued, setSaveQueued] = useState(false);
  const inFlightSaves = useRef(new Map<string, SaveFlight>());
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [moved, setMoved] = useState<EditorDocument | null>(null);
  const [bufferCount, setBufferCount] = useState(0);
  const [marks, setMarks] = useState<GutterMark[]>([]);
  const live = runtime.mode === 'live';
  useEffect(() => {
    if (!resourceOwner || !live) return;
    return connectWorkspaceStreams(workspaceId, session.id, (error) =>
      setError(String(error)),
    );
  }, [workspaceId, session.id, live, !!resourceOwner]);
  const language = /\.[cm]?tsx?$/.test(path)
    ? 'typescript'
    : /\.[cm]?jsx?$/.test(path)
      ? 'javascript'
      : (projected?.language ?? 'plaintext');
  // A task that only reads, such as a reviewer, saves nothing from its own conversation
  // either: the runtime refuses it, and the file says so before a save is tried.
  const readOnlyTask = snapshot.agents.some(
    (item) =>
      (item.resourceSessionId ?? item.id) === session.id &&
      item.task &&
      item.readOnly,
  );
  const readOnly = resourceOwner
    ? resourceOwner.readOnly
    : readOnlyTask ||
      (session.readOnly &&
        !['plan', 'plan.md'].includes(path.split('/').at(-1)!));
  const sourceWorkspace = snapshot.workspaces.find(
    (item) => item.id === workspaceId,
  );
  const sourceAgent =
    resourceOwner &&
    snapshot.agents.find(
      (item) =>
        item.resourceSessionId === resourceOwner.sessionId &&
        item.workspaceId === resourceOwner.workspaceId &&
        item.id === resourceOwner.sessionId,
    );
  const sourceLabel = resourceOwner
    ? sourceAgent
      ? t('agent source: {name}', { name: sourceAgent.name })
      : t('agent source')
    : t('workspace: {name}', {
        name: sourceWorkspace?.name ?? t('workspace'),
      });
  // The heading names the file once; its folder and owner follow, muted.
  const shownSource = resourceOwner
    ? sourceLabel
    : (sourceWorkspace?.name ?? t('workspace'));
  const sourceDirectory = sourceWorkspace?.path;
  const fileName = path.split('/').at(-1) || path;
  const fileFolder = path.includes('/')
    ? path.slice(0, path.lastIndexOf('/'))
    : '';
  const sourceHeading = (
    <div className="file-view-title">
      <div className="file-view-filename">
        <FileText size={15} aria-hidden />
        <strong title={path}>{fileName}</strong>
        {projected?.status && <Status value={projected.status} />}
      </div>
      <div className="file-source-summary">
        {fileFolder && (
          <span className="file-source-folder" title={fileFolder}>
            {fileFolder}
          </span>
        )}
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span
              tabIndex={0}
              className="file-source-origin"
              aria-label={
                sourceDirectory
                  ? `${sourceLabel}: ${sourceDirectory}`
                  : sourceLabel
              }
            >
              {shownSource}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="tooltip file-source-directory"
              sideOffset={7}
            >
              {sourceLabel}
              <br />
              {sourceDirectory ?? t('source directory is not available')}
              <Tooltip.Arrow />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        {readOnly && (
          <span className="file-source-readonly">{t('read-only')}</span>
        )}
      </div>
    </div>
  );
  const showDocument = (doc: EditorDocument) => {
    const uri = editorUri(workspaceId, doc.path).toString();
    const model = retainedModel(
      workspaceId,
      doc.path,
      projected?.draft ?? doc.content,
      language,
    );
    let retained = editorDocuments.get(uri);
    if (retained && retained.revision !== doc.revision) {
      const result = refreshEditorDocument(workspaceId, doc);
      if (result === 'conflict') {
        setConflict(doc);
        setError(t('file changed on disk; your changes are kept'));
      }
      retained = editorDocuments.get(uri);
    }
    if (!retained) setEditorDocument(workspaceId, doc);
    setLoadedKey(JSON.stringify([workspaceId, session.id, doc.path]));
    if (doc.path !== path) {
      setPath(doc.path);
      void onSourceNavigate?.(doc.path);
    }
    setDocument(retained ?? doc);
    setValue(
      retainedModel(
        workspaceId,
        doc.path,
        projected?.draft ?? doc.content,
        language,
      ).getValue(),
    );
  };
  useEffect(() => {
    const next = requestedPath.replace(/#L\d+(?:C\d+)?$/, '');
    setPath(next);
    const anchor = requestedPath.match(/#L(\d+)(?:C(\d+))?$/);
    const row = line ?? (anchor ? Number(anchor[1]) : undefined);
    if (row) {
      setReadingOwner(null);
      setSelection({
        startLineNumber: row,
        startColumn: column ?? Number(anchor?.[2] ?? 1),
        endLineNumber: row,
        endColumn: column ?? Number(anchor?.[2] ?? 1),
      });
    } else setSelection(undefined);
  }, [requestedPath, line, column]);
  useEffect(() => {
    let active = true;
    const readIdentity = identity;
    setError('');
    setConflict(null);
    setMissing(false);
    setMoved(null);
    setDocument(null);
    setLoadedKey(null);
    setSaving(inFlightSaves.current.has(identity));
    setSaveQueued(false);
    setLoading(true);
    if (live) {
      void workspaceCall<EditorDocument>(session.id, 'documents', 'read', {
        path,
      })
        .then((doc) => {
          if (active && currentIdentity.current === readIdentity)
            showDocument(doc);
        })
        .catch((cause) => {
          if (!active || currentIdentity.current !== readIdentity) return;
          retainedModel(workspaceId, path, '', language);
          const prior = editorDocuments.get(
            editorUri(workspaceId, path).toString(),
          );
          if (prior) showDocument(prior);
          const message = String(
            cause instanceof Error ? cause.message : cause,
          );
          const deleted = /ENOENT|no such file|does not exist/i.test(message);
          setMissing(deleted);
          setError(
            deleted && prior
              ? t('file deleted on disk; your changes are kept')
              : message,
          );
        })
        .finally(() => {
          if (active && currentIdentity.current === readIdentity)
            setLoading(false);
        });
    } else {
      if (projected)
        showDocument({ path, content: projected.content, revision: 'preview' });
      setLoading(false);
    }
    return () => {
      active = false;
    };
  }, [path, workspaceId, session.id, live]);
  useEffect(() => {
    const update = () =>
      setBufferCount(pendingEditorDocuments(workspaceId).length);
    const failure = () =>
      setError(
        t('unsaved changes could not be backed up; keep this window open'),
      );
    window.addEventListener('circle-editor-change', update);
    window.addEventListener('circle-editor-persistence-error', failure);
    update();
    return () => {
      window.removeEventListener('circle-editor-change', update);
      window.removeEventListener('circle-editor-persistence-error', failure);
    };
  }, [workspaceId]);
  // Where the file on disk differs from the last commit, read again when its text changes
  // on disk: a save, the model's edit or another program's.
  const diskRevision = document?.revision;
  useEffect(() => setMarks([]), [session.id, path]);
  useEffect(() => {
    if (!live || diskRevision === undefined) return;
    let current = true;
    void gitFilePatch(session.id, path).then(
      ({ text }) => {
        if (current) setMarks(gutterMarks(text));
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [live, session.id, path, diskRevision]);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    let generation = 0;
    const sequences = new Map<string, number>();
    const reads = new Map<string, number>();
    return (() => {
      const unsubscribe = subscribeWorkspace((event) => {
        if (
          event.service !== 'documents' ||
          event.workspaceId !== workspaceId ||
          event.sessionId !== session.id
        )
          return;
        if (event.seq <= (sequences.get(event.epoch) ?? -1)) return;
        sequences.set(event.epoch, event.seq);
        const snapshot = (event.data.snapshot ?? event.data) as {
          files?: { path: string }[];
          changes?: { kind: string; file: { path: string } }[];
        };
        const paths = Array.isArray(event.data.paths)
          ? event.data.paths.filter(
              (item): item is string => typeof item === 'string',
            )
          : (snapshot.changes ?? []).map((change) => change.file.path);
        const currentGeneration = ++generation;
        for (const target of new Set(paths)) {
          const uri = editorUri(workspaceId, target).toString();
          if (!editorDocuments.has(uri)) continue;
          const readVersion = (reads.get(target) ?? 0) + 1;
          reads.set(target, readVersion);
          const removed =
            snapshot.changes?.some(
              (change) =>
                change.kind === 'removed' && change.file.path === target,
            ) && !snapshot.files?.some((file) => file.path === target);
          if (removed) {
            if (target !== path) continue;
            setMissing(true);
            setConflict(null);
            setError(t('file deleted on disk; your changes are kept'));
            const added =
              snapshot.changes
                ?.filter((change) => change.kind === 'added')
                .map((change) => change.file.path) ?? [];
            void Promise.all(
              added.map((candidate) =>
                workspaceCall<EditorDocument>(session.id, 'documents', 'read', {
                  path: candidate,
                }).catch(() => null),
              ),
            ).then((documents) => {
              if (!alive || currentGeneration !== generation) return;
              const previous = editorDocuments.get(uri);
              const matches = documents.filter(
                (document): document is EditorDocument =>
                  !!document && document.content === previous?.content,
              );
              setMoved(matches.length === 1 ? matches[0]! : null);
            });
            continue;
          }
          const readCurrent = async () => {
            // A save of ours that finishes during the read makes the read
            // stale: read again. Saves finish, so this settles; a newer event
            // supersedes it, and only saves that keep overtaking it for this
            // long ask for the file to be reopened.
            const deadline = Date.now() + 10_000;
            for (;;) {
              if (!alive || reads.get(target) !== readVersion) return;
              const baselineRevision = editorDocuments.get(uri)?.revision;
              const document = await workspaceCall<EditorDocument>(
                session.id,
                'documents',
                'read',
                { path: target },
              );
              if (!alive || reads.get(target) !== readVersion) return;
              if (editorDocuments.get(uri)?.revision !== baselineRevision) {
                if (Date.now() > deadline)
                  throw Error(t('the file changed while saving; reopen it'));
                continue;
              }
              const pending = [...inFlightSaves.current.values()].find(
                (flight) => flight.writes.has(uri),
              );
              if (pending) {
                // The pre-save disk baseline is expected while the write is pending.
                if (document.revision === baselineRevision) return;
                pending.latest.set(uri, document);
                if (
                  target === path &&
                  document.content !== pending.writes.get(uri)
                ) {
                  setConflict(document);
                  setError(t('file changed on disk; your changes are kept'));
                }
                return;
              }
              const result = refreshEditorDocument(workspaceId, document);
              if (target !== path) return;
              setMissing(false);
              setMoved(null);
              if (result === 'conflict') {
                setConflict(document);
                setError(t('file changed on disk; your changes are kept'));
              } else if (result === 'updated') {
                setDocument(document);
                setValue(
                  retainedModel(
                    workspaceId,
                    path,
                    document.content,
                    language,
                  ).getValue(),
                );
                setConflict(null);
                setError('');
              }
              return;
            }
          };
          void readCurrent().catch((cause) => {
            if (alive && reads.get(target) === readVersion && target === path)
              setError(String(cause instanceof Error ? cause.message : cause));
          });
        }
      });
      return () => {
        alive = false;
        unsubscribe();
      };
    })();
  }, [workspaceId, session.id, path, live, language]);
  const changed = (text: string) => {
    setValue(text);
    setBufferCount(pendingEditorDocuments(workspaceId).length);
  };
  const navigate = async (target: string) => {
    setMode('edit');
    setReadingOwner(null);
    setPath(target);
    await onSourceNavigate?.(target);
  };
  const save = async (all = false, restore = false) => {
    const buffer = editorBuffer(workspaceId, path);
    if (
      !document ||
      document.path !== path ||
      loadedKey !== identity ||
      !buffer ||
      readOnly
    )
      return;
    const currentFlight = inFlightSaves.current.get(identity);
    if (currentFlight) {
      currentFlight.queued = { all, restore };
      if (currentIdentity.current === identity) setSaveQueued(true);
      return;
    }
    const baseline = editorDocuments.get(buffer.uri) ?? document;
    if (!all && !restore && buffer.content === baseline.content) {
      if (currentIdentity.current === identity) notify(t('file saved'));
      return;
    }
    const flight: SaveFlight = {
      writes: new Map([[buffer.uri, buffer.content]]),
      latest: new Map(),
    };
    inFlightSaves.current.set(identity, flight);
    let completed = false;
    // Capture one immutable target before any asynchronous operation. Never route
    // an old editor's value to whichever path/session is selected after a reply.
    const target = {
      key: identity,
      workspaceId,
      sessionId: session.id,
      path,
      revision: baseline.revision,
      content: buffer.content,
      version: buffer.version,
      fileId: projected?.id,
    };
    const selected = () => currentIdentity.current === target.key;
    if (selected()) {
      setSaving(true);
      setSaveQueued(false);
      setError('');
    }
    try {
      if (!live) {
        if (selected()) notify(t('changes kept in this window'));
        completed = true;
        return;
      }
      if (all) {
        const edits = pendingEditorDocuments(target.workspaceId).map(
          (item) => ({
            path: item.path,
            content: item.content,
            expectedRevision: item.revision,
          }),
        );
        for (const edit of edits)
          flight.writes.set(
            editorUri(target.workspaceId, edit.path).toString(),
            edit.content,
          );
        const result = await workspaceCall<{
          status: string;
          applied?: EditorDocument[];
          committedPaths?: string[];
          remaining?: { path: string }[];
          failures?: { path: string; message?: string }[];
        }>(target.sessionId, 'documents', 'applyEdits', { edits });
        for (const committed of result.committedPaths ?? []) {
          const doc =
            result.applied?.find((document) => document.path === committed) ??
            (await workspaceCall<EditorDocument>(
              target.sessionId,
              'documents',
              'read',
              { path: committed },
            ));
          setEditorDocument(target.workspaceId, doc);
          if (selected() && committed === target.path) setDocument(doc);
        }
        if (result.status !== 'applied' || result.failures?.length) {
          const committed = new Set(result.committedPaths ?? []);
          const remaining =
            result.remaining?.map((edit) => edit.path) ??
            edits
              .map((edit) => edit.path)
              .filter((path) => !committed.has(path));
          throw Error(
            [
              t('saved: {saved}; not saved: {unsaved}', {
                saved: [...committed].join(', ') || t('none'),
                unsaved: remaining.join(', ') || t('none'),
              }),
              ...(result.failures ?? []).map(
                (item) =>
                  `${item.path}: ${item.message ?? t('file changed on disk')}`,
              ),
            ].join('\n'),
          );
        }
      } else {
        const doc = await workspaceCall<EditorDocument>(
          target.sessionId,
          'documents',
          'save',
          {
            path: target.path,
            content: target.content,
            expectedRevision: restore ? null : target.revision,
          },
        );
        if (doc.path !== target.path)
          throw Error(t('the file changed while saving; reopen it'));
        setEditorDocument(target.workspaceId, doc);
        if (selected()) {
          setDocument(doc);
          const external = flight.latest.get(buffer.uri);
          // The save checked the revision it wrote over, so a change seen
          // during it landed after it. Refresh as for any change on disk: a
          // buffer with nothing new takes it, one edited meanwhile keeps the
          // edit and shows the conflict.
          const result =
            external &&
            external.revision !== doc.revision &&
            external.content !== doc.content
              ? refreshEditorDocument(target.workspaceId, external)
              : 'unchanged';
          if (result === 'conflict') {
            setConflict(external!);
            setError(t('file changed on disk; your changes are kept'));
          } else {
            // A change seen during the save was shown as a conflict until
            // now; the buffer took it or never differed from it.
            setError('');
            if (result === 'updated') {
              setDocument(external!);
              setValue(
                retainedModel(
                  target.workspaceId,
                  target.path,
                  external!.content,
                  language,
                ).getValue(),
              );
            }
            setConflict(null);
          }
          setMissing(false);
          setMoved(null);
        }
        if (target.fileId)
          runtime.change((state) => {
            const item = state.files.find(
              (file) =>
                file.id === target.fileId &&
                file.workspaceId === target.workspaceId &&
                file.path === target.path,
            );
            if (item) {
              item.content = doc.content;
              item.draft = undefined;
            }
          });
      }
      completed = true;
      if (selected()) {
        setBufferCount(pendingEditorDocuments(target.workspaceId).length);
        notify(t('file saved'));
      }
    } catch (cause) {
      if (!selected()) return;
      setError(String(cause instanceof Error ? cause.message : cause));
      try {
        const disk = await workspaceCall<EditorDocument>(
          target.sessionId,
          'documents',
          'read',
          { path: target.path },
        );
        if (selected()) {
          // SaveAll may have committed this file before a later file failed.
          const baseline = editorDocuments.get(buffer.uri);
          if (disk.revision !== (baseline?.revision ?? target.revision)) {
            if (disk.content !== baseline?.content) setConflict(disk);
            else {
              setEditorDocument(target.workspaceId, disk);
              setDocument(disk);
            }
          }
        }
      } catch {
        /* Keep the original failure and the target's retained draft. */
      }
    } finally {
      inFlightSaves.current.delete(target.key);
      if (selected()) {
        setSaving(false);
        setSaveQueued(false);
      }
      if (completed && flight.queued)
        await save(flight.queued.all, flight.queued.restore);
    }
  };
  if (
    loading ||
    (document && (document.path !== path || loadedKey !== identity))
  )
    return (
      <section className="file-view">
        <header className="file-view-heading">
          {sourceHeading}
          <span className="mode-toolbar-end">
            <ModeButtons />
            <IconButton label={t('close file')} onClick={onClose}>
              <X size={15} />
            </IconButton>
          </span>
        </header>
        <div className="empty-state" role="status">
          {t('loading file')}
        </div>
      </section>
    );
  if (!document)
    return (
      <div className="empty-state">
        <h3>{t('file not found')}</h3>
        {error && <p role="alert">{error}</p>}
        <Button onClick={onClose}>{t('back to conversation')}</Button>
      </div>
    );
  const dirty = value !== document.content;
  return (
    <section className="file-view">
      <header className="file-view-heading">
        {sourceHeading}
        <span className="mode-toolbar-end">
          <ModeButtons />
          <IconButton label={t('close file')} onClick={onClose}>
            <X size={15} />
          </IconButton>
        </span>
      </header>
      <div className="file-view-toolbar">
        <div className="segmented" role="group" aria-label={t('file view')}>
          {(['edit', 'diff'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={!reading && mode === item ? 'active' : ''}
              aria-pressed={!reading && mode === item}
              onClick={() => {
                setReadingOwner(null);
                setMode(item);
              }}
            >
              {item === 'edit' && markdown
                ? t('source code')
                : MODE_LABEL[item](readOnly)}
            </button>
          ))}
          {markdown && (
            <button
              type="button"
              className={reading ? 'active' : ''}
              aria-pressed={reading}
              onClick={() => setReadingOwner(identity)}
            >
              {t('reading')}
            </button>
          )}
        </div>
        <span
          className={`file-view-state${dirty ? ' dirty' : ''}`}
          role="status"
        >
          {dirty ? t('unsaved changes') : t('all changes saved')}
        </span>
        {bufferCount > 1 && (
          <Button
            disabled={readOnly || saving}
            onClick={() => perform(() => save(true))}
          >
            {t('save all')}
          </Button>
        )}
        <Button
          className={dirty ? 'primary' : ''}
          disabled={readOnly || saving || !!conflict || missing}
          onClick={() => perform(() => save())}
        >
          <Save size={13} aria-hidden />
          {saveQueued
            ? t('save queued')
            : saving
              ? t('saving file')
              : t('save')}
        </Button>
      </div>
      {error && (
        <div className="editor-notice" role="alert">
          <span>{error}</span>
          {missing && (
            <Button
              disabled={readOnly || saving}
              onClick={() => perform(() => save(false, true))}
            >
              {t('restore file with your changes')}
            </Button>
          )}
          {moved && (
            <Button
              onClick={() => {
                setSelection(undefined);
                void navigate(moved.path);
              }}
            >
              {t('open possible moved file: {path}', { path: moved.path })}
            </Button>
          )}
          {conflict && (
            <Button
              onClick={() => {
                setMode('diff');
                setReadingOwner(null);
                setDocument(conflict);
                setEditorDocument(workspaceId, conflict);
                setError(
                  t('file changed on disk; review the diff before saving'),
                );
                setConflict(null);
              }}
            >
              {t('review disk changes')}
            </Button>
          )}
        </div>
      )}
      <div className="file-source-editor" hidden={reading}>
        <NativeCodeEditor
          key={`${workspaceId}:${path}`}
          workspaceId={workspaceId}
          sessionId={session.id}
          path={path}
          value={value}
          original={
            document.content !== value ? document.content : projected?.original
          }
          language={language}
          readOnly={readOnly}
          diff={mode === 'diff'}
          visible={!reading}
          selection={selection}
          // The marks are for the text on disk: while the buffer has edits of its own the
          // editor keeps the ones it has, moved with the text.
          marks={dirty ? undefined : marks}
          onChange={changed}
          // As the save button: a conflict or a missing file is settled first.
          onSave={() => {
            if (!conflict && !missing) perform(() => save());
          }}
        />
      </div>
      {markdown && (
        <div
          key={identity}
          className="file-markdown-reading"
          hidden={!reading}
          role="region"
          aria-label={t('document reading view')}
          tabIndex={0}
        >
          <Markdown text={value} />
        </div>
      )}
      <footer className="file-view-footer">
        <span>
          {language} · {tn(value.split('\n').length, '{n} line', '{n} lines')}
        </span>
      </footer>
    </section>
  );
}
