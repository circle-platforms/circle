// Which Circle this process is. The about page reads VERSION from the
// sources. A packaged application also writes that version into its
// package.json (or CIRCLE_DESKTOP_VERSION, in the update check). The
// workspace package is 0.1.0, which is not Circle: offering an update to
// the version already shown would come from comparing against it.
import { validVersion, VERSION } from '../../../src/version.js';

export function circleAppVersion(
  packaged: boolean,
  appVersion: string,
): string {
  return packaged && validVersion(appVersion) ? appVersion : VERSION;
}
