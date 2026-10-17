import { t } from '../i18n';
/** Only exact host-authored delivery messages are interface text; provider diagnostics remain unchanged. */
export function deliveryPreflightText(error: string): string {
  const message = error.replace(
    /^(?:Error|DeliveryPreflightError|DeliveryConfirmationPendingError): /,
    '',
  );
  switch (message) {
    case 'publication was sent, but GitHub has not confirmed the reviewed commit; refresh PR checks before retrying and do not repeat the push':
      return t(
        'publication was sent, but GitHub has not confirmed the reviewed commit; refresh PR checks before retrying and do not repeat the push',
      );
    case 'GitHub candidate changed or the revision is not the inspected opaque revision; read github_candidate and review its current head, revision and paths before publishing; nothing was pushed':
      // The host's words name a tool for the model; people get the plain version.
      return t(
        'the branch changed after it was reviewed; refresh and review it again before publishing; nothing was pushed',
      );
    case 'GitHub connection is disconnected or expired':
      return t(
        'connect or reconnect GitHub in its plugin details before checking or publishing',
      );

    case 'commit remaining workspace changes or move them to another branch, then refresh before publishing; nothing was pushed':
      return t(
        'commit remaining workspace changes or move them to another branch, then refresh before publishing; nothing was pushed',
      );
    case 'repository changed; refresh and review the current changes before publishing; nothing was pushed':
      return t(
        'repository changed; refresh and review the current changes before publishing; nothing was pushed',
      );
    case 'switch to a feature branch before publishing; nothing was pushed':
      return t(
        'switch to a feature branch before publishing; nothing was pushed',
      );
    default:
      return error;
  }
}
