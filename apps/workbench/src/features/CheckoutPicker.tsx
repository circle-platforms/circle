import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  Folder,
  GitBranch,
  Plus,
  SquareTerminal,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useRuntimeActions } from '../app/context';
import { Button, Modal, SearchInput } from '../components/common';
import { copyText } from '../host';
import { t } from '../i18n';
import type { Checkout } from '../../../desktop/src/checkouts';

type MoveStatus = { reason?: string };

function moveError(message: string) {
  switch (message) {
    case 'restore this session before continuing':
      return t('restore this session before continuing');
    case 'task conversations use their own worktree':
      return t('task conversations use their own worktree');
    case "stop this session's native resources and tasks before moving it":
      return t(
        "stop this session's native resources and tasks before moving it",
      );
    case "stop this session's tasks before moving it":
      return t("stop this session's tasks before moving it");
    case 'stop this session before moving it':
      return t('stop this session before moving it');
    case 'finish or remove queued messages before switching checkouts':
      return t('finish or remove queued messages before switching checkouts');
    case 'execution location changed; reopen the worktree menu':
      return t('execution location changed; reopen the worktree menu');
    case 'execution branch changed; reopen the worktree menu':
      return t('execution branch changed; reopen the worktree menu');
    case 'destination branch changed; reopen the worktree menu':
      return t('destination branch changed; reopen the worktree menu');
    case 'wait for the worktree switch to finish':
      return t('wait for the worktree switch to finish');
    case 'wait for workspace actions to finish before moving this session':
      return t(
        'wait for workspace actions to finish before moving this session',
      );
    default:
      return message;
  }
}

/** The current project and branch stay in the top bar's single row. */
export function SessionCheckoutMenu({
  sessionId,
  project,
  branch,
  path,
  onMove,
  onTerminal,
}: {
  sessionId: string;
  project: string;
  branch: string;
  path: string;
  onMove: () => void;
  onTerminal: () => void;
}) {
  const { runtime, perform, notify } = useRuntimeActions();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<MoveStatus>();
  useEffect(() => {
    if (!open) return;
    let current = true;
    void Promise.resolve(
      runtime.request('checkout-move-status', {}, sessionId),
    ).then(
      (result) => {
        if (current) setStatus(result as MoveStatus);
      },
      (error) => {
        if (current) setStatus({ reason: (error as Error).message });
      },
    );
    return () => {
      current = false;
    };
  }, [runtime, sessionId, open]);

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setStatus(undefined);
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="project-chip"
          aria-label={t('branch {branch}', { branch })}
          title={`${project} · ${branch}
${path}`}
        >
          <Folder size={12} />
          <span>{project}</span>
          <GitBranch size={11} />
          <span>{branch}</span>
          <ChevronDown size={11} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown checkout-menu"
          align="start"
          sideOffset={6}
        >
          <DropdownMenu.Item
            onSelect={() =>
              perform(async () => {
                await copyText(branch);
                notify(t('copied'));
              })
            }
          >
            <Copy size={14} />
            {t('copy branch name')}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={onTerminal}>
            <SquareTerminal size={14} />
            {t('open in terminal')}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Item disabled={!!status?.reason} onSelect={onMove}>
            <GitBranch size={14} />
            {t('continue in worktree…')}
          </DropdownMenu.Item>
          {status?.reason && (
            <p role="status" className="checkout-menu-reason">
              {moveError(status.reason)}
            </p>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Choosing a destination first shows the effect of moving this conversation. */
export function MoveCheckoutDialog({
  sessionId,
  workspaceId,
  path,
  branch,
  onClose,
}: {
  sessionId: string;
  workspaceId: string;
  path: string;
  branch: string;
  onClose: () => void;
}) {
  const { runtime } = useRuntimeActions();
  const [source] = useState({ path, branch });
  const [rows, setRows] = useState<Checkout[]>();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<Checkout | 'new'>();
  const [moving, setMoving] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let current = true;
    void Promise.all([
      runtime.request(
        'checkout-move-status',
        {},
        sessionId,
      ) as Promise<MoveStatus>,
      runtime.request('checkouts', { workspaceId }, sessionId) as Promise<
        Checkout[]
      >,
    ]).then(
      ([status, checkouts]) => {
        if (!current) return;
        setReason(status.reason ? moveError(status.reason) : '');
        setRows(checkouts);
      },
      (failure) => {
        if (current) setError(moveError((failure as Error).message));
      },
    );
    return () => {
      current = false;
    };
  }, [runtime, sessionId, workspaceId]);
  useEffect(() => {
    if (target) confirm.current?.focus({ preventScroll: true });
  }, [target]);

  const query = search.trim().toLowerCase();
  const visible = rows?.filter((row) =>
    (row.branch + ' ' + row.path).toLowerCase().includes(query),
  );
  const move = async () => {
    if (!target || moving) return;
    setError('');
    setMoving(true);
    try {
      await runtime.request(
        'switch-checkout',
        {
          expectedPath: source.path,
          ...(target === 'new'
            ? { createWorktree: true, expectedBranch: source.branch }
            : { checkoutId: target.id, expectedTargetBranch: target.branch }),
        },
        sessionId,
      );
      onClose();
    } catch (failure) {
      setError(moveError((failure as Error).message));
    } finally {
      setMoving(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !moving) onClose();
      }}
      title={t('continue in worktree…')}
      className="checkout-dialog"
      restoreFocus
    >
      {target ? (
        <>
          <dl className="checkout-locations">
            <dt>{t('current location')}</dt>
            <dd>
              <bdi>{source.branch}</bdi>
              <small title={source.path}>
                <bdi dir="ltr">{source.path}</bdi>
              </small>
            </dd>
            <dt>{t('destination')}</dt>
            <dd>
              {target === 'new' ? (
                t('new worktree from {branch}', { branch: source.branch })
              ) : (
                <>
                  <bdi>{target.branch}</bdi>
                  <small title={target.path}>
                    <bdi dir="ltr">{target.path}</bdi>
                  </small>
                </>
              )}
            </dd>
          </dl>
          <p className="checkout-move-note">
            {t(
              'only future execution moves; uncommitted changes stay in their checkout',
            )}
          </p>
        </>
      ) : reason ? (
        <p className="dialog-paragraph" role="status">
          {reason}
        </p>
      ) : rows ? (
        <>
          <SearchInput
            label={t('search worktrees')}
            placeholder={t('search worktrees')}
            value={search}
            onChange={setSearch}
            autoFocus
          />
          <ul className="checkout-choices">
            {visible?.map((row) => {
              const ambiguous = rows.some(
                (other) => other.id !== row.id && other.branch === row.branch,
              );
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    title={row.path}
                    aria-current={row.current ? 'true' : undefined}
                    disabled={row.current}
                    onClick={() => setTarget(row)}
                  >
                    <GitBranch size={14} />
                    <span>
                      <bdi>{row.branch}</bdi>
                      {ambiguous && (
                        <small>
                          <bdi>{row.path}</bdi>
                        </small>
                      )}
                    </span>
                    {row.current && <Check size={14} />}
                  </button>
                </li>
              );
            })}
            {!visible?.length && (
              <li className="checkout-move-note">
                {t('no matching worktrees')}
              </li>
            )}
          </ul>
          {!query && (
            <button
              className="checkout-create"
              type="button"
              onClick={() => setTarget('new')}
            >
              <Plus size={14} />
              {t('create worktree')}
            </button>
          )}
        </>
      ) : !error ? (
        <p role="status">{t('loading…')}</p>
      ) : null}
      {error && (
        <p role="alert" className="checkout-move-note">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        {target ? (
          <>
            <Button
              type="button"
              disabled={moving}
              onClick={() => {
                setTarget(undefined);
                setError('');
              }}
            >
              {t('back')}
            </Button>
            <Button
              type="button"
              ref={confirm}
              className="primary"
              disabled={moving}
              onClick={() => void move()}
            >
              {moving ? t('moving conversation…') : t('continue')}
            </Button>
          </>
        ) : (
          <Button type="button" onClick={onClose}>
            {t('cancel')}
          </Button>
        )}
      </div>
    </Modal>
  );
}
