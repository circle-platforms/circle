// The CLI and the desktop's independent runtime process must both install network
// settings before constructing a catalog, SDK, probe or tool. No project may add trust.
import { loadSettings } from './settings.js';
import {
  configureNetwork,
  currentNetworkStatus,
  networkProblem,
  toolTrustBundle,
  type NetworkStatus,
} from './net.js';

export function initializeNetwork(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): NetworkStatus {
  let files: string[] = [];
  let settingsProblem: string | undefined;
  try {
    files = loadSettings(home).trust_cert_files;
  } catch (error) {
    settingsProblem = `settings.json could not be read; trust_cert_files ignored: ${error instanceof Error ? error.message : String(error)}`;
  }
  const setup = configureNetwork(env, files);
  if (settingsProblem) networkProblem(settingsProblem);
  try {
    toolTrustBundle(env, files, home);
  } catch (error) {
    networkProblem(
      `the tool trust bundle could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (setup.proxy) env.NODE_USE_ENV_PROXY = '1';
  return currentNetworkStatus();
}
