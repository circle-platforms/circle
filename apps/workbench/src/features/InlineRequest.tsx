import { useState } from 'react';
import { KeyRound, MessageCircleQuestion, ShieldAlert } from 'lucide-react';
import { useRuntime } from '../app/context';
import { Button } from '../components/common';
import { DataBlock } from '../components/ui';
import { DiffBlock } from '../components/DiffBlock';
import type { Interaction } from '../model/types';
import { t } from '../i18n';
import { relativePath } from '../model/format';
import { browserApprovalInput, hasToolInput } from '../model/browser';

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
  'opens a page in the browser': () => t('opens a page in the browser'),
  'clicks in the browser': () => t('clicks in the browser'),
  'types in the browser': () => t('types in the browser'),
  'chooses an option in the browser': () =>
    t('chooses an option in the browser'),
  'presses a key in the browser': () => t('presses a key in the browser'),
  'answers a dialog in the browser': () => t('answers a dialog in the browser'),
  "manages the browser's tabs": () => t("manages the browser's tabs"),
  'trusts an untrusted certificate': () => t('trusts an untrusted certificate'),
  'gives the page files': () => t('gives the page files'),
  'keeps a download': () => t('keeps a download'),
};
export const requestReason = (reason?: string) =>
  reason ? (REASONS[reason]?.() ?? reason) : '';

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
  // Files the model's action downloaded: kept or discarded
  const download = item.reason === 'keeps a download';
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
      {item.tool?.startsWith('browser_') ? (
        <BrowserApproval input={item.input} />
      ) : item.command ? (
        <pre className="approval-command">{item.command}</pre>
      ) : item.diff ? (
        <DiffBlock diff={item.diff} path={target || undefined} />
      ) : (
        <>
          {target && <p className="file-path">{target}</p>}
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
