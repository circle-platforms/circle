import { useState } from 'react';
import { KeyRound, MessageCircleQuestion, ShieldAlert } from 'lucide-react';
import { useRuntime } from '../app/context';
import { Button } from '../components/common';
import { DataBlock } from '../components/ui';
import { DiffBlock } from '../components/DiffBlock';
import type { Interaction } from '../model/types';
import { t } from '../i18n';
import { relativePath } from '../model/format';

// Why the core asks, as approvals.ts words it; a reason not listed is shown as it is.
const REASONS: Record<string, () => string> = {
  'changes files in the workspace': () => t('changes files in the workspace'),
  'changes files outside the workspace': () =>
    t('changes files outside the workspace'),
  'deletes files': () => t('deletes files'),
  'runs a shell command': () => t('runs a shell command'),
  'only reads': () => t('only reads'),
  'destructive operation': () => t('destructive operation'),
  'python code deletes files': () => t('python code deletes files'),
  'encoded command': () => t('encoded command'),
  'nested too deep to read': () => t('nested too deep to read'),
  'command could not be parsed': () => t('command could not be parsed'),
  'shows the model the whole screen': () =>
    t('shows the model the whole screen'),
};
export const requestReason = (reason?: string) =>
  reason ? (REASONS[reason]?.() ?? reason) : '';

/**
 * A request from Circle where it happens in the conversation: an approval under the tool
 * call that waits for it, a question or a secret after the last message. The answer goes
 * to the core gate as the dialog's did.
 */
export function InlineRequest({
  item,
  onSecret,
}: {
  item: Interaction;
  onSecret: () => void;
}) {
  const { runtime, perform, snapshot } = useRuntime();
  const workspaceId = snapshot.sessions.find(
    (row) => row.id === item.sessionId,
  )?.workspaceId;
  const root = snapshot.workspaces.find(
    (workspace) => workspace.id === workspaceId,
  )?.path;
  const target = item.target ? relativePath(item.target, root) : '';
  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [explaining, setExplaining] = useState(false);
  const [sent, setSent] = useState(false);
  const finish = (answer: string) => {
    if (sent) return;
    setSent(true);
    perform(async () => {
      try {
        await runtime.answer(item.id, item.revision, answer);
      } catch (error) {
        setSent(false);
        throw error;
      }
    });
  };
  if (item.kind === 'secret')
    return (
      <section className="inline-request" data-kind="secret">
        <header>
          <KeyRound size={14} />
          <strong>{item.title}</strong>
        </header>
        <div className="request-actions">
          <Button className="primary" onClick={onSecret}>
            {t('enter secret')}
          </Button>
        </div>
      </section>
    );
  if (item.kind === 'question' || item.kind === 'plan-exit')
    return (
      <section className="inline-request" data-kind="question">
        <header>
          <MessageCircleQuestion size={14} />
          <strong>{item.title}</strong>
          {item.origin?.name && <small>{item.origin.name}</small>}
        </header>
        {item.choices?.length ? (
          <div className="request-choices" role="group">
            {item.choices.map((choice) => (
              <label key={choice}>
                <input
                  type={item.multiple ? 'checkbox' : 'radio'}
                  name={item.id}
                  checked={selected.includes(choice)}
                  onChange={(event) =>
                    setSelected(
                      item.multiple
                        ? event.target.checked
                          ? [...selected, choice]
                          : selected.filter((value) => value !== choice)
                        : [choice],
                    )
                  }
                />
                <span>{choice}</span>
              </label>
            ))}
          </div>
        ) : null}
        <textarea
          className="input short"
          aria-label={t('your answer')}
          placeholder={
            item.choices?.length
              ? t('or write your own answer')
              : t('your answer')
          }
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
        <div className="request-actions">
          <Button
            className="primary"
            disabled={sent || (!selected.length && !comment.trim())}
            onClick={() =>
              finish(JSON.stringify({ choices: selected, comment }))
            }
          >
            {t('send answer')}
          </Button>
          <Button disabled={sent} onClick={() => finish('cancelled')}>
            {t('skip')}
          </Button>
        </div>
      </section>
    );
  const allowed = (choice: string) =>
    runtime.mode !== 'live' || !!item.choices?.includes(choice);
  return (
    <section className="inline-request" data-kind="approval">
      <header>
        <ShieldAlert size={14} />
        <strong>{item.tool ?? item.title}</strong>
        <span>{requestReason(item.reason)}</span>
        {item.origin?.name && <small>{item.origin.name}</small>}
      </header>
      {item.command ? (
        <pre className="approval-command">{item.command}</pre>
      ) : item.diff ? (
        <DiffBlock diff={item.diff} path={target || undefined} />
      ) : (
        <>
          {target && <p className="file-path">{target}</p>}
          {item.input && (
            <DataBlock title={t('tool input')} value={item.input} />
          )}
        </>
      )}
      <div className="request-actions">
        <Button
          className="primary"
          disabled={sent || !allowed('approve')}
          onClick={() => finish('allow once')}
        >
          {t('allow once')}
        </Button>
        {allowed('always') && (
          <Button
            disabled={sent}
            onClick={() => finish('allow for this session')}
          >
            {t('allow for this session')}
          </Button>
        )}
        {runtime.mode === 'live' && item.choices?.includes('prefix') && (
          <Button disabled={sent} onClick={() => finish('prefix')}>
            {item.prefix
              ? t('allow “{prefix}” commands', { prefix: item.prefix })
              : t('allow command prefix')}
          </Button>
        )}
        <Button disabled={sent} onClick={() => finish('reject')}>
          {t('reject')}
        </Button>
        {!explaining && (
          <button
            className="text-button"
            disabled={sent}
            onClick={() => setExplaining(true)}
          >
            {t('reject and explain')}
          </button>
        )}
      </div>
      {explaining && (
        <form
          className="request-explain"
          onSubmit={(event) => {
            event.preventDefault();
            finish(comment.trim() ? 'reject: ' + comment : 'reject');
          }}
        >
          <input
            autoFocus
            className="input"
            aria-label={t('what should circle do instead?')}
            placeholder={t('what should circle do instead?')}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <Button type="submit" disabled={sent}>
            {t('send rejection')}
          </Button>
        </form>
      )}
      {(item.command || item.diff) && item.input && (
        <details className="request-input">
          <summary>{t('tool input')}</summary>
          <DataBlock title={t('tool input')} value={item.input} />
        </details>
      )}
    </section>
  );
}
