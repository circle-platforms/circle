import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight, GitBranch, Search } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type {
  Checkout,
  CheckoutBranches,
} from '../../../desktop/src/checkouts';
import { useRuntimeActions } from '../app/context';
import { t } from '../i18n';
import type { Workspace } from '../model/types';
import type { HomeWorktree } from './home-selection';
import './home-worktrees.css';

type Load<T> = { data?: T; error?: boolean };

export function useHomeBranches(project?: Workspace) {
  const { runtime } = useRuntimeActions();
  const workspaceId = project?.id;
  const [result, setResult] = useState<
    Load<CheckoutBranches> & { workspaceId: string }
  >();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    void (async () => {
      try {
        const data = (await runtime.request('checkout-branches', {
          workspaceId,
        })) as CheckoutBranches;
        if (current) setResult({ workspaceId, data });
      } catch {
        if (current) setResult({ workspaceId, error: true });
      }
    })();
    return () => {
      current = false;
    };
  }, [runtime, workspaceId, project?.branch, revision]);
  return {
    branches: result?.workspaceId === workspaceId ? result : undefined,
    refreshBranches: () => setRevision((value) => value + 1),
  };
}

export function WorktreeCheckbox({
  worktree,
  branches,
  disabled,
  onChoose,
}: {
  worktree?: HomeWorktree;
  branches?: Load<CheckoutBranches>;
  disabled: boolean;
  onChoose: (worktree?: HomeWorktree) => void;
}) {
  const chosenId = useId();
  const base = branches?.data?.current ?? undefined;
  const checkout =
    worktree && 'checkout' in worktree ? worktree.checkout : undefined;
  const chosen =
    worktree && 'base' in worktree ? worktree.base : checkout?.branch;
  return (
    <label
      className="footbar-button home-worktree"
      title={checkout?.path ?? chosen ?? base}
    >
      <input
        type="checkbox"
        aria-label={t('worktree')}
        aria-describedby={chosen ? chosenId : undefined}
        checked={!!worktree}
        disabled={disabled || (!worktree && !base)}
        onChange={(event) =>
          onChoose(event.target.checked && base ? { base } : undefined)
        }
      />
      <span>{t('worktree')}</span>
      {chosen && <small id={chosenId}>{chosen}</small>}
    </label>
  );
}

type LocationChoice = {
  id: string;
  name: string;
  title?: string;
  hint?: string;
};

function ProjectLocationMenu({
  label,
  value,
  icon,
  open,
  onOpenChange,
  searchLabel,
  options,
  selected,
  empty,
  noMatch,
  onSelect,
}: {
  label: string;
  value?: string;
  icon?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  searchLabel: string;
  options: LocationChoice[];
  selected?: string;
  empty: string;
  noMatch: string;
  onSelect: (id: string) => void;
}) {
  const valueId = useId();
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const filter = query.trim().toLowerCase();
  const matches = options.filter((item) =>
    (item.name + ' ' + (item.title ?? '')).toLowerCase().includes(filter),
  );
  return (
    <DropdownMenu.Sub
      open={open}
      onOpenChange={(next) => {
        setQuery('');
        onOpenChange(next);
      }}
    >
      <DropdownMenu.SubTrigger
        aria-label={label}
        aria-describedby={value ? valueId : undefined}
        className="project-location-trigger"
      >
        {icon}
        <span>{label}</span>
        {value && (
          <small id={valueId} title={value}>
            {value}
          </small>
        )}
        <ChevronRight size={13} />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          className="dropdown project-menu home-menu project-location-menu"
          sideOffset={4}
          collisionPadding={8}
        >
          <div className="project-picker-search">
            <Search size={14} />
            <input
              ref={search}
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') return;
                event.stopPropagation();
                if (event.nativeEvent.isComposing) return;
                if (event.key !== 'ArrowDown' && event.key !== 'Enter') return;
                const first =
                  list.current?.querySelector<HTMLElement>('[role="menuitem"]');
                if (!first) return;
                event.preventDefault();
                if (event.key === 'Enter') first.click();
                else first.focus();
              }}
            />
          </div>
          <div
            ref={list}
            className="project-location-list"
            onKeyDown={(event) => {
              if (
                event.key === 'ArrowUp' &&
                event.target ===
                  list.current?.querySelector('[role="menuitem"]')
              ) {
                event.preventDefault();
                search.current?.focus();
              }
            }}
          >
            {matches.map((item) => (
              <DropdownMenu.Item
                key={item.id}
                title={item.title}
                aria-current={item.id === selected ? 'true' : undefined}
                onSelect={() => onSelect(item.id)}
              >
                <span>
                  {item.name}
                  {item.hint && (
                    <small className="project-hint">{item.hint}</small>
                  )}
                </span>
                {item.id === selected && <Check size={14} />}
              </DropdownMenu.Item>
            ))}
            {!matches.length && (
              <p className="project-picker-empty" role="status">
                {options.length ? noMatch : empty}
              </p>
            )}
          </div>
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

export function HomeWorktreeMenus({
  project,
  worktree,
  branches,
  refreshBranches,
  onChoose,
}: {
  project: Workspace;
  worktree?: HomeWorktree;
  branches?: Load<CheckoutBranches>;
  refreshBranches: () => void;
  onChoose: (worktree: HomeWorktree) => void;
}) {
  const { runtime } = useRuntimeActions();
  const [branchOpen, setBranchOpen] = useState(false);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [checkouts, setCheckouts] = useState<Load<Checkout[]>>();
  useEffect(() => {
    if (!worktreeOpen) return;
    let current = true;
    void (async () => {
      try {
        const result = (await runtime.request('checkouts', {
          workspaceId: project.id,
        })) as Checkout[];
        // The first row is the selected project's own folder.
        if (current) setCheckouts({ data: result.slice(1) });
      } catch {
        if (current) setCheckouts({ error: true });
      }
    })();
    return () => {
      current = false;
    };
  }, [runtime, project.id, worktreeOpen]);

  const currentBranch = branches?.data?.current;
  const names = branches?.data?.branches ?? [];
  const branch =
    worktree && 'base' in worktree
      ? worktree.base
      : (currentBranch ?? undefined);
  const checkout =
    worktree && 'checkout' in worktree ? worktree.checkout : undefined;
  const branchRows = currentBranch
    ? [currentBranch, ...names.filter((name) => name !== currentBranch)]
    : names;
  const linked = checkouts?.data ?? [];
  const checkoutRows = linked.map((row) => ({
    id: row.id,
    name: row.branch,
    title: row.path,
    hint: linked.some(
      (other) => other.id !== row.id && other.branch === row.branch,
    )
      ? row.path
      : undefined,
  }));
  return (
    <>
      <ProjectLocationMenu
        label={t('starting branch')}
        value={branch}
        icon={<GitBranch size={14} />}
        open={branchOpen}
        onOpenChange={(open) => {
          setBranchOpen(open);
          if (open) refreshBranches();
        }}
        searchLabel={t('search branches')}
        options={branchRows.map((name) => ({ id: name, name }))}
        selected={branch}
        empty={
          branches?.error
            ? t('could not load branches')
            : branches?.data
              ? t('no local branches')
              : t('loading…')
        }
        noMatch={t('no matching branches')}
        onSelect={(base) => onChoose({ base })}
      />
      <ProjectLocationMenu
        label={t('use existing worktree')}
        value={checkout?.branch}
        open={worktreeOpen}
        onOpenChange={(open) => {
          setWorktreeOpen(open);
          if (open) setCheckouts(undefined);
        }}
        searchLabel={t('search worktrees')}
        options={checkoutRows}
        selected={checkout?.id}
        empty={
          checkouts?.error
            ? t('could not load worktrees')
            : checkouts?.data
              ? t('no other worktrees')
              : t('loading…')
        }
        noMatch={t('no matching worktrees')}
        onSelect={(id) => {
          const chosen = linked.find((row) => row.id === id);
          if (chosen) onChoose({ checkout: chosen });
        }}
      />
    </>
  );
}
