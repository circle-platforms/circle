import {
  Play,
  Pause,
  StepForward,
  ArrowDownToLine,
  ArrowUpFromLine,
  Square,
} from 'lucide-react';
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
  return (
    <div
      className="debug-toolbar"
      role="toolbar"
      aria-label={t('project debug')}
    >
      {(
        [
          ['continue', continueLabel ?? t('continue'), Play],
          ['pause', t('pause'), Pause],
          ['next', t('step over'), StepForward],
          ['stepIn', t('step into'), ArrowDownToLine],
          ['stepOut', t('step out'), ArrowUpFromLine],
          ['stop', t('stop'), Square],
        ] as const
      )
        .filter(([action]) => stop || action !== 'stop')
        .map(([action, label, Icon]) => (
          <IconButton
            key={action}
            label={label}
            disabled={busy || !enabled(action)}
            onClick={() => onAction(action)}
          >
            <Icon size={16} />
          </IconButton>
        ))}
    </div>
  );
}
