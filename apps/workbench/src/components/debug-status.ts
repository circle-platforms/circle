/** Idle and a finished session both read as not debugging. */
export function debugStatusValue(
  status: string,
  label: (status: string) => string,
): string {
  if (status === 'idle' || status === 'stopped') return 'not debugging';
  if (status === 'running' || status === 'stopping' || status === 'failed')
    return status;
  return label(status);
}
