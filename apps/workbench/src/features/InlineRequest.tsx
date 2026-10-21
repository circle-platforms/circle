import { useId, useRef, useState } from 'react';
import {
  ClipboardList,
  KeyRound,
  MessageCircleQuestion,
  ShieldAlert,
} from 'lucide-react';
import { useRuntime } from '../app/context';
import { Button } from '../components/common';
import { DataBlock } from '../components/ui';
import { DiffBlock } from '../components/DiffBlock';
import type { Interaction } from '../model/types';
import { t } from '../i18n';
import { relativePath } from '../model/format';
import { browserApprovalInput, hasToolInput } from '../model/browser';
import { approvalHeading, requestReason } from '../model/reasons.ts';
import {
  executeTerminalRedirect,
  redirectRefusal,
} from '../model/terminal-redirect';
import { useTerminalState } from './useTerminalState';
import { PlanChoices, planAnswerReady, planReply } from './PlanChoices';
import './conversation-requests.css';

export { requestReason };

const BROWSER_FIELDS: Record<string, () => string> = {
  url: () => t('URL'),
  ref: () => t('element ref'),
  element: () => t('element'),
  text: () => t('text'),
  submit: () => t('submit with enter'),
  values: () => t('options'),
  key: () => t('key'),
  accept: () => t('accept dialog'),
  id: () => t('dialog'),
  action: () => t('action'),
  tab: () => t('tab'),
  host: () => t('site'),
  issued_to: () => t('issued to'),
  issued_by: () => t('issued by'),
  valid_until: () => t('valid until'),
  sha256: () => t('SHA-256 fingerprint'),
  site: () => t('site'),
  field: () => t('field'),
  files: () => t('files'),
  paths: () => t('files'),
  // A recorded script: the file, and which of its steps
  path: () => t('file'),
  name: () => t('name'),
  first: () => t('first step'),
  last: () => t('last step'),
  variables: () => t('variables'),
  from: () => t('from step'),
  to: () => t('to step'),
};
export function BrowserApproval({
  input,
}: {
  input?: Record<string, unknown>;
}) {
  const rows = browserApprovalInput(input);
  if (!rows.length) return null;
  return (
    <dl className="browser-approval-input">
      {rows.map(({ key, value }) => (
        <div key={key}>
          <dt>{BROWSER_FIELDS[key]?.() ?? key}</dt>
          <dd>
            <code>{value}</code>
          </dd>
        </div>
      ))}
    </dl>
  );
}

const HOOK_MARKS: Record<string, () => string> = {
  new: () => t('new hook'),
  changed: () => t('changed hook'),
  removed: () => t('removed hook'),
  unchanged: () => t('unchanged hook'),
};
/** Each hook a waiting file holds: new, changed or removed, the unchanged on one line. */
export function HookChanges({
  hooks,
}: {
  hooks: NonNullable<Interaction['hooks']>;
}) {
  const same = hooks.filter((hook) => hook.mark === 'unchanged');
  return (
    <ul className="hook-changes">
      {hooks
        .filter((hook) => hook.mark !== 'unchanged')
        .map((hook, index) => (
          <li key={index} data-mark={hook.mark}>
            <span>
              <strong>{HOOK_MARKS[hook.mark]?.() ?? hook.mark}</strong> ·{' '}
              {hook.name} · {hook.event}
            </span>
            <pre className="approval-command">{hook.command}</pre>
          </li>
        ))}
      {same.length > 0 && (
        <li data-mark="unchanged">
          <span>
            <strong>{HOOK_MARKS.unchanged!()}</strong> ·{' '}
            {same.map((hook) => hook.name).join(', ')}
          </span>
        </li>
      )}
    </ul>
  );
}

/**
 * A request from Circle where it happens in the conversation: an approval under the tool
 * call that waits for it, a question or a secret after the last message. The answer goes
 * to the core gate as the dialog's did.
 */
export function InlineRequest({
  item,
  onSecret,
  onSettled,
  onFile,
}: {
  item: Interaction;
  onSecret: () => void;
  onFile?: (path: string) => void;
  /** Called after the core accepts an answer, while its session still owns focus. */
  onSettled?: () => void;
}) {
  const { runtime, perform, snapshot } = useRuntime();
  const owner = snapshot.sessions.find((row) => row.id === item.sessionId);
  const workspaceId = owner?.workspaceId;
  // The plan a plan card asks about, once Circle has written it
  const plan = owner?.plan;
  const root = snapshot.workspaces.find(
    (workspace) => workspace.id === workspaceId,
  )?.path;
  const target = item.target ? relativePath(item.target, root) : '';
  const sourcePath =
    target &&
    (item.diff ||
      [
        'read_file',
        'write_file',
        'edit_file',
        'apply_patch',
        'delete',
      ].includes(item.tool ?? ''));
  const headingId = useId();
  const terminals = useTerminalState(item.sessionId);
  const userText =
    [
      ...(snapshot.sessions.find((row) => row.id === item.sessionId)
        ?.messages ?? []),
    ]
      .reverse()
      .find((message) => message.role === 'user')?.text ?? '';
  const redirect =
    item.kind === 'approval'
      ? executeTerminalRedirect({
          tool: item.tool,
          command: item.command,
          userText,
          tabs: terminals?.local ?? [],
        })
      : undefined;
  const sending = useRef(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [explaining, setExplaining] = useState(false);
  const [sent, setSent] = useState(false);
  const finish = (answer: string) => {
    if (sending.current) return;
    sending.current = true;
    setSent(true);
    setError('');
    perform(async () => {
      try {
        await runtime.answer(item.id, item.revision, answer);
        if (runtime.getSnapshot().activeSessionId === item.sessionId)
          onSettled?.();
      } catch (error) {
        sending.current = false;
        setSent(false);
        setError(error instanceof Error ? error.message : t('action failed'));
        throw error;
      }
    });
  };
  const failure = error ? (
    <p className="request-failure" role="alert">
      {t('action failed')}: {error}
    </p>
  ) : null;
  if (item.kind === 'secret')
    return (
      <section
        className="inline-request"
        data-kind="secret"
        aria-labelledby={headingId}
      >
        <header>
          <KeyRound size={14} />
          <strong id={headingId}>{item.title}</strong>
        </header>
        <div className="request-actions">
          <Button className="primary" onClick={onSecret}>
            {t('enter secret')}
          </Button>
        </div>
      </section>
    );
  // plan_exit's question: what to do with the plan, which opens beside the card
  if (item.kind === 'plan-exit')
    return (
      <section
        className="inline-request"
        data-kind="plan-exit"
        aria-labelledby={headingId}
        aria-busy={sent}
      >
        <header>
          <ClipboardList size={14} />
          <strong id={headingId}>{t('the plan is ready, what next?')}</strong>
          {item.origin?.name && <small>{item.origin.name}</small>}
        </header>
        <PlanChoices
          name={item.id}
          choices={item.choices ?? []}
          choice={selected[0]}
          words={comment}
          disabled={sent}
          labelledBy={headingId}
          onChoice={(choice) => setSelected([choice])}
          onWords={setComment}
        />
        {failure}
        <div className="request-actions">
          <Button
            className="primary"
            disabled={sent || !planAnswerReady(selected[0], comment)}
            onClick={() => finish(planReply(selected[0]!, comment))}
          >
            {t('send answer')}
          </Button>
          {onFile && plan && (
            <Button onClick={() => onFile(plan.file)}>{t('open plan')}</Button>
          )}
        </div>
      </section>
    );
  // A project hooks file that waits for approval: the hooks of the version that was
  // read, marked against the version approved last. Approval is of exactly that version.
  if (item.kind === 'hooks')
    return (
      <section
        className="inline-request"
        data-kind="hooks"
        aria-labelledby={headingId}
        aria-busy={sent}
      >
        <header>
          <ShieldAlert size={14} />
          <strong id={headingId}>{t('project hooks need approval')}</strong>
          {item.origin?.name && <small>{item.origin.name}</small>}
        </header>
        {target && (
          <div className="request-source">
            <code title={item.target}>{target}</code>
          </div>
        )}
        <HookChanges hooks={item.hooks ?? []} />
        <p className="panel-note">
          {t(
            'These hooks run shell commands. They stay off until you approve this version of the file.',
          )}
        </p>
        {failure}
        <div className="request-actions">
          <Button
            className="primary"
            disabled={sent}
            onClick={() => finish('approve')}
          >
            {t('approve these hooks')}
          </Button>
          <Button disabled={sent} onClick={() => finish('skip')}>
            {t('skip')}
          </Button>
        </div>
      </section>
    );
  if (item.kind === 'question')
    return (
      <section
        className="inline-request"
        data-kind="question"
        aria-labelledby={headingId}
        aria-busy={sent}
      >
        <header>
          <MessageCircleQuestion size={14} />
          <strong id={headingId}>{item.title}</strong>
          {item.origin?.name && <small>{item.origin.name}</small>}
        </header>
        {item.choices?.length ? (
          <div className="request-choices" role="group">
            {item.choices.map((choice) => (
              <label key={choice}>
                <input
                  type={item.multiple ? 'checkbox' : 'radio'}
                  name={item.id}
                  disabled={sent}
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
        {failure}
        <textarea
          disabled={sent}
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
  // Files the model's action downloaded: kept or discarded
  const download = item.reason === 'keeps a download';
  const allowed = (choice: string) =>
    runtime.mode !== 'live' || !!item.choices?.includes(choice);
  return (
    <section
      className="inline-request"
      data-kind="approval"
      aria-labelledby={headingId}
      aria-busy={sent}
    >
      <header>
        <ShieldAlert size={14} />
        <strong id={headingId}>{approvalHeading(item)}</strong>
        <span>{requestReason(item.reason)}</span>
        {item.origin?.name && <small>{item.origin.name}</small>}
      </header>
      {target && (
        <div className="request-source">
          <code title={target}>{target}</code>
          {onFile && sourcePath && (
            <Button onClick={() => onFile(item.target!)}>
              {t('open file')}
            </Button>
          )}
        </div>
      )}
      {failure}
      {item.tool?.startsWith('browser_') ? (
        <BrowserApproval input={item.input} />
      ) : item.command ? (
        <pre className="approval-command">{item.command}</pre>
      ) : item.diff ? (
        <DiffBlock diff={item.diff} path={target || undefined} />
      ) : (
        <>
          {hasToolInput(item.input) && (
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
          {download ? t('keep') : t('allow once')}
        </Button>
        {allowed('always') && (
          <Button
            disabled={sent}
            onClick={() => finish('allow for this session')}
          >
            {item.reason === 'trusts an untrusted certificate'
              ? t('always trust this certificate on this host')
              : item.reason === 'trusts an unknown device host key'
                ? t('trust this device key for good')
                : typeof item.input?.site === 'string' && item.input.site
                  ? t(
                      download
                        ? 'allow downloads from {site} for this session'
                        : 'allow on {site} for this session',
                      { site: item.input.site },
                    )
                  : t('allow for this session')}
          </Button>
        )}
        {runtime.mode === 'live' && item.choices?.includes('prefix') && (
          <Button disabled={sent} onClick={() => finish('prefix')}>
            {item.prefix
              ? t('allow “{prefix}” commands', { prefix: item.prefix })
              : t('allow command prefix')}
          </Button>
        )}
        {redirect && (
          <Button
            disabled={sent}
            onClick={() => {
              if (!redirect || sending.current) return;
              sending.current = true;
              setSent(true);
              setError('');
              const moved = redirect;
              perform(async () => {
                try {
                  // The main process types the card's command in the tab, only where
                  // the line that runs is the card's, and answers the card.
                  await runtime.request(
                    'run-in-terminal',
                    {
                      id: item.id,
                      revision: item.revision,
                      terminal: moved.session,
                    },
                    item.sessionId,
                  );
                  if (runtime.getSnapshot().activeSessionId === item.sessionId)
                    onSettled?.();
                } catch (error) {
                  sending.current = false;
                  setSent(false);
                  setError(
                    error instanceof Error
                      ? redirectRefusal(error.message, moved.ordinal)
                      : t('action failed'),
                  );
                  throw error;
                }
              });
            }}
          >
            {t('run this in terminal {n}', { n: redirect.ordinal })}
          </Button>
        )}
        <Button disabled={sent} onClick={() => finish('reject')}>
          {download ? t('discard') : t('reject')}
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
      {(item.command || item.diff) && hasToolInput(item.input) && (
        <details className="request-input">
          <summary>{t('tool input')}</summary>
          <DataBlock title={t('tool input')} value={item.input} />
        </details>
      )}
    </section>
  );
}
