import { useRef, useState } from 'react';
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
              .then((records) =>
                setArtifacts(
                  records.filter((record) => record.attempt === attempt),
                ),
              )
              .catch((reason) => setError(String(reason)));
          }
        }}
      >
        {t('inspect task artifacts')}
      </Button>
      {open && (
        <div>
          <div className="tasks-actions">
            {artifacts.map((artifact) => (
              <Button
                key={artifact.id}
                disabled={busy}
                onClick={() => void load(artifact.id)}
              >
                {artifact.kind} · {artifact.sha256.slice(0, 12)}
              </Button>
            ))}
          </div>
          {value && (
            <>
              <p>
                <code>{value.sha256}</code> ·{' '}
                {t('{n} bytes', { n: value.byteLength })}
              </p>
              <DataBlock title={value.kind} value={value.content} />
              {value.truncated && (
                <p role="status">
                  {t(
                    'partial artifact · read the remaining content before reviewing',
                  )}
                </p>
              )}
              <div className="tasks-actions">
                {value.truncated && value.nextOffset !== undefined && (
                  <Button
                    disabled={busy}
                    onClick={() => void load(value.id, value.nextOffset)}
                  >
                    {t('read remaining artifact')}
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
                  {value.truncated
                    ? t('copy shown content')
                    : t('copy complete artifact')}
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
