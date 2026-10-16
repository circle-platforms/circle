import { useEffect, useState } from 'react';
import { DropdownMenu, Popover } from 'radix-ui';
import {
  Check,
  ChevronDown,
  FileCheck,
  Hand,
  ListChecks,
  Zap,
} from 'lucide-react';
import type { Effort, Job, Model, Session, SessionMode } from '../model/types';
import { EFFORTS, MODES, sessionMode } from '../model/state';
import { contextPercent, formatTokens, formatWindow } from '../model/format';
import { t, tn } from '../i18n';

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
          className={`dropdown mode-menu${side === 'bottom' ? ' home-menu' : ''}`}
          side={side}
          {...(side === 'bottom'
            ? { avoidCollisions: false, collisionPadding: 8 }
            : {})}
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
          className={`dropdown footbar-menu${side === 'bottom' ? ' home-menu' : ''}`}
          side={side}
          {...(side === 'bottom'
            ? { avoidCollisions: false, collisionPadding: 8 }
            : {})}
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
          className={`dropdown footbar-menu effort-menu${side === 'bottom' ? ' home-menu' : ''}`}
          side={side}
          {...(side === 'bottom'
            ? { avoidCollisions: false, collisionPadding: 8 }
            : {})}
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

/**
 * The context as a ring at the end of the footbar, as Claude shows it: how full the
 * window is after the last answer, orange from 70% and red from 90%. Its popover has
 * the terminal footer's numbers (tokens, cost, cache) and the session's actions.
 */
export function ContextRing({
  session,
  jobs,
  onCompact,
  onJobs,
  onDetails,
}: {
  session: Session;
  jobs: Job[];
  onCompact: () => void;
  onJobs: () => void;
  onDetails: () => void;
}) {
  const meters = session.meters;
  const running = jobs.filter((job) => job.state === 'running').length;
  const percent = contextPercent(meters?.contextInput, meters?.contextWindow);
  const level =
    percent === null
      ? ''
      : percent >= 90
        ? 'full'
        : percent >= 70
          ? 'high'
          : '';
  const cache =
    meters?.cache ??
    (meters && meters.input
      ? `${((Math.min(meters.cacheRead, meters.input) / meters.input) * 100).toFixed(1)}%`
      : 'N/A');
  const context =
    meters && meters.contextInput !== null
      ? meters.contextWindow
        ? `${formatTokens(meters.contextInput)} / ${formatWindow(meters.contextWindow)} (${Math.round(percent ?? 0)}%)`
        : `${formatTokens(meters.contextInput)} / N/A`
      : 'N/A';
  const radius = 6.5;
  const around = 2 * Math.PI * radius;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className={`context-ring ${level}`}
          aria-label={t('context and usage')}
          title={t('context {value}', { value: context })}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <circle className="track" cx="9" cy="9" r={radius} />
            <circle
              className="fill"
              cx="9"
              cy="9"
              r={radius}
              strokeDasharray={around}
              strokeDashoffset={
                around * (1 - Math.min(100, percent ?? 0) / 100)
              }
            />
          </svg>
          {running > 0 && <span className="ring-badge">{running}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="popover usage-popover"
          side="top"
          align="end"
          sideOffset={8}
        >
          <dl>
            <dt>{t('context')}</dt>
            <dd className={level}>{context}</dd>
            <dt>{t('tokens')}</dt>
            <dd>
              {meters
                ? `↑ ${formatTokens(meters.input)} · ↓ ${formatTokens(meters.output)}`
                : 'N/A'}
            </dd>
            <dt>{t('cost')}</dt>
            <dd title={t('estimated from the model’s published prices')}>
              {meters?.cost ?? 'N/A'}
            </dd>
            <dt>{t('cache')}</dt>
            <dd>{cache === 'N/A' ? t('cache N/A') : cache}</dd>
          </dl>
          <div className="usage-actions">
            <Popover.Close asChild>
              <button onClick={onCompact}>{t('compact context')}</button>
            </Popover.Close>
            {running > 0 && (
              <Popover.Close asChild>
                <button onClick={onJobs}>
                  {tn(running, '{n} job running', '{n} jobs running')}
                </button>
              </Popover.Close>
            )}
            <Popover.Close asChild>
              <button onClick={onDetails}>{t('session details')}</button>
            </Popover.Close>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
