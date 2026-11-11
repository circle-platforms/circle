import { useEffect, useState, type ReactNode } from 'react';
import { useRuntime } from '../app/context';
import { t } from '../i18n';
import type { Checkout } from '../../../desktop/src/checkouts';

/**
 * Where a conversation runs: the project's own checkout or another checkout of its
 * repository. On the home page it chooses for the conversation about to start. With a
 * session it moves that conversation, and its button is whatever already names the place
 * (the top bar's project and branch), so the conversation gets no row of its own for it.
 */
export function CheckoutPicker({
  workspaceId,
  selected,
  onChoose,
  sessionId,
  className = 'footbar-button',
  title,
  children,
}: {
  workspaceId: string;
  selected?: string;
  onChoose?: (id: string) => void;
  sessionId?: string;
  /** The button's class, and its content in place of the word. */
  className?: string;
  title?: string;
  children?: ReactNode;
}) {
  const { runtime, perform } = useRuntime();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Checkout[]>([]);
  const [branch, setBranch] = useState('');
  const [start, setStart] = useState('HEAD');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setOpen(false);
    setRows([]);
  }, [workspaceId, sessionId]);
  const refresh = async () => {
    const result = await runtime.request(
      'checkouts',
      { workspaceId },
      sessionId,
    );
    if (Array.isArray(result)) setRows(result);
  };
  const choose = async (id: string) => {
    if (sessionId)
      await runtime.request('switch-checkout', { checkoutId: id }, sessionId);
    else onChoose?.(id);
    setOpen(false);
  };
  const run = (action: () => Promise<void>) =>
    perform(async () => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    });
  return (
    <div className="checkout-picker">
      <button
        className={className}
        type="button"
        title={title}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() =>
          run(async () => {
            await refresh();
            setOpen(!open);
          })
        }
      >
        {children ?? t('checkout')}
      </button>
      {open && (
        <div
          className="checkout-options"
          role="group"
          aria-label={sessionId ? t('continue in worktree…') : t('checkout')}
        >
          {sessionId && <strong>{t('continue in worktree…')}</strong>}
          {sessionId && (
            <p>
              {t(
                'only future execution moves; uncommitted changes stay in their checkout',
              )}
            </p>
          )}
          {!rows.length && <p>{t('this project is not a Git repository')}</p>}
          {rows.map((row) => (
            <button
              type="button"
              key={row.id}
              disabled={busy}
              aria-pressed={selected ? selected === row.id : row.current}
              title={row.path}
              onClick={() => run(() => choose(row.id))}
            >
              <strong>{row.branch}</strong>
              <span>{row.path}</span>
            </button>
          ))}
          {!!rows.length && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  const created = (await runtime.request(
                    'create-checkout',
                    { workspaceId, branch, start },
                    sessionId,
                  )) as Checkout;
                  await refresh();
                  await choose(created.id);
                });
              }}
            >
              <label>
                {t('new branch')}
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  required
                />
              </label>
              <label>
                {t('starting branch or commit')}
                <input
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                  required
                />
              </label>
              <button disabled={busy || !branch.trim() || !start.trim()}>
                {t('create worktree')}
              </button>
            </form>
          )}
          <button type="button" disabled={busy} onClick={() => setOpen(false)}>
            {t('cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
