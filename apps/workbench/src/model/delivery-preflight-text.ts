import { t } from '../i18n';
/** Only exact, side-effect-free native preflight messages are interface text. */
export function deliveryPreflightText(error: string): string {
  const message = error.replace(/^(?:Error|DeliveryPreflightError): /, '');
  switch (message) {
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
