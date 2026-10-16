import { useEffect, useRef, useState } from 'react';
import type { WorkspaceService } from '../../../desktop/src/workspace-protocol';
import { workspaceCall } from '../model/workspace-client';
import { recoveredDraft, type RecoveredInput } from '../model/recovered-input';
import { useRuntime } from '../app/context';
import { Button } from '../components/common';
import { t } from '../i18n';
import './task-panel.css';
interface Recovery {
  version: number;
  items: RecoveredInput[];
}
interface Resolution extends Recovery {
  applied: boolean;
  action: string;
}
export function RecoveredInputs({ sessionId }: { sessionId: string }) {
  const { runtime } = useRuntime();
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string[]>([]);
  const [memoryOnly, setMemoryOnly] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const generation = useRef(0);
  async function refresh(epoch = generation.current) {
    try {
      const next = await workspaceCall<Recovery>(
        sessionId,
        'inputs' as WorkspaceService,
        'list',
      );
      if (epoch === generation.current) {
        setRecovery(next);
        setError('');
      }
    } catch (err) {
      if (epoch === generation.current) setError(String(err));
    }
  }
  useEffect(() => {
    const epoch = ++generation.current;
    setRecovery(null);
    setCopied([]);
    setMemoryOnly([]);
    setConfirmed([]);
    setError('');
    setNotice('');
    setBusy(false);
    void refresh(epoch);
    return () => {
      generation.current++;
    };
  }, [sessionId]);
  async function resolve(
    input: RecoveredInput,
    action: 'resume' | 'returnToDraft' | 'discard',
  ) {
    if (!recovery || busy) return;
    const epoch = generation.current;
    const expectedVersion = recovery.version;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await workspaceCall<Resolution>(
        sessionId,
        'inputs' as WorkspaceService,
        'resolve',
        {
          ids: [input.id],
          expectedVersion,
          operationId: crypto.randomUUID(),
          action,
        },
      );
      if (epoch !== generation.current) return;
      await refresh(epoch);
      if (action === 'returnToDraft') {
        const payload = result.items.find((item) => item.id === input.id);
        if (!payload)
          throw Error(
            t('recovered input payload is unavailable; recovery copy retained'),
          );
        const current = runtime
          .getSnapshot()
          .sessions.find((item) => item.id === sessionId);
        if (!current || current.lifecycle === 'deleting')
          throw Error(t('conversation unavailable; recovery copy retained'));
        const patch = recoveredDraft(
          payload,
          current.draft,
          current.attachments,
        );
        const persisted = runtime.updateSessionView(sessionId, patch);
        setCopied((current) => [...current, input.id]);
        if (!persisted) {
          setMemoryOnly((current) => [...current, input.id]);
          setError(
            t(
              'draft is available only in memory; saving failed and the recovery copy is retained',
            ),
          );
        } else
          setNotice(
            t(
              'copied to draft without sending; recovery copy retained until you explicitly remove it',
            ),
          );
      } else
        setNotice(
          action === 'resume'
            ? t('input explicitly resumed')
            : t('recovery copy explicitly removed'),
        );
    } catch (err) {
      if (epoch === generation.current) {
        // A failed version check must not silently retry or target a newer input.
        await refresh(epoch);
        setError(String(err));
      }
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  function retrySaving() {
    const current = runtime
      .getSnapshot()
      .sessions.find((item) => item.id === sessionId);
    if (!current || current.lifecycle === 'deleting') return;
    if (
      runtime.updateSessionView(sessionId, {
        draft: current.draft,
        attachments: current.attachments,
      })
    ) {
      setMemoryOnly([]);
      setError('');
      setNotice(
        t('draft saved; recovery copy retained until you explicitly remove it'),
      );
    } else
      setError(
        t(
          'draft is available only in memory; saving failed and the recovery copy is retained',
        ),
      );
  }
  if (recovery?.items.length === 0 && !error && !notice) return null;
  return (
    <section
      className="recovered-inputs task-recovery"
      aria-label={t('recovered queued inputs')}
    >
      <header className="task-section-heading">
        <strong>{t('recovered queued inputs')}</strong>
        <Button disabled={busy} onClick={() => void refresh()}>
          {t('refresh')}
        </Button>
      </header>
      <p className="panel-note">
        {t(
          'nothing is sent automatically after restart; choose whether to resume, copy to draft or remove each input',
        )}
      </p>
      {error && (
        <p role="alert">
          {t('input recovery unavailable')}: {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {memoryOnly.length > 0 && (
        <Button onClick={retrySaving}>
          {t('retry saving recovered draft')}
        </Button>
      )}
      {recovery?.items.map((input) => (
        <article key={input.id}>
          <div className="task-recovery-title">
            <strong>
              {input.kind === 'steer'
                ? t('steering input')
                : t('follow-up input')}
            </strong>
            <small>
              {new Date(input.createdAt).toLocaleString()} ·{' '}
              {t('{n} media attachments', {
                n: input.payload.attachments?.length ?? 0,
              })}
            </small>
          </div>
          <details className="task-technical">
            <summary>{t('inspect full recovered input')}</summary>
            <pre>{input.payload.text}</pre>
            <p>{t('original display')}</p>
            <pre>{input.payload.display}</pre>
            {Object.entries(input.payload.pastes ?? {}).map(([id, text]) => (
              <details key={id}>
                <summary>
                  {t('pasted text')} {id}
                </summary>
                <pre>{text}</pre>
              </details>
            ))}
            {input.payload.attachments?.map((media, index) => (
              <p key={index}>
                {media.filename} · {media.mime_type}
              </p>
            ))}
          </details>
          <div className="tasks-actions">
            <Button
              disabled={busy}
              onClick={() => void resolve(input, 'resume')}
            >
              {t('resume this input')}
            </Button>
            <Button
              disabled={busy || copied.includes(input.id)}
              onClick={() => void resolve(input, 'returnToDraft')}
            >
              {memoryOnly.includes(input.id)
                ? t('copied in memory; not saved')
                : copied.includes(input.id)
                  ? t('copied to draft')
                  : t('return input to draft')}
            </Button>
          </div>
          <label className="task-check">
            <input
              type="checkbox"
              checked={confirmed.includes(input.id)}
              onChange={(event) =>
                setConfirmed((current) =>
                  event.target.checked
                    ? [...current, input.id]
                    : current.filter((id) => id !== input.id),
                )
              }
            />
            {t('I have checked the input and want to remove its recovery copy')}
          </label>
          <Button
            disabled={busy || !confirmed.includes(input.id)}
            onClick={() => void resolve(input, 'discard')}
          >
            {t('discard recovered input')}
          </Button>
        </article>
      ))}
    </section>
  );
}
