import {
  Play,
  Pause,
  StepForward,
  ArrowDownToLine,
  ArrowUpFromLine,
  Square,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { IconButton } from './common';
import { t } from '../i18n';
import './debug-panel.css';
export type DebugAction =
  'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut' | 'stop';
/** Shared controls; the owning backend keeps its target and lifecycle semantics. */
export function DebugToolbar({
  enabled,
  onAction,
  busy = false,
  stop = true,
  continueLabel,
}: {
  enabled: (action: DebugAction) => boolean;
  onAction: (action: DebugAction) => void;
  busy?: boolean;
  stop?: boolean;
  continueLabel?: string;
}) {
  // Run, step and end, grouped as debuggers usually lay them out.
  const groups: [DebugAction, string, LucideIcon][][] = [
    [
      ['continue', continueLabel ?? t('continue'), Play],
      ['pause', t('pause'), Pause],
    ],
    [
      ['next', t('step over'), StepForward],
      ['stepIn', t('step into'), ArrowDownToLine],
      ['stepOut', t('step out'), ArrowUpFromLine],
    ],
    stop ? [['stop', t('stop'), Square]] : [],
  ];
  return (
    <div
      className="debug-toolbar"
      role="toolbar"
      aria-label={t('debug controls')}
    >
      {groups
        .filter((group) => group.length)
        .map((group, index) => (
          <span className="debug-toolbar-group" key={index}>
            {group.map(([action, label, Icon]) => (
              <IconButton
                key={action}
                label={label}
                disabled={busy || !enabled(action)}
                onClick={() => onAction(action)}
              >
                <Icon size={15} aria-hidden="true" />
              </IconButton>
            ))}
          </span>
        ))}
    </div>
  );
}
