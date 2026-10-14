// Which build of the application this is. A release is Circle. A beta is what a development
// checkout packages with `npm run package:beta` to run beside a release: Circle (beta), with a
// bundle id and a data folder of its own, so that the two do not share settings, sessions or
// notifications, and without updates, which would put the release in its place.
export interface Channel {
  beta: boolean;
  /** The name the system shows: the bundle, the menu bar, the application list. */
  name: string;
  /** The macOS bundle id and the Windows application user model id. */
  id: string;
  /** The data folder's name in the system's application data folder. */
  folder: string;
}
export const RELEASE: Channel = {
  beta: false,
  name: 'Circle',
  id: 'com.qingshanfeihu.circle',
  folder: 'Circle',
};
export const BETA: Channel = {
  beta: true,
  name: 'Circle (beta)',
  id: 'com.qingshanfeihu.circle.beta',
  folder: 'Circle (beta)',
};
/** The channel the packaged package.json names; any other or none is a release. */
export function channelOf(manifest: unknown): Channel {
  return manifest !== null &&
    typeof manifest === 'object' &&
    (manifest as { channel?: unknown }).channel === 'beta'
    ? BETA
    : RELEASE;
}
