import { useEffect, useRef, useState } from 'react';
import { FileText, Save, X } from 'lucide-react';
import type { IRange } from 'monaco-editor';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import { Button, IconButton, Status } from '../components/common';
import { t, tn } from '../i18n';
import { workspaceCall } from '../model/workspace-client';
import {
  NativeCodeEditor,
  editorDocuments,
  editorUri,
  pendingEditorDocuments,
  retainedModel,
  setEditorDocument,
} from './NativeCodeEditor';
import type { EditorDocument } from './NativeCodeEditor';
const MODE_LABEL = {
  file: () => t('file'),
  diff: () => t('diff'),
  edit: () => t('edit'),
};
export function FileViewer({
  path: requestedPath,
  line,
  column,
  onClose,
}: {
  path: string;
  line?: number;
  column?: number;
  onClose: () => void;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const session = currentSession(snapshot);
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
  const [value, setValue] = useState(
    projected?.draft ?? projected?.content ?? '',
  );
  const valueRef = useRef(value);
  valueRef.current = value;
  const [selection, setSelection] = useState<IRange>();
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<EditorDocument | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [bufferCount, setBufferCount] = useState(0);
  const live = runtime.mode === 'live';
  const language = /\.[cm]?tsx?$/.test(path)
    ? 'typescript'
    : /\.[cm]?jsx?$/.test(path)
      ? 'javascript'
      : (projected?.language ?? 'plaintext');
  const readOnly =
    session.readOnly && !['plan', 'plan.md'].includes(path.split('/').at(-1)!);
  const showDocument = (doc: EditorDocument) => {
    const uri = editorUri(workspaceId, doc.path).toString();
    const model = retainedModel(
      workspaceId,
      doc.path,
      projected?.draft ?? doc.content,
      language,
    );
    let retained = editorDocuments.get(uri);
    if (
      retained &&
      retained.revision !== doc.revision &&
      model.getValue() === retained.content
    ) {
      model.setValue(doc.content);
      retained = undefined;
    }
    if (!retained) setEditorDocument(workspaceId, doc);
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
    setError('');
    setConflict(null);
    setDocument(null);
    setLoading(true);
    if (live) {
      void workspaceCall<EditorDocument>(session.id, 'documents', 'read', {
        path,
      })
        .then((doc) => {
          if (active) showDocument(doc);
        })
        .catch((cause) => {
          if (active)
            setError(String(cause instanceof Error ? cause.message : cause));
        })
        .finally(() => {
          if (active) setLoading(false);
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
  const changed = (text: string) => {
    valueRef.current = text;
    setValue(text);
    setBufferCount(pendingEditorDocuments(workspaceId).length);
  };
  const navigate = async (target: string, range?: IRange) => {
    setSelection(range);
    setMode('edit');
    setPath(target);
  };
  const save = async (all = false) => {
    if (!document || saving || readOnly) return;
    setSaving(true);
    setError('');
    try {
      if (!live) {
        notify(t('buffer saved locally'));
        return;
      }
      if (all) {
        const edits = pendingEditorDocuments(workspaceId).map((item) => ({
          path: item.path,
          content: item.content,
          expectedRevision: item.revision,
        }));
        const result = await workspaceCall<{
          status: string;
          committedPaths?: string[];
          failures?: { path: string; message?: string }[];
        }>(session.id, 'documents', 'applyEdits', { edits });
        for (const target of result.committedPaths ?? []) {
          const doc = await workspaceCall<EditorDocument>(
            session.id,
            'documents',
            'read',
            { path: target },
          );
          setEditorDocument(workspaceId, doc);
          if (target === path) setDocument(doc);
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
          session.id,
          'documents',
          'save',
          {
            path,
            content: valueRef.current,
            expectedRevision: document.revision,
          },
        );
        setEditorDocument(workspaceId, doc);
        setDocument(doc);
        setConflict(null);
        if (projected)
          runtime.change((state) => {
            const item = state.files.find((file) => file.id === projected.id);
            if (item) {
              item.content = doc.content;
              item.draft = undefined;
            }
          });
      }
      setBufferCount(pendingEditorDocuments(workspaceId).length);
      notify(t('file saved'));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      try {
        const disk = await workspaceCall<EditorDocument>(
          session.id,
          'documents',
          'read',
          { path },
        );
        if (disk.revision !== document.revision) setConflict(disk);
      } catch {
        /* The original failure remains visible. */
      }
    } finally {
      setSaving(false);
    }
  };
  if (loading)
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
          <Button onClick={() => notify(t('buffer saved locally'))}>
            <Save size={13} />
            {t('save buffer')}
          </Button>
        )}
      </div>
      {error && (
        <div className="editor-notice" role="alert">
          <span>{error}</span>
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
          disabled={readOnly || saving || !!conflict}
          onClick={() => perform(() => save())}
        >
          {saving
            ? t('saving file')
            : live
              ? t('save to disk')
              : t('save buffer')}
        </Button>
      </footer>
    </section>
  );
}
