import { useEffect, useRef, useState } from 'react';
import type { TaskArtifact } from '../../../desktop/src/workspace/task-store';
import { workspaceCall } from '../model/workspace-client';
import { Button, DataBlock } from '../components/common';
import { copyText } from '../host';
import { t } from '../i18n';
interface ArtifactPage {
  id: string;
  kind: string;
  content: string;
  sha256: string;
  truncated: boolean;
  offset: number;
  nextOffset?: number;
  totalCharacters: number;
  byteLength: number;
}
function artifactLabel(kind: string): string {
  switch (kind) {
    case 'task-patch':
      return t('changes');
    case 'acceptance':
      return t('acceptance report');
    case 'transcript':
      return t('conversation');
    case 'runtime-events':
      return t('activity log');
    case 'verification':
      return t('verification');
    default:
      return kind;
  }
}
export function TaskArtifacts({
  sessionId,
  taskId,
  attempt,
}: {
  sessionId: string;
  taskId: string;
  attempt: number;
}) {
  const request = useRef(0);
  const listRequest = useRef(0);
  useEffect(() => {
    request.current++;
    listRequest.current++;
    setOpen(false);
    setArtifacts([]);
    setValue(null);
    setError('');
    setBusy(false);
    return () => {
      request.current++;
      listRequest.current++;
    };
  }, [sessionId, taskId, attempt]);
  const [open, setOpen] = useState(false);
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([]);
  const [value, setValue] = useState<ArtifactPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async (id: string, offset = 0) => {
    const operation = ++request.current;
    setBusy(true);
    setError('');
    try {
      const page = await workspaceCall<ArtifactPage>(
        sessionId,
        'tasks',
        'readArtifact',
        { id: taskId, artifactId: id, offset },
      );
      if (operation !== request.current) return;
      setValue((previous) =>
        offset && previous?.id === page.id
          ? { ...page, content: previous.content + page.content }
          : page,
      );
    } catch (reason) {
      if (operation === request.current) setError(String(reason));
    } finally {
      if (operation === request.current) setBusy(false);
    }
  };
  return (
    <section className="task-artifacts">
      <Button
        aria-expanded={open}
        onClick={() => {
          const operation = ++listRequest.current;
          const next = !open;
          setOpen(next);
          if (next) {
            setError('');
            void workspaceCall<TaskArtifact[]>(
              sessionId,
              'tasks',
              'artifacts',
              { id: taskId },
            )
              .then((records) => {
                if (operation === listRequest.current)
                  setArtifacts(
                    records.filter((record) => record.attempt === attempt),
                  );
              })
              .catch((reason) => {
                if (operation === listRequest.current) setError(String(reason));
              });
          }
        }}
      >
        {open ? t('hide results') : t('view results')}
      </Button>
      {open && (
        <div>
          <div className="tasks-actions">
            {artifacts.map((artifact) => (
              <Button
                key={artifact.id}
                disabled={busy}
                aria-pressed={value?.id === artifact.id}
                onClick={() => void load(artifact.id)}
              >
                {artifactLabel(artifact.kind)}
              </Button>
            ))}
          </div>
          {value && (
            <>
              <DataBlock
                title={artifactLabel(value.kind)}
                value={value.content}
              />
              <p className="task-artifact-identity">
                <code>{value.sha256}</code>
              </p>
              {value.truncated && (
                <p role="status">
                  {t('only part is shown; load the rest before you review')}
                </p>
              )}
              <div className="tasks-actions">
                {value.truncated && value.nextOffset !== undefined && (
                  <Button
                    disabled={busy}
                    onClick={() => void load(value.id, value.nextOffset)}
                  >
                    {t('load the rest')}
                  </Button>
                )}
                <Button
                  disabled={busy}
                  onClick={() =>
                    void copyText(value.content).catch((reason) =>
                      setError(String(reason)),
                    )
                  }
                >
                  {value.truncated ? t('copy shown part') : t('copy')}
                </Button>
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="tasks-error">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
