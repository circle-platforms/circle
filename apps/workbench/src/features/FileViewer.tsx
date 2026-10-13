import { useEffect, useState } from 'react';
import { FileText, FileDiff, Save, Download, ArrowLeft, X } from 'lucide-react';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import { Button, IconButton, Status } from '../components/common';
import { t, tn } from '../i18n';
// The viewer's three ways to show a file.
const MODE_LABEL = {
  file: () => t('file'),
  diff: () => t('diff'),
  edit: () => t('edit'),
};
export function FileViewer({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const session = currentSession(snapshot);
  const file = snapshot.files.find(
    (item) => item.path === path && item.workspaceId === session.workspaceId,
  );
  const [mode, setMode] = useState<'file' | 'diff' | 'edit'>(
    file?.status ? 'diff' : 'file',
  );
  const [value, setValue] = useState(file?.draft ?? file?.content ?? '');
  useEffect(() => {
    setValue(file?.draft ?? file?.content ?? '');
    setMode(file?.status ? 'diff' : 'file');
  }, [file?.id]);
  if (!file)
    return (
      <div className="empty-state">
        <h3>{t('file not found')}</h3>
        <Button onClick={onClose}>{t('back to conversation')}</Button>
      </div>
    );
  const before = (file.original ?? '').split('\n');
  const after = file.content.split('\n');
  return (
    <section className="file-view">
      <header className="file-view-heading">
        <div>
          <FileText size={16} />
          <strong>{file.path}</strong>
          {file.status && <Status value={file.status} />}
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
          {file.nativeGrant
            ? t('local file · disk unchanged')
            : 'sample workspace · disk unchanged'}
        </span>
        {mode === 'edit' && (
          <Button
            onClick={() =>
              perform(() => {
                runtime.change((state) => {
                  state.files.find((item) => item.id === file.id)!.draft =
                    value;
                });
                notify(t('buffer saved locally'));
              })
            }
          >
            <Save size={13} />
            {t('save buffer')}
          </Button>
        )}
      </div>
      {mode === 'edit' ? (
        <textarea
          className="code-editor"
          aria-label={t('file buffer')}
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : mode === 'diff' ? (
        <div className="diff-view">
          <div className="diff-column">
            <header>{t('original')}</header>
            {before.map((line, index) => (
              <div
                className={line !== after[index] ? 'removed' : ''}
                key={index}
              >
                <span>{index + 1}</span>
                <code>{line || ' '}</code>
              </div>
            ))}
          </div>
          <div className="diff-column">
            <header>{t('proposed')}</header>
            {after.map((line, index) => (
              <div
                className={line !== before[index] ? 'added' : ''}
                key={index}
              >
                <span>{index + 1}</span>
                <code>{line || ' '}</code>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="code-view">
          {file.content.split('\n').map((line, index) => (
            <div key={index}>
              <span>{index + 1}</span>
              <code>{line || ' '}</code>
            </div>
          ))}
        </div>
      )}
      <footer className="file-view-footer">
        <span>
          {file.language} ·{' '}
          {tn(file.content.split('\n').length, '{n} line', '{n} lines')}
          {file.truncated ? ' · ' + t('preview truncated') : ''}
        </span>
        <Button
          disabled={
            session.readOnly &&
            !['plan', 'plan.md'].includes(file.path.split('/').at(-1)!)
          }
          onClick={() =>
            perform(async () => {
              await runtime.request('write-file', {
                path: file.path,
                content: value,
              });
              if (runtime.mode === 'live') {
                runtime.change((state) => {
                  const item = state.files.find((item) => item.id === file.id)!;
                  item.content = value;
                  item.draft = undefined;
                });
                notify(t('file saved'));
              } else notify('write request recorded; disk is unchanged');
            })
          }
        >
          {runtime.mode === 'live' ? t('save to disk') : 'request file save'}
        </Button>
      </footer>
    </section>
  );
}
