import { desktopHost } from '../host';
import { t } from '../i18n';
import { Button, CopyButton, DeviceCode } from './common';

export interface HubSignInInfo {
  url: string;
  code?: string;
}

export function HubSignInGuidance({
  signIn,
  statusClassName,
  statusRole,
  hint,
}: {
  signIn: HubSignInInfo;
  statusClassName?: string;
  statusRole?: 'status';
  hint?: string;
}) {
  return (
    <>
      <p className={statusClassName} role={statusRole}>
        {t('sign in on the Hub’s page with your Hub user name and password')}
      </p>
      {hint && <p className="muted small">{hint}</p>}
      {signIn.code && (
        <DeviceCode
          prompt={t('then enter this code there')}
          code={signIn.code}
        />
      )}
    </>
  );
}

export function HubSignInButtons({
  signIn,
  onOpenError,
}: {
  signIn: HubSignInInfo;
  onOpenError: (message: string) => void;
}) {
  const https = signIn.url.startsWith('https://');
  return (
    <>
      <Button
        className="primary"
        type="button"
        disabled={!https || !desktopHost()?.openExternal}
        onClick={async () => {
          onOpenError('');
          try {
            await desktopHost()?.openExternal?.(signIn.url);
          } catch (reason) {
            onOpenError(String(reason));
          }
        }}
      >
        {t('open the Hub’s page')}
      </Button>
      <CopyButton text={signIn.url} label={t('copy link')} />
    </>
  );
}
