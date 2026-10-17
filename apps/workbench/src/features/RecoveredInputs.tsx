import { useEffect, useRef, useState } from 'react';
import type { WorkspaceService } from '../../../desktop/src/workspace-protocol';
import { workspaceCall } from '../model/workspace-client';
import { recoveredDraft, type RecoveredInput } from '../model/recovered-input';
import { useRuntime } from '../app/context';
import { Button } from '../components/common';
import { t, tn, dateLocale } from '../i18n';
import './task-panel.css';
import './recovered-inputs.css';
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
  const [discarding, setDiscarding] = useState<string | null>(null);
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
    setDiscarding(null);
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
        if (!payload) throw Error(t('this message can no longer be restored'));
        const current = runtime
          .getSnapshot()
          .sessions.find((item) => item.id === sessionId);
        if (!current || current.lifecycle === 'deleting')
          throw Error(t('this conversation is closed; the message is kept'));
        const patch = recoveredDraft(
          payload,
          current.draft,
          current.attachments,
        );
        const persisted = runtime.updateSessionView(sessionId, patch);
        setCopied((current) => [...current, input.id]);
        if (!persisted) {
          setMemoryOnly((current) => [...current, input.id]);
          setError(t('added to the message box, but it could not be saved'));
        } else
          setNotice(
            t(
              'added to the message box. this copy stays until you discard it.',
            ),
          );
      } else {
        setDiscarding(null);
        setNotice(action === 'resume' ? t('sent') : t('discarded'));
      }
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
      setNotice(t('message box saved'));
    } else setError(t('added to the message box, but it could not be saved'));
  }
  if (recovery?.items.length === 0 && !error && !notice) return null;
  return (
    <section
      className="recovered-inputs task-recovery"
      aria-label={t('unsent messages')}
    >
      <header className="task-section-heading">
        <strong>{t('unsent messages')}</strong>
      </header>
      <p className="panel-note">
        {t(
          'these were waiting when Circle closed. nothing is sent until you choose.',
        )}
      </p>
      {error && (
        <div role="alert">
          <p>
            {error.includes(
              t('added to the message box, but it could not be saved'),
            )
              ? error
              : t('could not restore unsent messages')}
          </p>
          <details className="task-technical">
            <summary>{t('details')}</summary>
            <pre>{error}</pre>
          </details>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {memoryOnly.length > 0 && (
        <Button onClick={retrySaving}>{t('try saving again')}</Button>
      )}
      {recovery?.items.map((input) => {
        // The message itself, not the folded form with paste placeholders.
        const shown = (input.payload.text || input.payload.display).trim();
        const attachments = input.payload.attachments?.length ?? 0;
        return (
          <article key={input.id}>
            <div className="task-recovery-title">
              <strong className="recovered-input-text" title={shown}>
                {shown.split('\n')[0]}
              </strong>
              <small>
                {new Date(input.createdAt).toLocaleString(dateLocale())}
                {attachments > 0 &&
                  ' · ' + tn(attachments, '{n} attachment', '{n} attachments')}
              </small>
            </div>
            <details className="task-technical">
              <summary>{t('show full message')}</summary>
              <pre>{input.payload.text}</pre>
              {Object.entries(input.payload.pastes ?? {}).map(([id, text]) => (
                <details key={id}>
                  <summary>{t('pasted text')}</summary>
                  <pre>{text}</pre>
                </details>
              ))}
              {input.payload.attachments?.map((media, index) => (
                <p key={index}>{media.filename}</p>
              ))}
            </details>
            {discarding === input.id ? (
              <div className="tasks-actions recovered-input-confirm">
                <span>{t('discard this message?')}</span>
                <Button
                  className="danger"
                  disabled={busy}
                  onClick={() => void resolve(input, 'discard')}
                >
                  {t('discard')}
                </Button>
                <Button disabled={busy} onClick={() => setDiscarding(null)}>
                  {t('keep')}
                </Button>
              </div>
            ) : (
              <div className="tasks-actions">
                <Button
                  className="primary"
                  disabled={busy}
                  onClick={() => void resolve(input, 'resume')}
                >
                  {t('send now')}
                </Button>
                <Button
                  disabled={busy || copied.includes(input.id)}
                  onClick={() => void resolve(input, 'returnToDraft')}
                >
                  {copied.includes(input.id)
                    ? t('added to the message box')
                    : t('edit in message box')}
                </Button>
                <Button disabled={busy} onClick={() => setDiscarding(input.id)}>
                  {t('discard')}
                </Button>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
