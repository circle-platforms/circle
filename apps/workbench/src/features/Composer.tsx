import { DropdownMenu } from 'radix-ui';
import {
  Check,
  ChevronDown,
  FileCheck,
  Hand,
  ListChecks,
  Zap,
} from 'lucide-react';
import type { Effort, Model, Session, SessionMode } from '../model/types';
import { EFFORTS, MODES, sessionMode } from '../model/state';
import { t } from '../i18n';
import './composer.css';

export const MODE_TEXT: Record<
  SessionMode,
  { label: () => string; detail: () => string; icon: typeof Hand }
> = {
  manual: {
    label: () => t('manual'),
    detail: () => t('asks before each change and command'),
    icon: Hand,
  },
  'accept-edits': {
    label: () => t('accept edits'),
    detail: () =>
      t('edits workspace files without asking; commands and deletes still ask'),
    icon: FileCheck,
  },
  plan: {
    label: () => t('plan'),
    detail: () => t('read-only: researches and writes a plan, changes nothing'),
    icon: ListChecks,
  },
  auto: {
    label: () => t('auto'),
    // Shown when it is turned on: what it lets through
    detail: () =>
      t(
        'asks nothing: commands that delete, certificate warnings and uploads go ahead; use it only where that is safe',
      ),
    icon: Zap,
  },
};

type MenuPlacement = {
  /** Home opens downward; a session composer at the bottom of the window opens upward. */
  side?: 'top' | 'bottom';
  onCloseFocus?: () => void;
};

function closeMenu(
  onCloseFocus?: () => void,
): (event: { preventDefault(): void }) => void {
  return (event) => {
    event.preventDefault();
    onCloseFocus?.();
  };
}

/** How the session answers approvals: manual, accept edits, plan or auto. */
export function ModeMenu({
  session,
  onMode,
  side = 'top',
  onCloseFocus,
}: {
  session: Session;
  onMode: (mode: SessionMode) => void;
} & MenuPlacement) {
  const mode = sessionMode(session);
  const Icon = MODE_TEXT[mode].icon;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          className="footbar-button mode-button"
          data-mode={mode}
          aria-label={t('approval mode')}
          title={MODE_TEXT[mode].detail()}
          onMouseDown={(event) => event.preventDefault()}
        >
          <Icon size={13} />
          {MODE_TEXT[mode].label()}
          <ChevronDown size={11} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`dropdown composer-menu mode-menu${side === 'bottom' ? ' home-menu' : ''}`}
          side={side}
          // Home menus always open downward and scroll within the room below;
          // flipping would cover the composer they belong to.
          avoidCollisions={side !== 'bottom'}
          collisionPadding={8}
          align="start"
          sideOffset={7}
          onCloseAutoFocus={closeMenu(onCloseFocus)}
        >
          {MODES.map((item) => {
            const ItemIcon = MODE_TEXT[item].icon;
            return (
              <DropdownMenu.Item
                key={item}
                data-mode={item}
                onSelect={() => onMode(item)}
              >
                <ItemIcon size={14} />
                <span>
                  <strong>{MODE_TEXT[item].label()}</strong>
                  <small>{MODE_TEXT[item].detail()}</small>
                </span>
                {item === mode && <Check size={13} />}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// How deep the model thinks, as the menu names the levels; the value stays the core's.
export const EFFORT_TEXT: Record<
  Effort,
  { label: () => string; detail: () => string }
> = {
  default: {
    label: () => t('default'),
    detail: () => t("the endpoint's usual depth"),
  },
  minimal: {
    label: () => t('minimal'),
    detail: () => t('shortest reasoning'),
  },
  low: {
    label: () => t('low'),
    detail: () => t('a little reasoning'),
  },
  medium: {
    label: () => t('medium'),
    detail: () => t('balanced, the usual default'),
  },
  high: {
    label: () => t('high'),
    detail: () => t('deeper reasoning for harder problems'),
  },
  xhigh: {
    label: () => t('very high'),
    detail: () => t('long reasoning, slower and uses more tokens'),
  },
  max: {
    label: () => t('maximum'),
    detail: () => t('the longest reasoning the endpoint allows'),
  },
};

/** The model of this session, chosen from the endpoint's models, as Claude's picker. */
export function ModelMenu({
  session,
  models,
  enabled,
  onModel,
  onManage,
  side = 'top',
  onCloseFocus,
}: {
  session: Session;
  models: Model[];
  enabled: string[];
  onModel: (id: string) => void;
  onManage: () => void;
} & MenuPlacement) {
  const shown = models.filter(
    (model) =>
      model.id !== 'not connected' &&
      (!enabled.length ||
        enabled.includes(model.id) ||
        model.id === session.model),
  );
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          className="footbar-button"
          aria-label={t('model')}
          onMouseDown={(event) => event.preventDefault()}
        >
          <span className="footbar-model">{session.model}</span>
          <ChevronDown size={11} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`dropdown composer-menu footbar-menu${side === 'bottom' ? ' home-menu' : ''}`}
          side={side}
          // Home menus always open downward and scroll within the room below;
          // flipping would cover the composer they belong to.
          avoidCollisions={side !== 'bottom'}
          collisionPadding={8}
          align="end"
          sideOffset={7}
          onCloseAutoFocus={closeMenu(onCloseFocus)}
        >
          {shown.map((model) => (
            <DropdownMenu.Item
              key={model.id}
              onSelect={() => onModel(model.id)}
            >
              <span>{model.id}</span>
              {model.id === session.model && <Check size={13} />}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Item onSelect={onManage}>
            {t('manage models…')}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The thinking depth of this session. */
export function EffortMenu({
  session,
  onEffort,
  side = 'top',
  onCloseFocus,
}: {
  session: Session;
  onEffort: (effort: Effort) => void;
} & MenuPlacement) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          className="footbar-button"
          aria-label={t('thinking depth')}
          onMouseDown={(event) => event.preventDefault()}
        >
          {EFFORT_TEXT[session.effort]?.label() ?? session.effort}
          <ChevronDown size={11} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`dropdown composer-menu footbar-menu effort-menu${side === 'bottom' ? ' home-menu' : ''}`}
          side={side}
          // Home menus always open downward and scroll within the room below;
          // flipping would cover the composer they belong to.
          avoidCollisions={side !== 'bottom'}
          collisionPadding={8}
          align="end"
          sideOffset={7}
          onCloseAutoFocus={closeMenu(onCloseFocus)}
        >
          {(['default', ...EFFORTS] as Effort[]).map((effort) => (
            <DropdownMenu.Item
              key={effort}
              // Named by the depth; the line under it describes it.
              aria-label={EFFORT_TEXT[effort].label()}
              aria-description={EFFORT_TEXT[effort].detail()}
              onSelect={() => onEffort(effort)}
            >
              <span>
                <strong>{EFFORT_TEXT[effort].label()}</strong>
                <small>{EFFORT_TEXT[effort].detail()}</small>
              </span>
              {effort === session.effort && <Check size={13} />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
