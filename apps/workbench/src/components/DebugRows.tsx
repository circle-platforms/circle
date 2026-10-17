import { Button } from './common';
import { t } from '../i18n';
export function DebugSourceLabel({
  name,
  path,
  line,
}: {
  name?: string;
  path: string;
  line: number;
}) {
  return (
    <span className="debug-source-label">
      {name && (
        <>
          <strong>{name}</strong>{' '}
        </>
      )}
      <small>
        {path}:{line}
      </small>
    </span>
  );
}
export function DebugBreakpointRow({
  path,
  line,
  verified,
  onOpen,
  onRemove,
}: {
  path: string;
  line: number;
  verified: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="debug-breakpoint">
      <Button onClick={onOpen}>
        {path}:{line}
      </Button>
      <span>
        {verified ? t('verified breakpoint') : t('pending breakpoint')}
      </span>
      <Button onClick={onRemove}>{t('remove breakpoint')}</Button>
    </div>
  );
}
export function DebugVariableRow({
  name,
  value,
  onExpand,
}: {
  name: string;
  value: string;
  onExpand?: () => void;
}) {
  return (
    <div className="debug-variable-row">
      <Button aria-label={name} disabled={!onExpand} onClick={onExpand}>
        <code>
          {name}: {value}
        </code>
      </Button>
    </div>
  );
}
