import type { TerminalSnapshot } from '../../../desktop/src/workspace/terminal';
import { t } from '../i18n';

export function status(snapshot: TerminalSnapshot): string {
  if (snapshot.managedCommand) {
    const root = snapshot.managedCommand.completion.rootExit;
    if (root)
      return root.signal
        ? t('ended by signal {signal}', { signal: root.signal })
        : t('exited (code {code})', { code: root.exitCode });
    if (!['running', 'stopping'].includes(snapshot.status))
      return t('terminal closed');
  }

  if (snapshot.kind === 'service') {
    if (snapshot.serviceState === 'starting') return t('service starting');
    if (snapshot.serviceState === 'ready') return t('service ready');
    if (snapshot.serviceState === 'running') return t('service running');
    if (snapshot.serviceState === 'stopped') return t('stopped');
    if (snapshot.serviceState === 'failed' && snapshot.status === 'running')
      return t('readiness failed');
  }
  switch (snapshot.status) {
    case 'running':
      return t('running');
    case 'stopping':
      return t('stopping');
    case 'exited':
      return snapshot.signal
        ? t('ended by signal {signal}', { signal: snapshot.signal })
        : t('exited (code {code})', { code: snapshot.exitCode ?? 0 });
    case 'failed':
      return t('failed');
    case 'interrupted':
      return t('interrupted');
  }
}

/** The exit reason adds nothing when it only restates the status line. */
export function extraExitReason(snapshot: TerminalSnapshot) {
  const reason = snapshot.exitReason;
  if (!reason || snapshot.managedCommand) return '';
  const code = snapshot.exitCode ?? 0;
  const same = [
    status(snapshot),
    `exit ${code}`,
    snapshot.signal ? `signal ${snapshot.signal}` : '',
    snapshot.signal ?? '',
  ];
  return same.includes(reason) ? '' : reason;
}

/** The folder a terminal runs in, by name; the full path is in its tooltip. */
export function folderName(path: string) {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).at(-1) || path;
}

/** Process ids are for developers: they stay in the status tooltip. */
export function processDetails(snapshot: TerminalSnapshot) {
  const ids = snapshot.managedCommand
    ? [
        snapshot.managedCommand.commandPid !== undefined
          ? t('command pid {pid}', {
              pid: snapshot.managedCommand.commandPid,
            })
          : '',
        snapshot.pid !== undefined
          ? t('pty pid {pid}', { pid: snapshot.pid })
          : '',
      ]
    : [
        snapshot.pid !== undefined
          ? t('process pid {pid}', { pid: snapshot.pid })
          : '',
      ];
  return [snapshot.cwd, ids.filter(Boolean).join(' · ')]
    .filter(Boolean)
    .join('\n');
}
