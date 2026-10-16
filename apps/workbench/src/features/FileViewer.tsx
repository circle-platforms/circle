import { useEffect, useRef, useState } from 'react';
import { FileText, Save, X } from 'lucide-react';
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
  persistBuffer,
  retainedModel,
  refreshEditorDocument,
  setEditorDocument,
} from './NativeCodeEditor';
import type { EditorDocument } from './NativeCodeEditor';
import type { SourceResourceOwner } from '../model/source-resource-owner';
type SaveFlight = {
  queued?: { all: boolean; restore: boolean };
  writes: Map<string, string>;
  latest: Map<string, EditorDocument>;
};
const MODE_LABEL = {
  file: () => t('file'),
  diff: () => t('diff'),
  edit: () => t('edit'),
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
  const [mode, setMode] = useState<'file' | 'diff' | 'edit'>(
    projected?.status ? 'diff' : 'file',
  );
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const identity = JSON.stringify([workspaceId, session.id, path]);
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
  const [projectErrors, setProjectErrors] = useState<
    {
      path?: string;
      message: string;
      source?: string;
      startLineNumber: number;
      startColumn: number;
    }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [moved, setMoved] = useState<EditorDocument | null>(null);
  const [bufferCount, setBufferCount] = useState(0);
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
  const readOnly = resourceOwner
    ? resourceOwner.readOnly
    : session.readOnly &&
      !['plan', 'plan.md'].includes(path.split('/').at(-1)!);
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
        setError(t('file changed on disk; buffer kept'));
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
    if (row)
      setSelection({
        startLineNumber: row,
        startColumn: column ?? Number(anchor?.[2] ?? 1),
        endLineNumber: row,
        endColumn: column ?? Number(anchor?.[2] ?? 1),
      });
    else setSelection(undefined);
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
            deleted && prior ? t('file removed on disk; buffer kept') : message,
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
      setError(t('buffer could not be saved locally; keep this window open'));
    window.addEventListener('circle-editor-change', update);
    window.addEventListener('circle-editor-persistence-error', failure);
    update();
    return () => {
      window.removeEventListener('circle-editor-change', update);
      window.removeEventListener('circle-editor-persistence-error', failure);
    };
  }, [workspaceId]);
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
            setError(t('file removed on disk; buffer kept'));
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
          void workspaceCall<EditorDocument>(session.id, 'documents', 'read', {
            path: target,
          })
            .then((document) => {
              if (!alive || reads.get(target) !== readVersion) return;
              const pending = [...inFlightSaves.current.values()].find(
                (flight) => flight.writes.has(uri),
              );
              if (pending) {
                pending.latest.set(uri, document);
                if (
                  target === path &&
                  document.content !== pending.writes.get(uri)
                ) {
                  setConflict(document);
                  setError(t('file changed on disk; buffer kept'));
                }
                return;
              }
              const result = refreshEditorDocument(workspaceId, document);
              if (target !== path) return;
              setMissing(false);
              setMoved(null);
              if (result === 'conflict') {
                setConflict(document);
                setError(t('file changed on disk; buffer kept'));
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
            })
            .catch((cause) => {
              if (alive && target === path)
                setError(
                  String(cause instanceof Error ? cause.message : cause),
                );
            });
        }
      });
      return () => {
        alive = false;
        unsubscribe();
      };
    })();
  }, [workspaceId, session.id, path, live, language]);
  useEffect(() => {
    setProjectErrors([]);
    const update = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.workspaceId === workspaceId)
        setProjectErrors(detail.diagnostics);
    };
    window.addEventListener('circle-language-project', update);
    return () => window.removeEventListener('circle-language-project', update);
  }, [workspaceId]);
  const changed = (text: string) => {
    setValue(text);
    setBufferCount(pendingEditorDocuments(workspaceId).length);
  };
  const navigate = async (target: string, range?: IRange) => {
    setSelection(range);
    setMode('edit');
    setPath(target);
    await onSourceNavigate?.(
      target,
      range?.startLineNumber,
      range?.startColumn,
    );
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
        if (selected()) notify(t('buffer saved locally'));
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
          committedPaths?: string[];
          failures?: { path: string; message?: string }[];
        }>(target.sessionId, 'documents', 'applyEdits', { edits });
        for (const committed of result.committedPaths ?? []) {
          const doc = await workspaceCall<EditorDocument>(
            target.sessionId,
            'documents',
            'read',
            { path: committed },
          );
          setEditorDocument(target.workspaceId, doc);
          if (selected() && committed === target.path) setDocument(doc);
        }
        if (result.failures?.length)
          throw Error(
            result.failures
              .map(
                (item) =>
                  `${item.path}: ${item.message ?? t('file changed on disk')}`,
              )
              .join('\n'),
          );
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
          throw Error('saved document identity changed');
        setEditorDocument(target.workspaceId, doc);
        if (selected()) {
          setDocument(doc);
          const external = flight.latest.get(buffer.uri);
          if (
            external &&
            external.revision !== doc.revision &&
            external.content !== doc.content
          ) {
            setConflict(external);
            setError(t('file changed on disk; buffer kept'));
          } else setConflict(null);
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
        if (selected() && disk.revision !== target.revision) setConflict(disk);
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
          <strong>{path}</strong>
          <IconButton label={t('close file')} onClick={onClose}>
            <X size={15} />
          </IconButton>
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
  return (
    <section className="file-view">
      <header className="file-view-heading">
        <div>
          <FileText size={16} />
          <strong>{path}</strong>
          {projected?.status && <Status value={projected.status} />}
        </div>
        <IconButton label={t('close file')} onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>
      <div className="file-view-toolbar">
        <div className="segmented">
          {(['file', 'diff', 'edit'] as const).map((item) => (
            <button
              key={item}
              className={mode === item ? 'active' : ''}
              onClick={() => setMode(item)}
            >
              {MODE_LABEL[item]()}
            </button>
          ))}
        </div>
        <span>
          {value === document.content
            ? t('disk and buffer match')
            : t('unsaved buffer')}
        </span>
        {mode === 'edit' && (
          <Button
            onClick={() => {
              if (persistBuffer(workspaceId, path))
                notify(t('buffer saved locally'));
            }}
          >
            <Save size={13} />
            {t('save buffer')}
          </Button>
        )}
      </div>
      {!!projectErrors.length && (
        <details
          className="editor-notice editor-project-diagnostics"
          role="alert"
        >
          <summary>
            {projectErrors.every(
              (problem) => problem.source === 'configuration',
            )
              ? t('project configuration needs attention')
              : t('language service needs attention')}{' '}
            ({projectErrors.length})
          </summary>
          {projectErrors.map((problem, index) => (
            <span key={index}>
              {problem.path && (
                <Button
                  onClick={() => {
                    setSelection({
                      startLineNumber: problem.startLineNumber,
                      startColumn: problem.startColumn,
                      endLineNumber: problem.startLineNumber,
                      endColumn: problem.startColumn,
                    });
                    void navigate(problem.path!, {
                      startLineNumber: problem.startLineNumber,
                      startColumn: problem.startColumn,
                      endLineNumber: problem.startLineNumber,
                      endColumn: problem.startColumn,
                    });
                  }}
                >
                  {problem.path}
                </Button>
              )}{' '}
              {problem.message}
            </span>
          ))}
        </details>
      )}
      {error && (
        <div className="editor-notice" role="alert">
          <span>{error}</span>
          {missing && (
            <Button
              disabled={readOnly || saving}
              onClick={() => perform(() => save(false, true))}
            >
              {t('restore file from buffer')}
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
                setDocument(conflict);
                setEditorDocument(workspaceId, conflict);
                setError(t('disk changed; review the diff before saving'));
                setConflict(null);
              }}
            >
              {t('review disk changes')}
            </Button>
          )}
        </div>
      )}
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
        readOnly={mode === 'file' || readOnly}
        diff={mode === 'diff'}
        live={live}
        selection={selection}
        onChange={changed}
        onSave={() => perform(() => save())}
        onNavigate={navigate}
      />
      <footer className="file-view-footer">
        <span>
          {language} · {tn(value.split('\n').length, '{n} line', '{n} lines')}
        </span>
        {bufferCount > 1 && (
          <Button
            disabled={readOnly || saving}
            onClick={() => perform(() => save(true))}
          >
            {t('save all buffers')}
          </Button>
        )}
        <Button
          disabled={readOnly || saving || !!conflict || missing}
          onClick={() => perform(() => save())}
        >
          {saveQueued
            ? t('save queued')
            : saving
              ? t('saving file')
              : live
                ? t('save to disk')
                : t('save buffer')}
        </Button>
      </footer>
    </section>
  );
}
